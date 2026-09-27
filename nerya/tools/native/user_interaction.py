"""Questions and plan records are control-plane records, never execution grants."""
from ..types import ToolResult, ToolError, ToolErrorKind
from ...agent.interactions import create_interaction
from ...agent.command_store import CommandError

QUESTION_SCHEMA = {"type":"object", "properties":{
    "title":{"type":"string"}, "message":{"type":"string"},
    "questions": {"type": "array", "minItems": 1, "maxItems": 12, "items": {
        "type": "object", "properties": {
            "id": {"type": "string"}, "question": {"type": "string"},
            "options": {"type": "array", "items": {"type": "string"}},
            "multiple": {"type": "boolean"}}, "required": ["id", "question"]}},
    },"required":["title", "questions"]}
PLAN_SCHEMA = {"type":"object", "properties":{
    "title":{"type":"string"}, "message":{"type":"string"},
    **{key:{"type":"array","items":{"type":"string"}} for key in ("steps","deliverables","constraints")}},"required":["title","steps"]}


def interaction_handler(call, *, deps, kind):
    try:
        if call.metadata.get("agent_id") or call.metadata.get("agent_parent_session_id"):
            raise CommandError("interaction_requires_lead",400)
        from ...db.sqlite import connect
        con=connect(deps.config.paths.db)
        try:
            owned=con.execute("SELECT 1 FROM agent_commands WHERE session_id=? AND turn_id=? AND state='running'",(deps.active_session_id,call.turn_id)).fetchone()
        finally:
            con.close()
        if not owned:
            raise CommandError("interaction_requires_durable_command",400)
        item=create_interaction(deps.config,sid=deps.active_session_id,tid=call.turn_id,
                                call_id=call.id,kind=kind,payload=call.arguments)
        return ToolResult.from_json(tool_use_id=call.id,name=call.name,data=item,
                                    result_protocol="user_interaction_pending")
    except (CommandError,ValueError) as exc:
        return ToolResult.from_error(tool_use_id=call.id,name=call.name,
            error=ToolError(kind=ToolErrorKind.SCHEMA_VALIDATION,message=str(exc)))
