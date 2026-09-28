"""One-use nod-intent receipts bound to a specific pending approval.

A nod is camera evidence of confirmation intent for one request. It is not
identity, not liveness, and never bypasses RiskGate: the approval callback
keeps enforcing ownership, expiry and risk checks exactly as before. The
vision service never sees credentials and cannot write ``approved=true``.
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

from .encryption import has_strong_crypto
from .secrets import SecretVault

RECEIPT_SECONDS = 90
MAX_FRAMES = 24
MIN_FRAMES = 8
SUPPORTED_KINDS = {"trade_intent", "wallet_swap"}
_VALUE = "nod-intent"
_LOCK = threading.RLock()
_INFERENCE_LIMIT = threading.BoundedSemaphore(1)


class NodIntentError(ValueError):
    pass


def record_digest(record: dict) -> str:
    """Content binding: any change to the approval request invalidates the receipt."""
    return hashlib.sha256(
        json.dumps(record, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def _infer(frames) -> dict:
    root = Path(__file__).resolve().parents[2]
    local_python = (
        root
        / ".venv-face"
        / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    )
    executable = os.environ.get("NERYA_FACE_PYTHON") or (
        str(local_python) if local_python.is_file() else sys.executable
    )
    env = dict(
        os.environ,
        PYTHONPATH=str(root),
        OPENCV_IO_MAX_IMAGE_PIXELS="4000000",
        # See face_authorization: single-threaded BLAS avoids OpenBLAS
        # allocation failures when the machine is low on memory.
        OPENBLAS_NUM_THREADS="1",
        OMP_NUM_THREADS="1",
    )
    if not _INFERENCE_LIMIT.acquire(blocking=False):
        raise NodIntentError("nod_verification_busy")
    try:
        result = subprocess.run(
            [executable, "-m", "nerya.vision.nod_worker"],
            input=json.dumps({"frames": frames}),
            text=True,
            capture_output=True,
            timeout=120,
            env=env,
            cwd=root,
            check=False,
        )
        output = json.loads(result.stdout)
        if result.returncode or not output.get("ok"):
            raise NodIntentError(str(output.get("error") or "nod_model_unavailable"))
        return output
    except NodIntentError:
        raise
    except Exception as exc:
        raise NodIntentError("nod_model_unavailable") from exc
    finally:
        _INFERENCE_LIMIT.release()


class NodIntentService:
    def __init__(self, config):
        self.config = config
        # Encrypted vault dedicated to intent receipts; separate from secrets CRUD.
        self.path = config.paths.vault_enc.with_name("nod.enc")

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
            return {"receipts": {}}
        try:
            vault = SecretVault.open(self.path)
            doc = json.loads(vault.resolve(_VALUE, required_scope="nod:internal"))
            if not isinstance(doc.get("receipts"), dict):
                raise TypeError("invalid nod store")
            return doc
        except Exception as exc:
            raise NodIntentError("nod_store_unavailable") from exc

    def _write(self, doc):
        if not has_strong_crypto():
            raise NodIntentError("nod_encryption_unavailable")
        SecretVault.open(self.path).put(
            name=_VALUE,
            value=json.dumps(doc, allow_nan=False),
            kind="interaction_receipt",
            scope=["nod:internal"],
            owner="operator",
        )

    @staticmethod
    def _actor_key(actor):
        if not isinstance(actor, str) or not actor.strip():
            raise NodIntentError("trusted_actor_required")
        return hashlib.sha256(actor.encode()).hexdigest()

    @staticmethod
    def _frames(frames):
        if not isinstance(frames, list) or not MIN_FRAMES <= len(frames) <= MAX_FRAMES:
            raise NodIntentError("invalid_frame_count")
        for frame in frames:
            if (
                not isinstance(frame, str)
                or not frame.startswith(("data:image/jpeg;base64,", "data:image/png;base64,"))
                or len(frame) > 1_400_000
            ):
                raise NodIntentError("invalid_camera_frame")
        return frames

    def capture(self, actor, approval_id, record, frames):
        """Verify a nod burst against one pending approval and mint a receipt."""
        key = self._actor_key(actor)
        if not isinstance(approval_id, str) or not approval_id.strip() or len(approval_id) > 128:
            raise NodIntentError("approval_id_required")
        if str((record or {}).get("kind") or "") not in SUPPORTED_KINDS:
            raise NodIntentError("nod_kind_not_supported")
        digest = record_digest(record)
        inferred = _infer(self._frames(frames))
        if inferred.get("nod") is not True:
            raise NodIntentError("nod_not_detected")
        receipt = secrets.token_urlsafe(32)
        expires = time.time() + RECEIPT_SECONDS
        with self._locked():
            doc = self._read()
            doc["receipts"] = {
                token: meta
                for token, meta in doc["receipts"].items()
                if meta["expires_at"] > time.time() and not meta.get("used")
            }
            doc["receipts"][hashlib.sha256(receipt.encode()).hexdigest()] = {
                "actor": key,
                "approval_id": approval_id,
                "digest": digest,
                "amplitude": float(inferred.get("amplitude") or 0.0),
                "detector": str(inferred.get("detector") or ""),
                "expires_at": expires,
                "used": False,
            }
            self._write(doc)
        return {
            "ok": True,
            "intent": "nod",
            "receipt": receipt,
            "expires_at": expires,
            "approval_id": approval_id,
            "amplitude": inferred.get("amplitude"),
            "identity_proven": False,
            "demo": True,
        }

    def consume(self, actor, approval_id, record, receipt):
        """Single-use validation at approve time; raises on any mismatch."""
        key = self._actor_key(actor)
        if not isinstance(receipt, str) or not receipt or len(receipt) > 128:
            raise NodIntentError("nod_intent_invalid")
        with self._locked():
            doc = self._read()
            token = hashlib.sha256(receipt.encode()).hexdigest()
            meta = doc["receipts"].get(token)
            if (
                not meta
                or meta.get("actor") != key
                or meta.get("approval_id") != approval_id
            ):
                raise NodIntentError("nod_intent_invalid")
            if meta.get("used"):
                raise NodIntentError("nod_intent_used")
            if meta["expires_at"] <= time.time():
                raise NodIntentError("nod_intent_expired")
            if meta.get("digest") != record_digest(record):
                raise NodIntentError("nod_intent_stale")
            meta["used"] = True
            meta["consumed_at"] = time.time()
            self._write(doc)
            return {
                "confirmed_at": meta["consumed_at"],
                "amplitude": meta.get("amplitude"),
                "identity_proven": False,
            }
