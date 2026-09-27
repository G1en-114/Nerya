"""No network/package installation: exercise the administrator install workflow."""
from types import SimpleNamespace
import subprocess

import pytest

from nerya.mcp import openai_tunnel as tunnel

pytestmark = pytest.mark.smoke


@pytest.fixture(autouse=True)
def isolated_installer(monkeypatch):
    monkeypatch.setattr(tunnel, "_INSTALL", {"installing": False, "install_error": ""})
    monkeypatch.setattr(tunnel, "_brew", lambda: "/test/brew")
    monkeypatch.setattr(tunnel, "executable", lambda: None)


def test_install_is_async_idempotent_verified_and_does_not_pass_secrets(monkeypatch):
    jobs, calls = [], []
    class HeldThread:
        def __init__(self, **kwargs): self.kwargs = kwargs
        def start(self): jobs.append(self.kwargs)
    monkeypatch.setattr(tunnel.threading, "Thread", HeldThread)
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-reach-brew")
    monkeypatch.setenv("CONTROL_PLANE_API_KEY", "must-not-reach-brew")
    def run(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(tunnel.subprocess, "run", run)
    assert tunnel.install(None)["installing"]
    assert tunnel.install(None)["installing"]
    assert len(jobs) == 1 and not calls
    monkeypatch.setattr(tunnel, "executable", lambda: "/test/tunnel-client")
    jobs[0]["target"](*jobs[0]["args"])
    assert not tunnel.installation_status()["installing"]
    assert tunnel.installation_status()["install_error"] == ""
    assert [row[0] for row in calls] == [["/test/brew", "install", "openai/tools/tunnel-client"], ["/test/tunnel-client", "--version"]]
    assert all("OPENAI_API_KEY" not in row[1]["env"] and "CONTROL_PLANE_API_KEY" not in row[1]["env"] for row in calls)
    assert all(row[1]["stdin"] == subprocess.DEVNULL for row in calls)
    assert tunnel.install(None)["installed"] and len(jobs) == 1


@pytest.mark.parametrize("failure,expected", [
    ("nonzero", "installFailed"), ("timeout", "installTimeout"),
    ("missing", "installVerificationFailed"), ("version", "installVerificationFailed"),
    ("exception", "installFailed"),
])
def test_failure_is_reported_and_never_leaks_output(monkeypatch, failure, expected):
    tunnel._INSTALL["installing"] = True
    if failure == "version":
        monkeypatch.setattr(tunnel, "executable", lambda: "/test/tunnel-client")
    def run(command, **kwargs):
        if failure == "timeout": raise subprocess.TimeoutExpired(command, 900, output="secret")
        if failure == "exception": raise OSError("private-path-and-secret")
        return SimpleNamespace(returncode=1 if failure == "nonzero" or command[-1] == "--version" else 0)
    monkeypatch.setattr(tunnel.subprocess, "run", run)
    tunnel._install_worker("/test/brew")
    state = tunnel.installation_status()
    assert not state["installing"] and state["install_error"] == expected
    assert "secret" not in str(state)


def test_missing_package_manager_never_spawns(monkeypatch):
    monkeypatch.setattr(tunnel, "_brew", lambda: None)
    monkeypatch.setattr(tunnel.threading, "Thread", lambda **k: pytest.fail("must not spawn"))
    assert not tunnel.installation_status()["install_supported"]
    assert tunnel.install(None)["error"] == "installRequiresHomebrew"


def test_failed_install_can_retry_even_if_binary_exists(monkeypatch):
    tunnel._INSTALL["install_error"] = "installVerificationFailed"
    monkeypatch.setattr(tunnel, "executable", lambda: "/test/tunnel-client")
    jobs = []
    monkeypatch.setattr(tunnel.threading, "Thread", lambda **kw: SimpleNamespace(start=lambda: jobs.append(kw)))
    assert tunnel.install(None)["installing"]
    assert len(jobs) == 1 and not tunnel._INSTALL["install_error"]


def test_install_route_is_admin_only_and_rejects_custom_commands(tmp_path, monkeypatch):
    from nerya.api.route_scopes import required_scope
    from nerya.api import routes_mcp
    from nerya.mcp.tools import NeryaTools
    assert required_scope("POST", "/mcp-settings/tunnel/install") == "admin:ops"
    calls = []
    monkeypatch.setattr(tunnel, "install", lambda config: calls.append(config) or {"ok": True, "installing": True})
    client = NeryaTools.boot(tmp_path).client
    assert routes_mcp.tunnel_install(client, {"command": "untrusted"})["_status"] == 400
    assert not calls
    assert routes_mcp.tunnel_install(client, {})["installing"]
    assert len(calls) == 1


def test_settings_save_migrates_retired_permissions_without_enabling_network(tmp_path):
    from nerya.core import yaml_io
    from nerya.api import routes_mcp
    from nerya.mcp.tools import NeryaTools
    client = NeryaTools.boot(tmp_path).client
    client.config.data["mcp"].update(allow_tools=[], deny_tools=["nerya_info"], allow_mutating=False)
    client.config.data["mcp"]["native_tools"].update(allow_tools=["role_list"], allow_exec=False)
    yaml_io.dump(client.config.paths.config, client.config.data)
    before = routes_mcp.status(client)
    assert before["trust_mode"] == "workspace" and "allow_tools" not in before
    result = routes_mcp.save(client, {"revision": before["revision"], "enabled": False})
    assert result["ok"], result
    block = yaml_io.load(client.config.paths.config)["mcp"]
    assert not block["enabled"]
    assert not any(key in block for key in ("allow_tools", "deny_tools", "allow_mutating"))
    assert block["native_tools"] == {"enabled": True}
    assert not block["openai_tunnel"]["enabled"]
