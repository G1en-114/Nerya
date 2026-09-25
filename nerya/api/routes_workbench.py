"""Workbench read-only capabilities and projection routes."""
from __future__ import annotations

import hashlib
import time
from pathlib import Path

from ..agent.command_store import CommandError
from ..agent.history_mutations import HistoryMutationError
from ..agent.workbench import session_view

_STARTED = time.time()
_ROOT = Path(__file__).resolve().parents[1]
# Capture code identity once, never claim that on-disk edits changed a live process.
_BUILD = hashlib.sha256(b"".join(p.read_bytes() for p in sorted(_ROOT.rglob("*.py")))).hexdigest()[:16]


def runtime_info(client, _query):
    return {"ok": True, "protocol_version": 1, "build_id": _BUILD, "started_at": _STARTED,
            "workspace_id": hashlib.sha256(str(client.config.paths.root.resolve()).encode()).hexdigest()[:24],
            "capabilities": ["conversation_commands", "session_view", "evidence_delivery", "user_interactions", "plan_mode"]}


def view(client, query):
    try:
        return session_view(client.config, query.get("session_id"))
    except HistoryMutationError as exc:
        return {"ok":False,"_status":400,"error":exc.code}
    except CommandError as exc:
        return {"ok": False, "_status": exc.status, "error": exc.code}


def routes():
    return [("GET", "/runtime/info", runtime_info), ("GET", "/agent/sessions/view", view)]
