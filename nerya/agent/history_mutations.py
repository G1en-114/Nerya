"""Operator history changes, separate from execution and immutable audit journals.

A successful response means the canonical database commit completed. Never
replay tools or undo financial actions as a side effect of editing history.
"""
from __future__ import annotations

from contextlib import contextmanager
import time
from typing import Any

from ..db.repositories import AgentSessionRepository
from ..db.sqlite import connect
from .session import SessionStore

MAX_MESSAGE_CHARS = 16_000


class HistoryMutationError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def deleted_session_ids(con) -> set[str]:
    return {str(row[0]) for row in con.execute("SELECT session_id FROM agent_deleted_sessions")}


def is_session_deleted(con, session_id: str) -> bool:
    return con.execute("SELECT 1 FROM agent_deleted_sessions WHERE session_id=?", (session_id,)).fetchone() is not None


def has_message_history(con, session_id: str) -> bool:
    # Deleted rows are meaningful: empty canonical history must not revive journals.
    return con.execute("SELECT 1 FROM agent_messages WHERE session_id=? LIMIT 1", (session_id,)).fetchone() is not None


def _session_id(value: Any) -> str:
    if isinstance(value, str):
        value = value.strip()
    if not isinstance(value, str) or not value.strip() or len(value) > 256 or any(c in value for c in ("/", "\\", "\x00")) or value in {".", ".."}:
        raise HistoryMutationError("invalid_session_id")
    return value.strip()


@contextmanager
def _transaction(paths):
    con = connect(paths.db)
    try:
        con.execute("BEGIN IMMEDIATE")
        yield con
        con.execute("COMMIT")
    except BaseException:
        if con.in_transaction:
            con.execute("ROLLBACK")
        raise
    finally:
        con.close()


def _assert_idle(con, sid: str) -> None:
    if con.execute("SELECT 1 FROM agent_interactions WHERE session_id=? AND state IN ('pending','deferred','answered')",(sid,)).fetchone():
        raise HistoryMutationError("history_busy")
    if con.execute("SELECT 1 FROM agent_commands WHERE session_id=? AND state IN ('queued','running','stopping','delivering','delivered','unconfirmed') LIMIT 1", (sid,)).fetchone():
        raise HistoryMutationError("history_busy")
    checkpoint = con.execute("SELECT turn_id,claim_id FROM agent_turn_checkpoints WHERE session_id=?",(sid,)).fetchone()
    if checkpoint:
        # A completed command may retain a continuation snapshot. Explicit
        # history edits invalidate that snapshot, not the executed actions.
        # Paused, legacy-unconfirmed and owned checkpoints remain protected.
        completed = con.execute("SELECT state FROM agent_commands WHERE session_id=? AND turn_id=? AND kind!='guide' ORDER BY created_at DESC LIMIT 1",(sid,checkpoint["turn_id"])).fetchone()
        if checkpoint["claim_id"] or not completed or completed[0] != "succeeded":
            raise HistoryMutationError("history_busy")


def mutate_message(paths, payload: dict, *, delete: bool = False) -> dict:
    sid = _session_id(payload.get("session_id"))
    mid = payload.get("message_id")
    content = payload.get("content")
    if not isinstance(mid, str) or not mid:
        raise HistoryMutationError("invalid_message_id")
    if not delete and (not isinstance(content, str) or not content.strip()):
        raise HistoryMutationError("content_required")
    if not delete and len(content) > MAX_MESSAGE_CHARS:
        raise HistoryMutationError("content_too_long")
    with _transaction(paths) as con:
        if is_session_deleted(con, sid):
            raise HistoryMutationError("session_deleted")
        _assert_idle(con, sid)
        row = con.execute("SELECT role, content, deleted FROM agent_messages WHERE session_id=? AND message_id=?", (sid, mid)).fetchone()
        if row is None:
            raise HistoryMutationError("message_not_found")
        if row["role"] != "user":
            raise HistoryMutationError("message_read_only")
        if row["deleted"]:
            if delete:
                return {"ok": True, "session_id": sid, "message_id": mid, "deleted": True}
            raise HistoryMutationError("message_not_found")
        if not delete and row["content"] == content:
            return {"ok": True, "session_id": sid, "message_id": mid, "content": content, "unchanged": True}
        if "expected_content" in payload and payload["expected_content"] != row["content"]:
            raise HistoryMutationError("message_conflict")
        repo = AgentSessionRepository(con)
        now = time.time()
        con.execute("INSERT INTO agent_message_revisions(session_id,message_id,content,captured_at,operation) VALUES (?,?,?,?,?)",
                    (sid,mid,row["content"],now,"delete" if delete else "edit"))
        # _assert_idle and this mutation share BEGIN IMMEDIATE, so a concurrent
        # resume cannot claim the snapshot between the check and invalidation.
        con.execute("DELETE FROM agent_turn_checkpoints WHERE session_id=?",(sid,))
        if delete:
            repo.delete_session_message(session_id=sid, message_id=mid, ts=now)
        else:
            repo.update_message_content(session_id=sid, message_id=mid, content=content, ts=now)
    return {"ok": True, "session_id": sid, "message_id": mid, "updated_at": now,
            **({"deleted": True} if delete else {"content": content, "edited_at": now})}


def delete_session(paths, payload: dict) -> dict:
    sid = _session_id(payload.get("session_id"))
    with _transaction(paths) as con:
        if is_session_deleted(con, sid):
            return {"ok": True, "session_id": sid, "deleted": True}
        _assert_idle(con, sid)
        # Atomic across the conversation tables. Strategy/order/approval/audit
        # records are deliberately not removed by a chat-history action.
        for table in ("agent_messages", "agent_tool_events", "agent_turn_checkpoints", "agent_sessions"):
            con.execute(f"DELETE FROM {table} WHERE session_id=?", (sid,))
        con.execute("INSERT INTO agent_deleted_sessions(session_id, deleted_at) VALUES (?, ?)", (sid, time.time()))
    # The committed tombstone is authoritative even if optional file cleanup
    # fails. All history read paths consult it, including legacy file sessions.
    store = SessionStore(paths.root)
    cleanup_pending = False
    try:
        if store.load(sid) is not None:
            cleanup_pending = not store.delete(sid)
    except OSError:
        cleanup_pending = True
    return {"ok": True, "session_id": sid, "deleted": True, "cleanup_pending": cleanup_pending}


def rename_session(paths, payload: dict) -> dict:
    sid = _session_id(payload.get("session_id"))
    title = payload.get("title")
    if not isinstance(title, str) or not title.strip():
        raise HistoryMutationError("title_required")
    title = " ".join(title.split())
    if len(title) > 80:
        raise HistoryMutationError("title_too_long")
    with _transaction(paths) as con:
        if is_session_deleted(con, sid):
            raise HistoryMutationError("session_deleted")
        repo = AgentSessionRepository(con)
        row = repo.get_session(sid)
        state = SessionStore(paths.root).load(sid)
        if not row and not state:
            raise HistoryMutationError("session_not_found")
        repo.upsert_session(session_id=sid, strategy_id=row.get("strategy_id") if row else state.strategy_id,
                            title=title, meta={"title": title, "title_source": "operator"})
    return {"ok": True, "session_id": sid, "title": title}


def history_response(action, paths, payload: Any) -> dict:
    try:
        return action(paths, payload if isinstance(payload, dict) else {})
    except HistoryMutationError as exc:
        return {"ok": False, "error": exc.code, "code": exc.code}
    except Exception:
        # Do not leak SQL, local paths, or backend tracebacks into UI notices.
        return {"ok": False, "error": "history_write_failed", "code": "history_write_failed"}
