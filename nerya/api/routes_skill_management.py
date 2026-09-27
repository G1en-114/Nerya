"""Scoped Skill catalog and direct management shared with MCP and CLI."""
from ..skills import management
from ..mcp.catalog import public_result


def _handler(fn, *, reload_skills=False):
    def handle(client, payload):
        try:
            # HTTP query values are strings; preserve the same bounded public contract.
            args = dict(payload or {})
            for key in ("offset", "limit"):
                if key in args:
                    args[key] = int(args[key])
            if "hierarchical" in args:
                args["hierarchical"] = str(args["hierarchical"]).lower() == "true"
            if "include_unassigned" in args:
                args["include_unassigned"] = str(args["include_unassigned"]).lower() == "true"
            result = fn(client.config, **args)
            if reload_skills and result.get("applied"):
                client.skills.reload()
            return public_result(result)
        except (ValueError, TypeError, OSError) as exc:
            return {"ok": False, "error": public_result(str(exc)), "_status": 400}
    return handle


def routes():
    return [("GET", "/skills/catalog", _handler(management.catalog)),
            ("GET", "/skills/read", _handler(management.read)),
            ("POST", "/skills/manage", _handler(management.manage, reload_skills=True))]
