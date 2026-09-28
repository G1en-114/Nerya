"""Authenticated management of the shared administrator login reference.

Enrollment requires a trusted actor. There is no separate "set a password
first" gate: on a fresh install the committed demo bootstrap password is
already a way in, and once an operator sets their own password that replaces
it — either state satisfies the precondition for enrolling a face.
"""

from ..security.face_authorization import (
    ADMIN_ACTOR,
    FaceAuthorization,
    FaceAuthorizationError,
)


def _dispatch(operation):
    def handle(client, payload):
        if not payload.get("_auth_actor_id"):
            return {"ok": False, "error": "trusted_actor_required", "_status": 403}
        service = FaceAuthorization(client.config)
        try:
            if operation == "status":
                return service.status(ADMIN_ACTOR)
            if operation == "enroll":
                return service.enroll(ADMIN_ACTOR, payload.get("image"))
            return service.delete(ADMIN_ACTOR)
        except FaceAuthorizationError as exc:
            return {"ok": False, "error": str(exc), "_status": 403}

    return handle


def routes():
    return [
        ("POST", f"/security/face/{operation}", _dispatch(operation))
        for operation in ("status", "enroll", "delete")
    ]
