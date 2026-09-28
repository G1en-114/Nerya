from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from types import SimpleNamespace

import pytest

from nerya.api import route_scopes, routes_approvals, routes_face_authorization
from nerya.approval_service import ApprovalService
from nerya.core import jsonl
from nerya.core.config import DEFAULT_CONFIG, Config
from nerya.core.paths import WorkspacePaths
from nerya.security import face_authorization as face

pytestmark = pytest.mark.smoke


@pytest.fixture
def setup(tmp_path, monkeypatch):
    config = Config(paths=WorkspacePaths(root=tmp_path), data=deepcopy(DEFAULT_CONFIG))
    monkeypatch.setattr(
        face,
        "_infer",
        lambda image: {
            "embedding": [1.0, 0.0],
            "live": True,
            "model": "scrfd500m-arcface-mnet-v4",
        },
    )
    monkeypatch.setattr(
        routes_approvals, "_publish_approval_resolution", lambda *args, **kwargs: None
    )
    record = {
        "approval_id": "trade-1",
        "kind": "trade_intent",
        "state": "pending",
        "actor_id": "operator",
        "size": 100,
        "expires_at": time.time() + 600,
    }
    service = face.FaceAuthorization(config)
    return config, service, record


def test_disabled_keeps_password_login(setup):
    config, service, _ = setup
    assert service.enabled() is False
    from nerya.api import auth, routes_auth

    auth.set_admin_password(config, "test-password")
    login = {
        path: handler
        for method, path, handler in routes_auth.routes()
        if method == "POST"
    }["/auth/login"]
    assert login(SimpleNamespace(config=config), {"password": "test-password"})["ok"]


def test_enrollment_encrypted_and_shared_admin(setup):
    _, service, _ = setup
    service.enroll(face.ADMIN_ACTOR, "image")
    assert service.status(face.ADMIN_ACTOR)["enrolled"]
    assert b'"embedding"' not in service.path.read_bytes()
    assert "embedding" not in str(service.status(face.ADMIN_ACTOR))


def enrolled(setup):
    config, service, _ = setup
    service.enroll(face.ADMIN_ACTOR, "image")
    return config, service


def test_receipt_single_use_and_purpose(setup):
    _, service = enrolled(setup)
    proof = service.verify(face.ADMIN_ACTOR, face.LOGIN_CONTEXT, "image")["receipt"]
    with pytest.raises(face.FaceAuthorizationError):
        service.consume("forged-actor", face.LOGIN_CONTEXT, proof)
    with pytest.raises(face.FaceAuthorizationError):
        service.consume(face.ADMIN_ACTOR, {"kind": "trade_intent"}, proof)
    assert service.consume(face.ADMIN_ACTOR, face.LOGIN_CONTEXT, proof)
    with pytest.raises(face.FaceAuthorizationError):
        service.consume(face.ADMIN_ACTOR, face.LOGIN_CONTEXT, proof)


def test_receipt_expiration(setup, monkeypatch):
    _, service = enrolled(setup)
    proof = service.verify(face.ADMIN_ACTOR, face.LOGIN_CONTEXT, "image")["receipt"]
    future = time.time() + 121
    monkeypatch.setattr(face.time, "time", lambda: future)
    with pytest.raises(face.FaceAuthorizationError):
        service.consume(face.ADMIN_ACTOR, face.LOGIN_CONTEXT, proof)


def test_reenrollment_invalidates_proof_and_delete_disables(setup):
    _, service = enrolled(setup)
    proof = service.verify(face.ADMIN_ACTOR, face.LOGIN_CONTEXT, "image")["receipt"]
    service.enroll(face.ADMIN_ACTOR, "image")
    with pytest.raises(face.FaceAuthorizationError):
        service.consume(face.ADMIN_ACTOR, face.LOGIN_CONTEXT, proof)
    assert service.delete(face.ADMIN_ACTOR)["enabled"] is False


def test_concurrent_consumption_one_winner(setup):
    _, service = enrolled(setup)
    proof = service.verify(face.ADMIN_ACTOR, face.LOGIN_CONTEXT, "image")["receipt"]

    def attempt(_):
        try:
            service.consume(face.ADMIN_ACTOR, face.LOGIN_CONTEXT, proof)
            return True
        except face.FaceAuthorizationError:
            return False

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sum(pool.map(attempt, range(2))) == 1


def test_mismatch_limited(setup, monkeypatch):
    _, service = enrolled(setup)
    monkeypatch.setattr(
        face,
        "_infer",
        lambda image: {
            "embedding": [0.0, 1.0],
            "live": True,
            "model": "scrfd500m-arcface-mnet-v4",
        },
    )
    for _ in range(5):
        with pytest.raises(
            face.FaceAuthorizationError, match="reference_face_mismatch"
        ):
            service.verify(face.ADMIN_ACTOR, face.LOGIN_CONTEXT, "image")
    with pytest.raises(face.FaceAuthorizationError, match="face_retry_later"):
        service.verify(face.ADMIN_ACTOR, face.LOGIN_CONTEXT, "image")


def test_login_requires_both_checks_and_consumes_on_bad_password(setup):
    config, service = enrolled(setup)
    from nerya.api import auth, routes_auth

    auth.set_admin_password(config, "test-password")
    handlers = {
        path: handler
        for method, path, handler in routes_auth.routes()
        if method == "POST"
    }
    client = SimpleNamespace(config=config)
    assert handlers["/auth/status"](client, {})["face_required"]
    assert (
        handlers["/auth/login"](
            client, {"password": "test-password", "faceVerified": True}
        )["error"]
        == "face_verification_required"
    )
    proof = handlers["/auth/face/verify"](
        client, {"image": "image", "actor_id": "forged"}
    )["receipt"]
    assert (
        handlers["/auth/login"](client, {"password": "wrong", "face_receipt": proof})[
            "error"
        ]
        == "invalid_password"
    )
    assert not handlers["/auth/login"](
        client, {"password": "test-password", "face_receipt": proof}
    )["ok"]
    proof = service.verify(face.ADMIN_ACTOR, face.LOGIN_CONTEXT, "image")["receipt"]
    assert handlers["/auth/login"](
        client, {"password": "test-password", "face_receipt": proof}
    )["token"]


def test_transaction_approval_unchanged_when_face_enabled(setup):
    config, _service = enrolled(setup)
    record = {
        "approval_id": "trade-1",
        "kind": "trade_intent",
        "state": "pending",
        "actor_id": "operator",
    }
    jsonl.append(config.paths.approvals_pending, record)
    assert (
        ApprovalService(config).move(
            "trade-1", state="approved", resolver_actor_id="operator"
        )["state"]
        == "approved"
    )


def test_management_scopes_and_login_public(setup):
    assert route_scopes.required_scope("POST", "/auth/face/verify") is None
    assert "/auth/face/verify" in route_scopes.ANONYMOUS_PATHS
    assert route_scopes.required_scope("POST", "/security/face/enroll") == "admin:ops"
    config, _, _ = setup
    handler = {path: f for _, path, f in routes_face_authorization.routes()}[
        "/security/face/enroll"
    ]
    assert (
        handler(SimpleNamespace(config=config), {"actor_id": "admin:password"})["error"]
        == "trusted_actor_required"
    )
    assert (
        handler(
            SimpleNamespace(config=config),
            {"_auth_actor_id": "local:loopback", "image": "image"},
        )["error"]
        == "admin_password_not_configured"
    )


def test_corrupt_vault_fails_closed(setup):
    _, service = enrolled(setup)
    service.path.write_bytes(b"corrupt")
    with pytest.raises(face.FaceAuthorizationError, match="face_store_unavailable"):
        service.enabled()


def test_inference_rejects_missing_liveness(setup, monkeypatch):
    monkeypatch.undo()
    monkeypatch.setattr(face.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(
        returncode=0, stdout='{"ok":true,"embedding":[1,0],"model":"scrfd500m-arcface-mnet-v4"}'))
    with pytest.raises(face.FaceAuthorizationError, match="liveness_failed"):
        face._infer("data:image/jpeg;base64,AAAA")


@pytest.mark.parametrize(
    "image",
    [None, "data:image/jpeg;base64," + "A" * 3_000_001, "file:///secret"],
    ids=["missing", "oversized", "file-url"],
)
def test_invalid_frames_no_worker(setup, monkeypatch, image):
    monkeypatch.undo()
    with pytest.raises(face.FaceAuthorizationError, match="invalid_camera_frame"):
        face._infer(image)
