from pathlib import Path

import pytest

pytest.importorskip("web3")
from nerya.api import route_scopes
from nerya.api.routes_mandate_demo import routes
from nerya.security import mandate_demo_service as service
from nerya.security.mandate_demo import validate_request

pytestmark = pytest.mark.smoke


@pytest.fixture
def jobs(monkeypatch):
    monkeypatch.setattr(service, "_jobs", {})
    monkeypatch.setattr(service, "_latest", {})
    monkeypatch.setattr(service, "prerequisites", lambda: [])
    captured = []
    class Worker:
        def __init__(self, **kwargs):
            captured.append(kwargs)
        def start(self):
            pass
    monkeypatch.setattr(service.threading, "Thread", Worker)
    return captured


def test_demo_routes_require_operator_and_only_post_starts():
    assert {r[:2] for r in routes()} == {("GET", "/safety/demo/status"), ("POST", "/safety/demo/run")}
    for method, path, _ in routes():
        assert route_scopes.required_scope(method, path) == "admin:ops"
        assert not route_scopes.authorize(frozenset({"read:runtime", "trade:paper"}), method, path)[0]
        assert route_scopes.authorize(frozenset({"admin:ops"}), method, path)[0]


@pytest.mark.parametrize("payload", [None, {"rpc_url": "https://external.invalid"}, {"workspace": "../"},
    {"allowed_market": "binance:BTC/USDT"}, {"amount": 0}, {"amount": True}, {"amount": 1.2},
    {"budget": 1001}, {"allow_long": "true"}, {"scenario": "shell"}, {"scenario": []}])
def test_rejects_unsafe_or_invalid_input(payload):
    with pytest.raises((ValueError, TypeError)):
        validate_request(payload)


def test_idempotency_concurrency_and_workspace_isolation(tmp_path, jobs):
    key = "a" * 32
    first = service.start(tmp_path, key, {"scenario": "fees"})
    repeated = service.start(tmp_path, key, {"scenario": "fees"})
    assert first == repeated and len(jobs) == 1
    assert service.start(tmp_path, key, {"scenario": "allowed"})["error"] == "request_id_conflict"
    assert service.start(tmp_path, "b" * 32, {})["error"] == "demo_busy"
    assert service.status(tmp_path)["job"]["id"] == first["job"]["id"]
    assert service.status(tmp_path / "other", first["job"]["id"])["error"] == "demo_job_not_found"
    assert "workspace" not in first["job"]
    assert jobs[0]["args"][1].is_relative_to(service.ROOT / ".tmp" / "mandate-interactive")


def test_worker_returns_projection_and_sanitizes_failures(tmp_path, jobs, monkeypatch):
    first = service.start(tmp_path, "a" * 32, {})
    monkeypatch.setattr(service, "_run", lambda *_: {"cases": [{"status": "rejected"}]})
    service._work(first["job"]["id"], Path("unused"))
    assert service.status(tmp_path)["job"]["state"] == "completed"
    second = service.start(tmp_path, "b" * 32, {})
    def fail(*_):
        raise RuntimeError("SECRET_DO_NOT_RETURN")
    monkeypatch.setattr(service, "_run", fail)
    service._work(second["job"]["id"], Path("unused"))
    result = service.status(tmp_path)
    assert result["job"]["state"] == "failed"
    assert result["job"]["error"] == "demo_execution_failed"
    assert "SECRET" not in str(result)


def test_missing_dependencies_and_invalid_input_do_not_start(tmp_path, jobs, monkeypatch):
    assert service.status(tmp_path, ["bad"])["error"] == "invalid_job_id"
    assert service.status(tmp_path, "../bad")["error"] == "invalid_job_id"
    assert service.start(tmp_path, "../bad", {})["error"] == "invalid_request_id"
    assert service.start(tmp_path, "a" * 32, {"command": "cmd"})["error"] == "invalid_demo_request"
    monkeypatch.setattr(service, "prerequisites", lambda: ["anvil"])
    assert service.start(tmp_path, "a" * 32, {})["error"] == "demo_dependencies_missing"
    assert jobs == []


def test_api_run_does_not_import_repository_scripts(tmp_path, jobs, monkeypatch):
    # Console entry points do not put the checkout root on sys.path. A
    # third-party 'scripts' namespace (e.g. pywin32) may also exist there.
    import builtins
    original_import = builtins.__import__
    def reject_scripts(name, *args, **kwargs):
        if name == "scripts" or name.startswith("scripts."):
            raise ModuleNotFoundError("Repository scripts are not installed")
        return original_import(name, *args, **kwargs)
    monkeypatch.setattr(builtins, "__import__", reject_scripts)
    monkeypatch.chdir(tmp_path)
    response = service.start(tmp_path, "c" * 32, {"scenario": "fees"})
    assert response["ok"] and len(jobs) == 1
    from nerya.security import mandate_demo
    evidence = tmp_path / "evidence.json"
    evidence.write_text('{"public_testnet":false,"human_wallet_approval":false,"domain":{"chainId":31337,"verifyingContract":"test"},"cases":[{"case":"test","status":"rejected","new_executors":0,"result":{}}]}', encoding="utf-8")
    monkeypatch.setattr(mandate_demo, "run_demo", lambda *_: {"evidence": str(evidence)})
    service._work(response["job"]["id"], tmp_path)
    assert service.status(tmp_path)["job"]["state"] == "completed"


def test_readiness_checks_the_actual_runner_import(monkeypatch):
    import builtins
    original_import = builtins.__import__
    def broken_runner(name, *args, **kwargs):
        if name == "mandate_demo":
            raise ModuleNotFoundError("broken dependency")
        return original_import(name, *args, **kwargs)
    monkeypatch.setattr(builtins, "__import__", broken_runner)
    monkeypatch.setattr(service.importlib.util, "find_spec", lambda _: object())
    monkeypatch.setattr(service.shutil, "which", lambda _: "anvil")
    monkeypatch.setattr(Path, "is_file", lambda _: True)
    assert "demo_runtime" in service.prerequisites()
