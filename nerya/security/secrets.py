"""SecretVault — the only place in Nerya that sees raw secret values."""

from __future__ import annotations

import json
import logging
import os
import secrets as py_secrets
import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..core.atomic_write import atomic_write_bytes
from ..core.errors import SecretAccessDenied, SecretNotFoundError
from ..core.redaction import fingerprint, preview
from ..core.time import now_iso
from . import encryption

log = logging.getLogger(__name__)

# Legacy fallback used only to read vaults created by older development
# builds. New local workspaces receive a random per-workspace key in
# ``vault/keyring.ref`` instead of ever writing credentials under this
# source-published value. Live trading still independently requires
# NERYA_VAULT_PASSPHRASE (see trading/submit.py).
_DEFAULT_PASSPHRASE = "nerya-default-passphrase"
_LOCAL_KEY_NAME = "keyring.ref"
_default_pp_warned = False


def _local_key_path(vault_file: Path) -> Path:
    return Path(vault_file).with_name(_LOCAL_KEY_NAME)


def _read_or_create_local_passphrase(vault_file: Path) -> str:
    """Return a private, persistent key for non-desktop local launches.

    Packaged desktop launches inject a Keychain-backed passphrase through the
    environment before SecretVault is opened, so they never reach this path.
    Direct CLI/dev launches have no such parent process; for those we create a
    workspace-local random key with owner-only permissions. Workspace sync and
    git both exclude the vault directory, so the key never leaves the machine.
    """
    key_path = _local_key_path(vault_file)
    key_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    if not key_path.exists():
        key = py_secrets.token_urlsafe(48)
        try:
            fd = os.open(
                key_path,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | nofollow,
                0o600,
            )
        except FileExistsError:  # another local process won the race
            pass
        else:
            with os.fdopen(fd, "w", encoding="ascii") as stream:
                stream.write(key)
                stream.flush()
                os.fsync(stream.fileno())

    fd = os.open(key_path, os.O_RDONLY | nofollow)
    with os.fdopen(fd, "r", encoding="ascii") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise SecretAccessDenied(f"vault key path is not a regular file: {key_path}")
        if os.name != "nt" and (
            info.st_mode & 0o077 or info.st_uid != os.getuid()
        ):
            raise SecretAccessDenied(
                f"vault key permissions are unsafe: {key_path}; require owner-only access"
            )
        key = stream.read(129).strip()
    if not 32 <= len(key) <= 128 or key == _DEFAULT_PASSPHRASE:
        raise SecretAccessDenied(f"vault key is invalid: {key_path}")
    return key


@dataclass
class SecretMeta:
    name: str
    kind: str
    scope: list[str]
    owner: str
    created_at: str
    fingerprint: str
    preview: str

    def ref(self) -> str: return f"vault://{self.name}"

    def as_public(self) -> dict[str, Any]:
        return {
            "name": self.name, "kind": self.kind, "scope": self.scope,
            "owner": self.owner, "ref": self.ref(),
            "preview": self.preview, "sha12": self.fingerprint,
        }


@dataclass
class SecretVault:
    path: Path
    passphrase: str
    #: Set when the on-disk vault existed but could not be decrypted /
    #: parsed. Empty vault + non-empty load_error means "unreadable",
    #: never "nothing stored".
    load_error: str = field(default="", init=False)
    _cache: dict[str, str] = field(default_factory=dict, init=False)
    _meta: dict[str, SecretMeta] = field(default_factory=dict, init=False)
    _loaded: bool = field(default=False, init=False)

    @classmethod
    def open(cls, workspace_vault_file: Path, passphrase: str | None = None) -> "SecretVault":
        global _default_pp_warned
        path = Path(workspace_vault_file)
        pp = passphrase or os.environ.get("NERYA_VAULT_PASSPHRASE") or ""
        if pp:
            v = cls(path=path, passphrase=pp)
            v._load()
            return v

        key_path = _local_key_path(path)
        has_vault = path.exists() and path.stat().st_size > 0
        if not key_path.exists() and has_vault:
            # Do not invent a key for an existing custom-encrypted vault: that
            # would make the missing-passphrase problem harder to diagnose.
            # Older development builds may have written a vault with the
            # published fallback; load it read-only and migrate on the next
            # successful write by switching the in-memory passphrase to the
            # newly generated local key.
            legacy = cls(path=path, passphrase=_DEFAULT_PASSPHRASE)
            legacy._load()
            if legacy.load_error:
                if not _default_pp_warned:
                    _default_pp_warned = True
                    log.warning(
                        "SecretVault: an existing vault has no local key and "
                        "cannot be opened with the legacy development key. "
                        "Set NERYA_VAULT_PASSPHRASE to recover it."
                    )
                return legacy
            legacy.passphrase = _read_or_create_local_passphrase(path)
            log.warning(
                "SecretVault: loaded a legacy development vault; the next "
                "write will migrate it to a random per-workspace key."
            )
            return legacy

        pp = _read_or_create_local_passphrase(path)
        v = cls(path=path, passphrase=pp)
        v._load()
        if v.load_error and has_vault:
            # A previous read may already have created keyring.ref for a legacy
            # default-key vault without rewriting secrets.enc yet. Keep reads
            # working and let the next write perform the atomic re-encryption.
            legacy = cls(path=path, passphrase=_DEFAULT_PASSPHRASE)
            legacy._load()
            if not legacy.load_error:
                legacy.passphrase = pp
                return legacy
        return v

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        self._cache = {}
        self._meta = {}
        if not self.path.exists() or self.path.stat().st_size == 0:
            return
        try:
            env = encryption.Envelope.from_dict(json.loads(self.path.read_bytes()))
            raw = encryption.unseal(env, self.passphrase)
            doc = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            # A vault that exists but cannot be read (wrong passphrase,
            # corrupt/truncated file) must not silently masquerade as an
            # empty vault: every later resolve() would look like "not
            # configured" instead of "vault unreadable".
            self.load_error = f"{type(exc).__name__}: {exc}"
            log.error(
                "SecretVault at %s could not be loaded (%s) — treating as "
                "empty. Secrets stored in it are NOT gone; fix the "
                "passphrase or restore the file.",
                self.path, self.load_error,
            )
            return
        for item in doc.get("secrets", []):
            name = item["name"]
            self._cache[name] = item["value"]
            self._meta[name] = SecretMeta(
                name=name, kind=item.get("kind", "opaque"),
                scope=item.get("scope", []), owner=item.get("owner", "runtime"),
                created_at=item.get("created_at", now_iso()),
                fingerprint=fingerprint(item["value"]),
                preview=preview(item["value"]),
            )

    def _flush(self) -> None:
        doc = {
            "secrets": [
                {
                    "name": name,
                    "value": self._cache[name],
                    "kind": m.kind,
                    "scope": m.scope,
                    "owner": m.owner,
                    "created_at": m.created_at,
                }
                for name, m in self._meta.items()
            ]
        }
        raw = json.dumps(doc, ensure_ascii=False).encode("utf-8")
        env = encryption.seal(raw, self.passphrase)
        atomic_write_bytes(self.path, json.dumps(env.to_dict()).encode("utf-8"))

    # ---------- public API ----------
    def _assert_writable(self) -> None:
        if self.load_error and self.path.exists():
            # _flush() rewrites from the in-memory cache only, so a failed
            # decrypt must never be allowed to turn into data loss.
            raise SecretAccessDenied(
                f"vault at {self.path} is unreadable ({self.load_error}); "
                "refusing to overwrite it. Fix NERYA_VAULT_PASSPHRASE or "
                "restore/resolve the file before storing new secrets."
            )
        if self.passphrase == _DEFAULT_PASSPHRASE:
            raise SecretAccessDenied(
                "refusing to store secrets under the legacy default vault "
                "passphrase. Set NERYA_VAULT_PASSPHRASE to recover this vault."
            )

    def put(self, *, name: str, value: str, kind: str, scope: list[str],
            owner: str = "runtime") -> SecretMeta:
        self._assert_writable()
        self._cache[name] = value
        meta = SecretMeta(
            name=name, kind=kind, scope=scope, owner=owner,
            created_at=now_iso(),
            fingerprint=fingerprint(value),
            preview=preview(value),
        )
        self._meta[name] = meta
        self._flush()
        return meta

    def list(self) -> list[SecretMeta]:
        return list(self._meta.values())

    def meta(self, name: str) -> SecretMeta:
        if name not in self._meta:
            raise SecretNotFoundError(name)
        return self._meta[name]

    def resolve(self, name: str, *, required_scope: str | None = None) -> str:
        if name not in self._cache:
            raise SecretNotFoundError(name)
        if required_scope and required_scope not in self._meta[name].scope:
            raise SecretAccessDenied(f"secret {name} lacks scope {required_scope}")
        return self._cache[name]

    def public_ref(self, name: str) -> dict[str, Any]:
        return self.meta(name).as_public()

    def delete(self, name: str) -> None:
        self._assert_writable()
        self._cache.pop(name, None)
        self._meta.pop(name, None)
        self._flush()
