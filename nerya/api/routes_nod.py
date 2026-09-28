"""Camera nod-intent capture for the approval card; intent only, never authority."""
from ..security.nod_intent import NodIntentError, NodIntentService
from . import routes_approvals


def _capture(client, payload):
    actor = payload.get("_auth_actor_id")
    if not actor:
        return {"ok": False, "error": "trusted_actor_required", "_status": 403}
    approval_id = payload.get("approval_id")
    record = routes_approvals._find_record(client, str(approval_id or ""))
    if record is None:
        return {"ok": False, "error": "approval_not_found", "_status": 404}
    if str(record.get("state") or "") != "pending":
        return {"ok": False, "error": "approval_not_pending", "_status": 409}
    try:
        return NodIntentService(client.config).capture(
            actor, str(approval_id), record, payload.get("frames")
        )
    except NodIntentError as exc:
        return {"ok": False, "error": str(exc), "_status": 409}


def routes():
    return [("POST", "/security/nod/intent", _capture)]
