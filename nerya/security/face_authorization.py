"""Encrypted face enrollment and short-lived, one-use administrator login receipts.

The password is still required. Trading risk and approval gates are independent.
Passive anti-spoofing is not replay-proof identity.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from ..vision.face import _vector, cosine_similarity
from .encryption import has_strong_crypto
from .secrets import SecretVault

ADMIN_ACTOR = "admin:password"
LOGIN_CONTEXT = {"kind": "admin_login", "purpose": "password_login"}
_LOCK = threading.RLock()
_INFERENCE_LIMIT = threading.BoundedSemaphore(2)
_VALUE = "face-authorization"
THRESHOLD = 0.5
RECEIPT_SECONDS = 120


class FaceAuthorizationError(ValueError):
    pass


def login_digest(record: dict) -> str:
    return hashlib.sha256(
        json.dumps(
            record, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    ).hexdigest()


def _infer(image: str) -> dict:
    if (
        not isinstance(image, str)
        or not image.startswith(("data:image/jpeg;base64,", "data:image/png;base64,"))
        or len(image) > 3_000_000
    ):
        raise FaceAuthorizationError("invalid_camera_frame")
    root = Path(__file__).resolve().parents[2]
    local_python = (
        root
        / ".venv-face"
        / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    )
    executable = os.environ.get("NERYA_FACE_PYTHON") or (
        str(local_python) if local_python.is_file() else sys.executable
    )
    env = dict(os.environ, PYTHONPATH=str(root), OPENCV_IO_MAX_IMAGE_PIXELS="4000000")
    if not _INFERENCE_LIMIT.acquire(blocking=False):
        raise FaceAuthorizationError("face_verification_busy")
    try:
        result = subprocess.run(
            [executable, "-m", "nerya.vision.face_worker"],
            input=json.dumps({"image": image}),
            text=True,
            capture_output=True,
            timeout=90,
            env=env,
            cwd=root,
            check=False,
        )
        output = json.loads(result.stdout)
        if result.returncode or not output.get("ok"):
            raise FaceAuthorizationError(
                str(output.get("error") or "face_model_unavailable")
            )
        if (
            output.get("live") is not True
            or output.get("model") != "scrfd500m-arcface-mnet-v4"
        ):
            raise FaceAuthorizationError("liveness_failed")
        output["embedding"] = _vector(output.get("embedding"))
        return output
    except FaceAuthorizationError:
        raise
    except Exception as exc:
        raise FaceAuthorizationError("face_model_unavailable") from exc
    finally:
        _INFERENCE_LIMIT.release()


class FaceAuthorization:
    def __init__(self, config):
        self.config = config
        # Separate encrypted vault: generic secret CRUD cannot expose profiles.
        self.path = config.paths.vault_enc.with_name("face.enc")

    @contextmanager
    def _locked(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with _LOCK, self.path.with_suffix(".lock").open("a+b") as handle:
            if handle.tell() == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                handle.seek(0)
                if os.name == "nt":
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def _read(self):
        if not self.path.exists():
            return {"enabled": False, "profiles": {}, "receipts": {}}
        try:
            vault = SecretVault.open(self.path)
            doc = json.loads(vault.resolve(_VALUE, required_scope="face:internal"))
            if not isinstance(doc.get("profiles"), dict) or not isinstance(
                doc.get("receipts"), dict
            ):
                raise TypeError("invalid face store")
            return doc
        except Exception as exc:
            raise FaceAuthorizationError("face_store_unavailable") from exc

    def _write(self, doc):
        if not has_strong_crypto():
            raise FaceAuthorizationError("face_encryption_unavailable")
        SecretVault.open(self.path).put(
            name=_VALUE,
            value=json.dumps(doc, allow_nan=False),
            kind="biometric",
            scope=["face:internal"],
            owner="operator",
        )

    @staticmethod
    def _actor_key(actor):
        if not isinstance(actor, str) or not actor.strip():
            raise FaceAuthorizationError("trusted_actor_required")
        return hashlib.sha256(actor.encode()).hexdigest()

    def enabled(self):
        with self._locked():
            return bool(self._read()["enabled"])

    def status(self, actor):
        key = self._actor_key(actor)
        with self._locked():
            doc = self._read()
            profile = doc["profiles"].get(key)
            return {
                "ok": True,
                "enabled": bool(doc["enabled"]),
                "enrolled": bool(profile),
                "enrolled_at": profile.get("created_at") if profile else None,
                "receipt_seconds": RECEIPT_SECONDS,
                "liveness_mode": "minifasnet_passive",
            }

    def enroll(self, actor, image):
        key = self._actor_key(actor)
        inferred = _infer(image)
        with self._locked():
            doc = self._read()
            old = doc["profiles"].get(key)
            if (
                old
                and cosine_similarity(inferred["embedding"], old["embedding"])
                < THRESHOLD
            ):
                raise FaceAuthorizationError("reference_face_mismatch")
            doc["profiles"][key] = {
                "embedding": inferred["embedding"],
                "model": inferred["model"],
                "revision": secrets.token_hex(16),
                "created_at": time.time(),
            }
            doc["receipts"] = {
                k: v for k, v in doc["receipts"].items() if v["actor"] != key
            }
            doc["enabled"] = True
            self._write(doc)
        return self.status(actor)

    def delete(self, actor):
        key = self._actor_key(actor)
        with self._locked():
            doc = self._read()
            doc["profiles"].pop(key, None)
            doc["enabled"] = bool(doc["profiles"])
            doc["receipts"] = {
                k: v for k, v in doc["receipts"].items() if v["actor"] != key
            }
            self._write(doc)
        return self.status(actor)

    def verify(self, actor, record, image):
        key = self._actor_key(actor)
        digest = login_digest(record)
        if record != LOGIN_CONTEXT:
            raise FaceAuthorizationError("admin_login_required")
        with self._locked():
            doc = self._read()
            profile = doc["profiles"].get(key)
            if not doc["enabled"] or not profile:
                raise FaceAuthorizationError("face_enrollment_required")
            attempts = doc.setdefault("attempts", {}).get(key, {})
            if attempts.get("count", 0) >= 5 and attempts.get("until", 0) > time.time():
                raise FaceAuthorizationError("face_retry_later")
            revision = profile["revision"]
        try:
            inferred = _infer(image)
            score = cosine_similarity(inferred["embedding"], profile["embedding"])
            if score < THRESHOLD or inferred["model"] != profile["model"]:
                raise FaceAuthorizationError("reference_face_mismatch")
        except Exception:
            with self._locked():
                doc = self._read()
                attempts = doc.setdefault("attempts", {}).get(key, {})
                count = (
                    attempts.get("count", 0)
                    if attempts.get("until", 0) > time.time()
                    else 0
                )
                doc["attempts"][key] = {"count": count + 1, "until": time.time() + 60}
                self._write(doc)
            raise
        receipt = secrets.token_urlsafe(32)
        expires = time.time() + RECEIPT_SECONDS
        with self._locked():
            doc = self._read()
            if (
                not doc["enabled"]
                or doc["profiles"].get(key, {}).get("revision") != revision
            ):
                raise FaceAuthorizationError("face_enrollment_changed")
            doc["receipts"] = {
                k: v
                for k, v in doc["receipts"].items()
                if v["expires_at"] > time.time() and v["actor"] != key
            }
            doc["receipts"][hashlib.sha256(receipt.encode()).hexdigest()] = {
                "actor": key,
                "login_digest": digest,
                "revision": revision,
                "expires_at": expires,
            }
            doc.setdefault("attempts", {}).pop(key, None)
            self._write(doc)
        return {
            "ok": True,
            "receipt": receipt,
            "expires_at": expires,
            "liveness_mode": "minifasnet_passive",
        }

    def consume(self, actor, record, receipt):
        key = self._actor_key(actor)
        with self._locked():
            doc = self._read()
            if not doc["enabled"]:
                return None
            if record != LOGIN_CONTEXT:
                raise FaceAuthorizationError("admin_login_required")
            if not isinstance(receipt, str) or not receipt or len(receipt) > 128:
                raise FaceAuthorizationError("face_verification_required")
            token_hash = hashlib.sha256(receipt.encode()).hexdigest()
            proof = doc["receipts"].get(token_hash)
            profile = doc["profiles"].get(key, {})
            if (
                not proof
                or proof["actor"] != key
                or proof["expires_at"] <= time.time()
                or proof["revision"] != profile.get("revision")
                or proof["login_digest"] != login_digest(record)
            ):
                raise FaceAuthorizationError("face_receipt_invalid_or_expired")
            del doc["receipts"][token_hash]
            self._write(doc)
            return {
                "verified_at": time.time(),
                "liveness_mode": "minifasnet_passive",
                "login_digest": proof["login_digest"],
            }
