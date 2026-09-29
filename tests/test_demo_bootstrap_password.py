"""Demo bootstrap password: first-run login, then locked down on first change."""
from __future__ import annotations

import time
from copy import deepcopy
from types import SimpleNamespace

import pytest

from nerya.api import auth as auth_mod
from nerya.api import routes_auth, routes_face_authorization
from nerya.core.config import DEFAULT_CONFIG, Config
from nerya.core.paths import WorkspacePaths

pytestmark = pytest.mark.smoke


@pytest.fixture
def config(tmp_path):
    return Config(paths=WorkspacePaths(root=tmp_path), data=deepcopy(DEFAULT_CONFIG))


def post(path, client, payload):
    handler = {p: h for m, p, h in routes_auth.routes() if m == "POST"}[path]
    return handler(client, payload)


def client_for(config):
    return SimpleNamespace(config=config)


def test_fresh_install_logs_in_with_bootstrap_password(config):
    assert auth_mod.has_admin_password(config) is False
    assert auth_mod.demo_password_active(config) is True
    result = post("/auth/login", client_for(config), {"password": auth_mod.DEMO_INITIAL_PASSWORD})
    assert result["ok"] is True and result.get("token")


def test_bootstrap_password_is_rejected_after_operator_sets_one(config):
    auth_mod.set_admin_password(config, "operator-chosen-pass")
    assert auth_mod.demo_password_active(config) is False
    result = post("/auth/login", client_for(config), {"password": auth_mod.DEMO_INITIAL_PASSWORD})
    assert result["ok"] is False and result["error"] == "invalid_password"
    assert post("/auth/login", client_for(config), {"password": "operator-chosen-pass"})["ok"] is True


def test_status_exposes_bootstrap_state(config):
    fresh = auth_mod.admin_auth_status(config)
    assert fresh["demo_password_active"] is True and fresh["password_configured"] is False
    auth_mod.set_admin_password(config, "operator-chosen-pass")
    locked = auth_mod.admin_auth_status(config)
    assert locked["demo_password_active"] is False and locked["password_configured"] is True


def test_setting_password_requires_the_bootstrap_value(config):
    # A stale session must not silently replace the credential.
    result = post("/auth/admin/password", client_for(config), {"new_password": "sneaky-pass"})
    assert result["ok"] is False and result["error"] == "invalid_current_password"
    result = post("/auth/admin/password", client_for(config), {
        "new_password": "sneaky-pass", "current_password": auth_mod.DEMO_INITIAL_PASSWORD,
    })
    assert result["ok"] is True
    assert auth_mod.verify_admin_password(config, "sneaky-pass")
    assert not auth_mod.verify_admin_password(config, auth_mod.DEMO_INITIAL_PASSWORD)


def test_rotating_an_operator_password_requires_the_current_one(config):
    auth_mod.set_admin_password(config, "first-pass")
    result = post("/auth/admin/password", client_for(config), {"new_password": "second-pass"})
    assert result["ok"] is False and result["error"] == "current_password_required"
    result = post("/auth/admin/password", client_for(config), {
        "new_password": "second-pass", "current_password": "first-pass",
    })
    assert result["ok"] is True


def test_face_enrollment_allowed_on_bootstrap_but_not_when_unset(config, monkeypatch):
    monkeypatch.setattr(
        routes_face_authorization.FaceAuthorization, "enroll",
        lambda self, actor, image: {"ok": True, "enrolled": True},
    )
    handler = {p: h for m, p, h in routes_face_authorization.routes() if m == "POST"}["/security/face/enroll"]
    client = client_for(config)
    assert handler(client, {"_auth_actor_id": "admin", "image": "frame"})["ok"] is True
    auth_mod.set_admin_password(config, "operator-chosen-pass")
    assert handler(client, {"_auth_actor_id": "admin", "image": "frame"})["ok"] is True


def test_bootstrap_password_does_not_weaken_face_gate(config, monkeypatch):
    """Once a face is enrolled the receipt is still mandatory."""
    from nerya.security import face_authorization as face

    monkeypatch.setattr(
        face, "_infer",
        lambda image: {"embedding": [1.0, 0.0], "live": True, "model": "scrfd500m-arcface-mnet-v4"},
    )
    face.FaceAuthorization(config).enroll(face.ADMIN_ACTOR, "image")
    result = post("/auth/login", client_for(config), {"password": auth_mod.DEMO_INITIAL_PASSWORD})
    assert result["ok"] is False and result["error"] == "face_verification_required"
    # With a valid receipt the same password then works, proving the bootstrap
    # credential did not bypass the face gate.
    receipt = face.FaceAuthorization(config).verify(
        face.ADMIN_ACTOR, face.LOGIN_CONTEXT, "image"
    )["receipt"]
    result = post("/auth/login", client_for(config), {
        "password": auth_mod.DEMO_INITIAL_PASSWORD, "face_receipt": receipt,
    })
    assert result["ok"] is True and result.get("token")
