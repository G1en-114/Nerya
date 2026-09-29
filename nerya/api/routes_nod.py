"""Camera nod-intent capture for the approval card; intent only, never authority."""
from ..security.nod_intent import (
    NodIntentError,
    NodIntentService,
    close_session,
    open_session,
)
from . import routes_approvals


def _session(client, payload):
    """Camera-scoped warm model worker: open on camera start, close on stop."""
    actor = payload.get("_auth_actor_id")
    if not actor:
        return {"ok": False, "error": "trusted_actor_required", "_status": 403}
    action = str(payload.get("action") or "").strip()
    try:
        if action == "open":
            return open_session(actor)
        if action == "close":
            return close_session(actor)
    except NodIntentError as exc:
        return {"ok": False, "error": str(exc), "_status": 409}
    return {"ok": False, "error": "unknown_action", "_status": 400}


def _capture(client, payload):
    actor = payload.get("_auth_actor_id")
    if not actor:
        return {"ok": False, "error": "trusted_actor_required", "_status": 403}
    approval_id = payload.get("approval_id")
    approval_id = str(approval_id or "")
    record = routes_approvals._find_record(client, approval_id)
    if record is None and approval_id == "demo-nod-approval":
        record = {"approval_id": approval_id, "kind": "trade_intent", "market": "mock:BTC/USDT",
                  "amount": 100, "action": "trade_intent", "state": "pending"}
    if record is None:
        return {"ok": False, "error": "approval_not_found", "_status": 404}
    if str(record.get("state") or "") != "pending":
        return {"ok": False, "error": "approval_not_pending", "_status": 409}
    try:
        return NodIntentService(client.config).capture(
            actor, str(approval_id), record, payload.get("frames")
        )
    except NodIntentError as exc:
        body = {"ok": False, "error": str(exc), "_status": 409}
        detail = getattr(exc, "detail", None)
        if isinstance(detail, dict):
            body["detail"] = detail
        return body


def routes():
    return [
        ("POST", "/security/nod/session", _session),
        ("POST", "/security/nod/intent", _capture),
    ]
