"""Recover only canonical, session-bound planning snapshots; never authority."""
from __future__ import annotations
import json
from ..tools.native.task import normalise_task_snapshot, TodoItem


def _snapshot(value, session_id):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            return None
    if not isinstance(value, dict):
        return None
    item = normalise_task_snapshot(value)
    if item and item["source"].get("session_id") == session_id:
        return item
    for key in ("task_state", "result", "data", "json", "content"):
        child = value.get(key)
        if isinstance(child, list):
            for part in reversed(child):
                item = _snapshot(part, session_id)
                if item is not None:
                    return item
        elif isinstance(child, (dict, str)):
            item = _snapshot(child, session_id)
            if item is not None:
                return item
    return None


def session_task_snapshot(repo, session_id, *, checkpoint=None, live=None, transcript=(), tool_results=()):
    candidates = []
    if live is not None:
        item = _snapshot(live.snapshot_for_checkpoint(), session_id)
        if item is not None:
            candidates.append(item)
    item = _snapshot(checkpoint or {}, session_id)
    if item is not None:
        candidates.append(item)
    for result in tool_results or ():
        if not isinstance(result, dict) or result.get("name") != "todo_write" or result.get("is_error") or result.get("error"):
            continue
        item = _snapshot(result, session_id)
        if item is not None:
            candidates.append(item)
    for message in transcript or ():
        if not isinstance(message, dict):
            continue
        if message.get("kind") == "transcript.compact.todos":
            item = _snapshot(message.get("meta", {}), session_id)
            if item is not None:
                candidates.append(item)
    row = repo.con.execute(
        "SELECT payload_json FROM agent_tool_events WHERE session_id=? AND tool='native.todo_write' "
        "AND phase='tool_result' AND ok=1 ORDER BY ts DESC,rowid DESC LIMIT 1", (session_id,),
    ).fetchone()
    item = _snapshot(json.loads(row[0]) if row else {}, session_id)
    if item is not None:
        candidates.append(item)
    return max(candidates, key=lambda item: item.get("updated_at") or 0) if candidates else None


def restore_task_state(state, snapshot):
    if snapshot is not None:
        state.set_todos([TodoItem(**item) for item in snapshot["todos"]], source=snapshot["source"])
