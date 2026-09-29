"""Authenticated operator image review; no OCR, model or execution side effects."""
from ..evidence.visual import VisualError, VisualStore
from .routes_evidence import _gated


def _handler(operation):
    def handle(client, body):
        gate = _gated(client)
        if gate is not None:
            return gate
        store = VisualStore(client.config)
        try:
            if operation == "list":
                return {"ok": True, "artifacts": store.list()}
            if operation == "get":
                return {"ok": True, "artifact": store.get(body.get("artifact_id"))}
            if operation == "image":
                from .local_server import BinaryResponse
                data, mime = store.image(body.get("artifact_id"))
                return BinaryResponse(body=data, content_type=mime,
                    headers={"X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'"})
            actor = body.get("_auth_actor_id")
            if not actor:
                raise VisualError("trusted_actor_required", 403)
            if operation == "upload":
                doc = store.upload(body, actor)
            elif operation == "field":
                doc = store.revise_field(body.get("artifact_id"), body, actor)
            else:
                doc = store.cite(body.get("artifact_id"), body, actor)
            return {"ok": True, "artifact": doc}
        except VisualError as exc:
            return {"ok": False, "error": str(exc), "_status": exc.status}
    return handle


def routes():
    return [("GET", f"/evidence/visual/{op}", _handler(op)) for op in ("list", "get", "image")] + [
        ("POST", f"/evidence/visual/{op}", _handler(op)) for op in ("upload", "field", "cite")]
