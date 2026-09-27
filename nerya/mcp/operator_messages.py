"""Durable operator messages for an external LLM; no local Agent Loop is started.

Messages use the ordinary transcript table. Delivery is at-least-once until an
explicit acknowledgement, scoped to one existing session, including across restarts.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from typing import Any

from ..db.repositories import AgentSessionRepository
from ..db.sqlite import connect
from .catalog import public_result
from .inbound_contract import SESSION_PATTERN

ACK_SCHEMA = {"type": "array", "maxItems": 16, "uniqueItems": True,
    "items": {"type": "string", "pattern": r"^opmsg_[0-9a-f]{64}$"},
    "description": "Exact operator_control.requests[].id values already read and understood. "
                   "Acknowledge on the next call in this same session; not task completion."}
GUIDANCE = ("These are user messages added in the Nerya conversation. Read them before your next action, "
    "then pass their exact IDs as acknowledge_requests on that call. An acknowledgement means read, "
    "not completed. Do not replay a completed tool to fetch messages: resume nerya_session instead.")


def _session(con, sid: str, source: str | None = None):
    if not isinstance(sid, str) or not re.fullmatch(SESSION_PATTERN, sid):
        raise ValueError("An existing external session_id is required")
    row = AgentSessionRepository(con).get_session(sid)
    if not row or row["source"] not in {"mcp", "tunnel"} or (source and row["source"] != source):
        raise ValueError("External session not found; no message or session was created")
    return row


def _message(row):
    return {"id": row["message_id"], "role": "user", "text": row["content"], "ts": row["ts"],
            "external_request": json.loads(row["meta_json"])["external_request"]}


def append_message(config: Any, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("A message object is required")
    sid, text, key = payload.get("session_id"), payload.get("text"), payload.get("client_request_id")
    if not isinstance(text, str) or not text.strip() or len(text) > 8000:
        raise ValueError("text must contain 1–8000 characters")
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", key):
        raise ValueError("A stable client_request_id is required for safe retries")
    if payload.get("attachments"):
        raise ValueError("External follow-up messages currently accept text only")
    original_hash = hashlib.sha256(text.strip().encode()).hexdigest()
    text = public_result(text.strip())
    con = connect(config.paths.db)
    try:
        con.execute("BEGIN IMMEDIATE")
        row = _session(con, sid)
        mid = "opmsg_" + hashlib.sha256((sid + "\0" + key).encode()).hexdigest()
        previous = con.execute("SELECT * FROM agent_messages WHERE message_id=? AND session_id=?", (mid, sid)).fetchone()
        if previous:
            meta = json.loads(previous["meta_json"])
            if previous["deleted"] or meta.get("request_hash") != original_hash:
                raise ValueError("Message retry conflicts with its original request")
            con.execute("COMMIT")
            return {"ok": True, "session_id": sid, "created": False, "message": _message(previous)}
        pending = con.execute("SELECT COUNT(*) FROM agent_messages WHERE session_id=? AND deleted=0 "
            "AND json_extract(meta_json,'$.external_request.state') IN ('queued','delivered')", (sid,)).fetchone()[0]
        if pending >= 256:
            raise ValueError("Too many unread messages; wait for the external Agent to acknowledge them")
        meta = json.loads(row["meta_json"] or "{}")
        external = meta.setdefault("external", {})
        sequence = int(external.get("sequence", 0)) + 1
        external["sequence"] = sequence
        request = {"id": mid, "sequence": sequence, "state": "queued",
                   "after_call_id": external.get("last_call_id", "")}
        now = time.time()
        repo = AgentSessionRepository(con)
        repo.record_message(message_id=mid, session_id=sid, role="user", content=text,
            turn_id=external.get("turn_id"), ts=now,
            meta={"source": "external_operator", "request_hash": original_hash, "external_request": request})
        repo.update_session_meta(sid, meta, ts=now)
        con.execute("COMMIT")
        return {"ok": True, "session_id": sid, "created": True,
                "message": {"id": mid, "role": "user", "text": text, "ts": now, "external_request": request}}
    finally:
        if con.in_transaction:
            con.execute("ROLLBACK")
        con.close()


def acknowledge(config: Any, sid: str, source: str, ids: list[str]) -> None:
    if not ids:
        return
    con = connect(config.paths.db)
    try:
        con.execute("BEGIN IMMEDIATE")
        _session(con, sid, source)
        rows = []
        for mid in ids:
            row = con.execute("SELECT * FROM agent_messages WHERE session_id=? AND message_id=? AND deleted=0", (sid, mid)).fetchone()
            request = json.loads(row["meta_json"]).get("external_request", {}) if row else {}
            if request.get("state") not in {"delivered", "acknowledged"}:
                raise ValueError("Acknowledgement must reference a delivered message in this session")
            rows.append(row)
        now = time.time()
        for row in rows:
            meta = json.loads(row["meta_json"])
            request = meta["external_request"]
            if request["state"] == "acknowledged":
                continue
            request.update(state="acknowledged", acknowledged_at=now)
            con.execute("UPDATE agent_messages SET meta_json=? WHERE message_id=? AND session_id=?",
                        (json.dumps(meta, ensure_ascii=False), row["message_id"], sid))
        con.execute("UPDATE agent_sessions SET updated_at=? WHERE session_id=?", (now, sid))
        con.execute("COMMIT")
    finally:
        if con.in_transaction:
            con.execute("ROLLBACK")
        con.close()


def pending_messages(config: Any, sid: str, source: str, call_id: str = "") -> dict[str, Any]:
    con = connect(config.paths.db)
    try:
        con.execute("BEGIN IMMEDIATE")
        _session(con, sid, source)
        rows = con.execute("SELECT * FROM agent_messages WHERE session_id=? AND deleted=0 "
            "AND json_extract(meta_json,'$.external_request.state') IN ('queued','delivered') "
            "ORDER BY json_extract(meta_json,'$.external_request.sequence'), ts, message_id LIMIT 17", (sid,)).fetchall()
        requests, changed = [], False
        now = time.time()
        for row in rows[:16]:
            meta = json.loads(row["meta_json"])
            request = meta["external_request"]
            if request["state"] == "queued":
                request.update(state="delivered", delivered_at=now, delivered_with_call_id=call_id)
                con.execute("UPDATE agent_messages SET meta_json=? WHERE message_id=? AND session_id=?",
                            (json.dumps(meta, ensure_ascii=False), row["message_id"], sid))
                changed = True
            requests.append({"id": row["message_id"], "message": row["content"], "created_at": row["ts"],
                             "after_call_id": request.get("after_call_id", ""), "sequence": request["sequence"]})
        if changed:
            con.execute("UPDATE agent_sessions SET updated_at=? WHERE session_id=?", (now, sid))
        con.execute("COMMIT")
        return {"requests": requests, "has_more": len(rows) > 16, "guidance": GUIDANCE}
    finally:
        if con.in_transaction:
            con.execute("ROLLBACK")
        con.close()
