"""Factor library routes use the exact same Skill helpers as the Agent."""
from __future__ import annotations

from ..skills.builtin.factor_library.scripts.library import operation


def _handler(action):
    def handle(client, payload):
        try:
            body = dict(payload or {})
            body.pop("action", None)  # Route identity, never user input, owns the operation.
            if "version" in body and isinstance(body["version"], str):
                body["version"] = int(body["version"])
            return operation(client.config, {**body, "action": action})
        except Exception as exc:
            return {"ok": False, "error": type(exc).__name__, "message": str(exc)}
    return handle


def routes():
    return [("GET" if name in {"list", "get", "data", "export"} else "POST", f"/factors/{name}", _handler(name))
            for name in ("list", "get", "data", "export", "backtest", "extract", "save", "evaluate")]
