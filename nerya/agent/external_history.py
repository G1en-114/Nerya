"""Read complete external calls and operator messages from canonical history.

One assistant row owns the whole call (including native mirrors/children).
Pagination must never group by turn_id or expand nodes into separate units.
The caller supplies a connection to its authorized workspace database; every
lookup, including cursor, anchor and refresh lookup, is scoped to that session.
"""
from __future__ import annotations

import base64
import binascii
import json
import math
import time
from typing import Any

from .session import db_session_asdict

DEFAULT_LIMIT = 60
MAX_LIMIT = 200
MAX_REFRESH_CALLS = 60


class ExternalHistoryError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


# Only small ordering columns leave SQLite until a page has been selected. The
# existing session index bounds the scan; no persistent index/table is created.
_UNITS = """WITH source_rows AS (
    SELECT message_id, role, ts,
        CASE WHEN json_valid(meta_json) THEN meta_json ELSE '{}' END AS meta
    FROM agent_messages WHERE session_id=? AND deleted=0
), units AS (
    SELECT message_id, ts,
        CASE WHEN role='assistant' THEN json_extract(meta,'$.turn.external_call.call_id')
             ELSE message_id END AS unit_id,
        CASE WHEN role='assistant' THEN json_extract(meta,'$.turn.external_call.sequence')
             ELSE json_extract(meta,'$.external_request.sequence') END AS raw_sequence
    FROM source_rows WHERE role='user' OR (role='assistant'
        AND json_type(meta,'$.turn.external_call.call_id')='text'
        AND json_extract(meta,'$.turn.external_call.call_id')!='')
), ordered AS (
    SELECT message_id, ts, unit_id,
        CASE WHEN typeof(raw_sequence)='integer' AND raw_sequence>0
             THEN raw_sequence ELSE 0 END AS sequence FROM units
) """
_KEY = "(sequence, ts, unit_id)"


def _key(row) -> tuple[int, float, str]:
    return row["sequence"], row["ts"], row["unit_id"]


def _cursor(row, scope: list[Any]) -> str | None:
    if row is None:
        return None
    raw = json.dumps([1, *scope, list(_key(row))], separators=(",", ":"), ensure_ascii=False)
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _decode_cursor(value: Any, scope: list[Any]) -> tuple[int, float, str]:
    try:
        if not isinstance(value, str) or not 1 <= len(value) <= 2048:
            raise ValueError
        raw = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
        data = json.loads(raw)
        if not isinstance(data, list) or len(data) != 6 or data[0] != 1:
            raise ValueError
        if data[1:3] != scope[:2]:
            raise ExternalHistoryError("external_cursor_session_mismatch")
        if data[3:5] != scope[2:]:
            raise ExternalHistoryError("external_history_changed")
        key = data[5]
        if (not isinstance(key, list) or len(key) != 3
                or type(key[0]) is not int or key[0] < 0
                or type(key[1]) not in (float, int) or not math.isfinite(key[1])
                or not isinstance(key[2], str) or not 1 <= len(key[2]) <= 512):
            raise ValueError
        return tuple(key)
    except ExternalHistoryError:
        raise
    except (ValueError, TypeError, UnicodeError, binascii.Error):
        raise ExternalHistoryError("invalid_external_cursor") from None


def _bounded_limit(value: Any) -> int:
    if value is None:
        return DEFAULT_LIMIT
    if isinstance(value, bool) or len(str(value)) > 3 or not str(value).isascii() or not str(value).isdigit():
        raise ExternalHistoryError("invalid_external_limit")
    limit = int(value)
    if not 1 <= limit <= MAX_LIMIT:
        raise ExternalHistoryError("invalid_external_limit")
    return limit


def _message(con, sid: str, unit) -> dict[str, Any]:
    row = con.execute("SELECT * FROM agent_messages WHERE session_id=? AND message_id=? AND deleted=0",
                      (sid, unit["message_id"])).fetchone()
    try:
        meta = json.loads(row["meta_json"])
    except (ValueError, TypeError):
        meta = {}
    if not isinstance(meta, dict):
        meta = {}
    return {"message_id": row["message_id"], "role": row["role"],
            "content": row["content"], "turn_id": row["turn_id"], "ts": row["ts"],
            "turn": meta.pop("turn", None), "meta": meta,
            "history_key": list(_key(unit))}


def external_transcript_page(con, sid: str, query: dict[str, Any]) -> dict[str, Any]:
    """Return one bounded page, oldest first, plus explicit call refreshes.

    before/after are exclusive. anchor_call_id/anchor_message_id include the
    anchor as the last unit; next_after_cursor traverses the gap to the tail.
    refresh_call_ids returns complete snapshots separately from the page and
    does not move its cursors. full/all compatibility is handled by the route.
    """
    read_at = time.time()
    con.execute("BEGIN")
    try:
        return _read_page(con, sid, query, read_at)
    except ExternalHistoryError as exc:
        return {"ok": False, "session_id": sid, "error": exc.code, "code": exc.code,
                "messages": [], "count": 0, "has_more": False,
                "next_before_cursor": None,
                "reset_required": exc.code in {"external_history_changed", "external_cursor_not_found"}}
    finally:
        con.execute("ROLLBACK")


def _read_page(con, sid: str, query: dict[str, Any], read_at: float) -> dict[str, Any]:
    if con.execute("SELECT 1 FROM agent_deleted_sessions WHERE session_id=?", (sid,)).fetchone():
        raise ExternalHistoryError("session_deleted")
    session = con.execute("SELECT * FROM agent_sessions WHERE session_id=?", (sid,)).fetchone()
    if session is None or session["source"] not in {"mcp", "tunnel"}:
        raise ExternalHistoryError("external_session_not_found")
    limit = _bounded_limit(query.get("limit"))
    revision = con.execute("SELECT COALESCE(MAX(id),0) FROM agent_message_revisions WHERE session_id=?",
                           (sid,)).fetchone()[0]
    scope = [sid, session["source"], session["created_at"], revision]
    before, after = query.get("before"), query.get("after")
    call_anchor, message_anchor = query.get("anchor_call_id"), query.get("anchor_message_id")
    if sum(value is not None for value in (before, after, call_anchor, message_anchor)) > 1:
        raise ExternalHistoryError("external_pagination_conflict")
    where, params, ascending = "", [], after is not None
    anchor = None
    if before is not None or after is not None:
        key = _decode_cursor(before if before is not None else after, scope)
        if not con.execute(_UNITS + f"SELECT 1 FROM ordered WHERE {_KEY}=(?,?,?) LIMIT 1", (sid, *key)).fetchone():
            raise ExternalHistoryError("external_cursor_not_found")
        where, params = f"WHERE {_KEY} {'>' if ascending else '<'} (?,?,?)", list(key)
    elif call_anchor is not None or message_anchor is not None:
        value = call_anchor if call_anchor is not None else message_anchor
        if not isinstance(value, str) or not 1 <= len(value) <= 512:
            raise ExternalHistoryError("invalid_external_anchor")
        column = "unit_id" if call_anchor is not None else "message_id"
        anchor = con.execute(_UNITS + f"SELECT * FROM ordered WHERE {column}=? LIMIT 1", (sid, value)).fetchone()
        if anchor is None:
            raise ExternalHistoryError("external_anchor_not_found")
        where, params = f"WHERE {_KEY} <= (?,?,?)", list(_key(anchor))
    direction = "ASC" if ascending else "DESC"
    units = con.execute(_UNITS + f"SELECT * FROM ordered {where} ORDER BY sequence {direction}, ts {direction}, unit_id {direction} LIMIT ?",
                        (sid, *params, limit)).fetchall()
    if not ascending:
        units.reverse()
    has_more = bool(units and con.execute(_UNITS + f"SELECT 1 FROM ordered WHERE {_KEY} < (?,?,?) LIMIT 1",
                                         (sid, *_key(units[0]))).fetchone())
    has_newer = bool(units and con.execute(_UNITS + f"SELECT 1 FROM ordered WHERE {_KEY} > (?,?,?) LIMIT 1",
                                          (sid, *_key(units[-1]))).fetchone())
    refresh_ids = query.get("refresh_call_ids", [])
    if isinstance(refresh_ids, str):
        refresh_ids = refresh_ids.split(",") if refresh_ids else []
    if (not isinstance(refresh_ids, list) or len(refresh_ids) > MAX_REFRESH_CALLS
            or any(not isinstance(v, str) or not 1 <= len(v) <= 512 for v in refresh_ids)):
        raise ExternalHistoryError("invalid_external_refresh")
    refreshed, missing = [], []
    for call_id in dict.fromkeys(refresh_ids):
        # Canonical call rows are persisted by InboundSessions.persist. This
        # primary-key lookup never scans nodes or another session's payload.
        unit = con.execute(_UNITS + "SELECT * FROM ordered WHERE message_id=? AND unit_id=? LIMIT 1",
                           (sid, call_id + ":assistant", call_id)).fetchone()
        if unit is None:
            missing.append(call_id)
        else:
            refreshed.append(_message(con, sid, unit))
    state = db_session_asdict(dict(session))
    meta = state["meta"]
    return {"ok": True, "session_id": sid, "source": state["source"],
            "strategy_id": state["strategy_id"], "title": meta.get("title", ""),
            "strategy_proposal_id": meta.get("strategy_proposal_id"),
            "created_at": state["created_at"], "updated_at": state["updated_at"],
            "messages": [_message(con, sid, unit) for unit in units], "count": len(units),
            "pagination": "external_calls_v1", "limit": limit,
            "has_more": has_more, "next_before_cursor": _cursor(units[0], scope) if has_more else None,
            # Retain the high edge even at the tail: polling after it cannot
            # skip calls when more than one page arrives between two polls.
            "has_newer": has_newer, "next_after_cursor": _cursor(units[-1], scope) if units else after,
            "anchor_message_id": anchor["message_id"] if anchor else None,
            "refreshed_messages": refreshed, "missing_call_ids": missing,
            "history_revision": revision, "read_at": read_at}
