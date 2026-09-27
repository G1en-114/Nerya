"""Process-bound source identity, shared by the API and fresh replay workers."""
from __future__ import annotations

import hashlib
from pathlib import Path
import time

ROOT = Path(__file__).resolve().parents[1]
STARTED_AT = time.time()


def source_build_id() -> str:
    return hashlib.sha256(b"".join(path.read_bytes() for path in sorted(ROOT.rglob("*.py")))).hexdigest()[:16]


def source_sdk_build_id(root: Path = ROOT) -> str:
    """Execution dependency identity, not unrelated chat/API presentation.

    Protect the pure replay engine, manifest/SDK, data arithmetic, accounting,
    import guards and shared infrastructure. An agent text renderer change does
    not alter historical execution and must not invalidate a running worker.
    The full application build remains recorded separately for audit.
    """
    scopes = ("core", "strategies", "data", "trading", "sdk", "db", "workspace",
              "charting", "connectors", "skills/builtin/backtest")
    paths = {root / "__init__.py"}
    for scope in scopes:
        paths.update((root / scope).rglob("*.py"))
    digest = hashlib.sha256()
    for path in sorted(paths):
        if path.is_file():
            digest.update(path.relative_to(root).as_posix().encode() + b"\0")
            digest.update(path.read_bytes() + b"\0")
    return digest.hexdigest()[:16]


BUILD_ID = source_build_id()
SDK_BUILD_ID = source_sdk_build_id()
