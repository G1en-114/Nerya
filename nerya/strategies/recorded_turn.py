"""Read a single persisted Agent turn, without migrations or a latest-turn fallback."""
from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from typing import Any

from ..core.paths import WorkspacePaths
from ..core.redaction import redact_display_dict


def recorded_turn(paths: WorkspacePaths, session_id: str, turn_id: str) -> dict[str, Any]:
    result: dict[str, Any] = {"session_id": session_id, "turn_id": turn_id, "messages": [], "events": [], "partial": False}
    if not session_id or not turn_id or not paths.db.is_file():
        return {**result, "partial": True}
    try:
        with closing(sqlite3.connect(paths.db.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)) as con:
            con.row_factory = sqlite3.Row
            rows = con.execute(
                "SELECT message_id, role, substr(content,1,20001) AS content, ts FROM agent_messages "
                "WHERE session_id=? AND turn_id=? AND deleted=0 AND role IN ('user','assistant') "
                "ORDER BY ts, rowid LIMIT 201", (session_id, turn_id),
            ).fetchall()
            result["messages"] = [dict(row) for row in rows[:200]]
            result["partial"] = len(rows) > 200 or any(len(row["content"] or "") > 20000 for row in rows)
            events = con.execute(
                "SELECT event_id, call_id, tool, phase, ok, ts, substr(payload_json,1,65537) AS payload_json "
                "FROM agent_tool_events WHERE session_id=? AND turn_id=? AND phase IN ('tool_use','tool_result') "
                "ORDER BY ts, rowid LIMIT 501", (session_id, turn_id),
            ).fetchall()
            result["partial"] = result["partial"] or len(events) > 500
            for row in events[:500]:
                event = dict(row)
                raw = event.pop("payload_json") or "{}"
                try:
                    if len(raw) > 65536:
                        raise ValueError("oversized")
                    event["payload"] = json.loads(raw)
                except ValueError:
                    event["payload"] = {"truncated": True}
                    result["partial"] = True
                result["events"].append(event)
    except (sqlite3.Error, OSError):
        result["partial"] = True
    return redact_display_dict(result)
