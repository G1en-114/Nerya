"""Operator-only jobs for isolated local-chain/paper demonstrations.

No agent tool is registered. Request data cannot select an account, command,
workspace, private key, chain, RPC or output path.
"""
from __future__ import annotations

from copy import deepcopy
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import threading
import time
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
_lock = threading.Lock()
_jobs: dict[str, dict] = {}
_latest: dict[str, str] = {}


def prerequisites() -> list[str]:
    missing = [name for name in ("web3", "eth_account") if importlib.util.find_spec(name) is None]
    binary = Path.home() / ".foundry" / "bin" / ("anvil.exe" if os.name == "nt" else "anvil")
    if not shutil.which("anvil") and not binary.is_file():
        missing.append("anvil")
    if not (ROOT / "contracts/mandates/out/NeryaMandateVerifier.sol/NeryaMandateVerifier.json").is_file():
        missing.append("contract_build")
    if not missing:
        try:
            from .mandate_demo import run_demo, validate_request  # noqa: F401
            from .mandate_demo_export import snapshot  # noqa: F401
        except ImportError:
            missing.append("demo_runtime")
    return missing


def _view(job: dict) -> dict:
    return deepcopy({key: job[key] for key in ("id", "state", "request", "startedAt", "finishedAt", "error", "result")})


def status(workspace: Path, job_id: str | None = None) -> dict:
    if job_id is not None and (not isinstance(job_id, str) or not re.fullmatch(r"[a-f0-9]{32}", job_id)):
        return {"ok": False, "error": "invalid_job_id"}
    scope = str(workspace.resolve())
    with _lock:
        found = _jobs.get(job_id or _latest.get(scope, ""))
        if found and found["workspace"] == scope:
            return {"ok": True, "job": _view(found), "missing": []}
    if job_id:
        return {"ok": False, "error": "demo_job_not_found"}
    return {"ok": True, "job": None, "missing": prerequisites()}


def _run(output: Path, request: dict) -> dict:
    from .mandate_demo import run_demo
    from .mandate_demo_export import snapshot
    summary = run_demo(output, request)
    return snapshot(json.loads(Path(summary["evidence"]).read_text(encoding="utf-8")))


def _work(job_id: str, output: Path):
    try:
        with _lock:
            request = deepcopy(_jobs[job_id]["request"])
        result = _run(output, request)
        with _lock:
            _jobs[job_id].update(state="completed", result=result, finishedAt=time.time())
    except Exception:
        # The raw exception may include workspace state. Never return it.
        with _lock:
            _jobs[job_id].update(state="failed", error="demo_execution_failed", finishedAt=time.time())


def start(workspace: Path, request_id: str, request: dict) -> dict:
    if not isinstance(request_id, str) or not re.fullmatch(r"[a-zA-Z0-9-]{16,64}", request_id):
        return {"ok": False, "error": "invalid_request_id"}
    missing = prerequisites()
    if missing:
        return {"ok": False, "error": "demo_dependencies_missing", "missing": missing}
    from .mandate_demo import validate_request
    try:
        options = validate_request(request)
    except (ValueError, TypeError):
        return {"ok": False, "error": "invalid_demo_request"}
    scope = str(workspace.resolve())
    with _lock:
        for job in _jobs.values():
            if job["workspace"] == scope and job["requestId"] == request_id:
                if job["request"] != options:
                    return {"ok": False, "error": "request_id_conflict"}
                return {"ok": True, "job": _view(job)}
        # One isolated Anvil process at a time per server. Concurrent tabs do
        # not create an unbounded queue or double-spend the demo ledger.
        if any(job["state"] == "running" for job in _jobs.values()):
            return {"ok": False, "error": "demo_busy"}
        if len(_jobs) >= 20:
            oldest = min(_jobs, key=lambda key: _jobs[key]["startedAt"])
            del _jobs[oldest]
        job_id = uuid4().hex
        job = {"id": job_id, "workspace": scope, "requestId": request_id, "request": options,
               "state": "running", "startedAt": time.time(), "finishedAt": None,
               "error": None, "result": None}
        _jobs[job_id] = job
        _latest[scope] = job_id
        response = {"ok": True, "job": _view(job)}
    output = ROOT / ".tmp" / "mandate-interactive" / sha256(scope.encode()).hexdigest()[:16] / job_id
    try:
        # Non-daemon: normal Python shutdown waits for the runner's finally
        # block to terminate its own Anvil. No active trading workspace used.
        threading.Thread(target=_work, args=(job_id, output), daemon=False).start()
    except Exception:
        with _lock:
            job.update(state="failed", error="demo_execution_failed", finishedAt=time.time())
        return {"ok": False, "error": "demo_execution_failed"}
    return response
