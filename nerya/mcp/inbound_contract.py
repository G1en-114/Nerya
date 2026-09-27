"""Transport-only identity and public progress metadata, not business arguments."""
from copy import deepcopy

SESSION_TOOL = "nerya_session"
PROGRESS_TOOL = "nerya_progress"
SESSION_PATTERN = r"^ext_(?:mcp|tunnel)_[0-9a-f]{32}$"
SESSION_INSTRUCTIONS = (
    "Open ONCE per conversation with nerya_session(action='open', "
    "client_request_id='<stable unique conversation key>', title='<user goal>'). "
    "Reuse the SAME key on retries, NOT a per-call key. Copy the returned remote_session_id "
    "into EVERY subsequent tool call. Recover with action='list', query=..., or resume "
    "with the existing ID. Missing/invalid IDs NEVER create sessions or execute tools. "
    "Never share keys/IDs across conversations. Include public activity on calls: "
    "intent (goal, only at a new task), next (this action/method), evidence (observed facts), "
    "conclusion (supported findings), status (blockers), hypothesis (optional, tentative). "
    "These are brief public progress summaries, not private chain-of-thought; never invent evidence. "
    "Use nerya_progress for milestones/final results even without a business tool. "
    "A successful tool is not a completed task. Server turn_id/sequence/call_id are authoritative. "
    "Every result can include operator_control.requests: messages the user added in Nerya. "
    "Read them BEFORE the next action and pass exact IDs as acknowledge_requests on that call. "
    "They repeat until acknowledged; acknowledgement is not task completion. "
    "Resume nerya_session to fetch messages while idle. Use nerya_progress to append your reply "
    "after a tool result; do not execute a dummy tool or invent findings."
)
ACTIVITY_FIELDS = {
    "intent": "Public goal, only at a NEW task, not each call.",
    "hypothesis": "Optional tentative hypothesis, explicitly unverified; no hidden reasoning.",
    "evidence": "New observed facts/results, not assumptions.",
    "conclusion": "Concise conclusion supported by evidence.",
    "next": "Immediate action/method this call will perform.",
    "status": "Public progress/blocker; no repetitive heartbeat.",
}
ACTIVITY_SCHEMA = {"type": "object", "additionalProperties": False,
    "description": "Concise public work updates shown in Nerya like MCPX Activity; no secrets/private reasoning.",
    "properties": {key: {"type": "string", "maxLength": 4000, "description": text}
                   for key, text in ACTIVITY_FIELDS.items()}}
SESSION_PROPERTY = {"type": "string", "pattern": SESSION_PATTERN,
    "description": "REQUIRED: exact ID from nerya_session; reuse for the WHOLE conversation, never open per call."}


def control_descriptors():
    from .operator_messages import ACK_SCHEMA
    return [
        {"name": SESSION_TOOL, "description": SESSION_INSTRUCTIONS,
         "inputSchema": {"type": "object", "additionalProperties": False, "properties": {
             "action": {"type": "string", "enum": ["open", "resume", "list"], "default": "open"},
             "remote_session_id": deepcopy(SESSION_PROPERTY),
             "acknowledge_requests": deepcopy(ACK_SCHEMA),
             "client_request_id": {"type": "string", "minLength": 8, "maxLength": 256,
                 "description": "Required for NEW sessions; stable unique conversation key, reused on retries, NOT per-call."},
             "title": {"type": "string", "maxLength": 120},
             "query": {"type": "string", "maxLength": 256},
             "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 30}}},
         "annotations": {"readOnlyHint": True, "destructiveHint": False}},
        {"name": PROGRESS_TOOL,
         "description": "Publish public progress/results in the EXISTING session, after findings and before finishing. Never open a session for progress.",
         "inputSchema": {"type": "object", "additionalProperties": False, "properties": {
             "remote_session_id": deepcopy(SESSION_PROPERTY), "activity": deepcopy(ACTIVITY_SCHEMA),
             "acknowledge_requests": deepcopy(ACK_SCHEMA),
             "current": {"type": "string", "maxLength": 4000},
             "phase": {"type": "string", "maxLength": 120},
             "result": {"type": "array", "maxItems": 30, "items": {"type": "string", "maxLength": 4000}},
             "next": {"type": "string", "maxLength": 4000},
             "status": {"type": "string", "enum": ["running", "completed", "blocked", "failed"], "default": "running"}},
             "required": ["remote_session_id"]},
         "annotations": {"readOnlyHint": True, "destructiveHint": False}},
    ]
