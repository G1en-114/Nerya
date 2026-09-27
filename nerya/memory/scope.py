"""Memory domains derived from server-owned execution envelopes, never tool args."""
from __future__ import annotations

from typing import Any


def memory_actor(actor: str) -> str:
    """The local owner and local scheduled runs share the historical owner domain."""
    value = str(actor or "default").strip() or "default"
    return "default" if value in {"local:loopback", "local:anonymous", "admin:password"} else value


def workflow_for_trigger(trigger: dict[str, Any], *, strategy_id: str = "") -> str:
    source = str(trigger.get("source") or "")
    kind = str(trigger.get("kind") or "")
    if strategy_id and source == "strategy" and kind == "strategy.agent_task":
        return "execution"
    if strategy_id and kind == "strategy.tuning" and source in {"strategy", "schedule"}:
        return "evolution"
    if source == "scheduled_session":
        payload = trigger.get("payload")
        schedule_id = str(payload.get("schedule_id") or "") if isinstance(payload, dict) else ""
        if schedule_id:
            from .runtime import MemoryRuntime
            return MemoryRuntime._clean_id(schedule_id, "schedule_id")
    return ""


def bind_session_context(config, *, session_id: str, actor_id: str, strategy_id: str, workflow_id: str) -> str:
    """Keep a workflow binding on resumed chats; reject rebinding before recall."""
    if not session_id:
        return workflow_id
    from ..db.sqlite import connect
    from .store import MemoryScopeError
    con = connect(config.paths.db)
    try:
        con.execute("BEGIN IMMEDIATE")
        row = con.execute("SELECT * FROM memory_session_context WHERE session_id=?", (session_id,)).fetchone()
        if row:
            if row["actor_id"] != actor_id or row["strategy_id"] != strategy_id or (workflow_id and row["workflow_id"] != workflow_id):
                raise MemoryScopeError("session memory context cannot be rebound")
            workflow_id = str(row["workflow_id"])
        else:
            con.execute("INSERT INTO memory_session_context VALUES (?, ?, ?, ?)",
                        (session_id, actor_id, strategy_id, workflow_id))
        con.commit()
        return workflow_id
    except BaseException:
        con.rollback()
        raise
    finally:
        con.close()
