"""External control plane: real local handlers, isolated workspaces, no network."""
from __future__ import annotations

import builtins
import io
import json
from copy import deepcopy
from types import SimpleNamespace

import pytest

from nerya.cli.app import main
from nerya.mcp.catalog import ToolCatalog, ExposedTool, build_catalog, is_error, public_result
from nerya.mcp.settings import server_settings
from nerya.mcp.tools import NeryaTools

pytestmark = pytest.mark.smoke


@pytest.fixture
def tools(tmp_path):
    return NeryaTools.boot(tmp_path)


def writable(tools):
    return build_catalog(tools)


def test_default_catalog_is_trusted_and_has_real_schemas(tools):
    catalog = build_catalog(tools)
    assert tools.client.config.get("mcp.enabled") is False
    assert "nerya_native_role_list" in catalog.tools
    assert "nerya_native_role_save" in catalog.tools
    assert "nerya_trigger_emit" in catalog.tools
    assert "nerya_strategy_generate" in catalog.tools
    assert catalog.tools["nerya_native_read_file"].read_only
    assert not catalog.tools["nerya_native_write_file"].read_only
    assert not catalog.tools["nerya_native_run_shell"].read_only
    schema = catalog.describe("nerya_market_ticker")["inputSchema"]
    assert schema["required"] == ["market"]
    assert schema["properties"]["market"]["type"] == "string"
    assert "kwargs" not in schema["properties"]
    assert not is_error(catalog.call("nerya_native_role_save", {"name": "external_example", "prompt": "Workspace assistant."}))


def test_retired_native_allowlist_does_not_limit_trusted_agents(tools):
    tools.client.config.data["mcp"]["native_tools"]["allow_tools"] = ["role_get"]
    catalog = build_catalog(tools)
    assert "nerya_native_role_get" in catalog.tools
    assert "nerya_native_role_list" in catalog.tools
    assert not is_error(catalog.call("nerya_native_role_list", {}))
    assert is_error(catalog.call("nerya_native_role_get", {}))
    assert is_error(catalog.call("nerya_native_role_get", {"name": "x", "_trusted": True}))


def test_native_catalog_matches_main_agent_tools(tools):
    catalog = writable(tools)
    assert "nerya_native_role_save" in catalog.tools
    assert "nerya_native_evolve_core_config_patch" in catalog.tools
    assert "nerya_strategy_generate" in catalog.tools
    from nerya.agent.kernel import AgentKernel
    from nerya.mcp.registry_bridge import native_mcp_tool_name
    registry, _ = AgentKernel(config=tools.client.config, skills=tools.client.skills).prepare_tools()
    expected = {native_mcp_tool_name(tool.name) for tool in registry.list_tools()}
    assert {name for name, row in catalog.tools.items() if row.source == "native"} == expected
    assert "nerya_native_run_shell" in expected


def test_shared_workspace_policy_still_applies(tools):
    tools.client.config.data["agent"]["native"]["tool_policy"] = {"deny": ["run_shell", "write_file"]}
    catalog = build_catalog(tools)
    assert "nerya_native_read_file" in catalog.tools
    assert "nerya_native_run_shell" not in catalog.tools
    assert "nerya_native_write_file" not in catalog.tools
    assert is_error(catalog.call("nerya_native_run_shell", {"command": "printf forbidden"}))


def test_trusted_agent_reads_edits_writes_and_runs_workspace_command(tools, tmp_path):
    path = tmp_path / "external.txt"
    path.write_text("before\n")
    catalog = build_catalog(tools)
    assert not is_error(catalog.call("nerya_native_read_file", {"path": "external.txt"}))
    edited = catalog.call("nerya_native_edit_file", {
        "path": "external.txt", "old_string": "before", "new_string": "after",
    })
    assert not is_error(edited), edited
    assert path.read_text() == "after\n"
    assert not is_error(catalog.call("nerya_native_read_file", {"path": "external.txt"}))
    written = catalog.call("nerya_native_write_file", {"path": "external.txt", "contents": "complete\n"})
    assert not is_error(written), written
    assert path.read_text() == "complete\n"
    shell = catalog.call("nerya_native_run_shell", {"command": "printf mcp-shell-ok"})
    assert not is_error(shell), shell
    assert "mcp-shell-ok" in json.dumps(shell)


def test_shared_approval_can_be_resumed_once_without_bypassing_risk(tools):
    from nerya.core import jsonl
    from nerya.tools import ToolRegistry
    from nerya.tools.types import ToolCall, ToolDescriptor, ToolResult, RiskLevel, PermissionScope
    from nerya.mcp.registry_bridge import build_native_mcp_registry
    invoked = []
    registry = ToolRegistry()
    registry.register(ToolDescriptor(name="sensitive_example", description="Test approval only",
        input_schema={"type": "object", "properties": {}}, risk=RiskLevel.DANGEROUS,
        permission_scope=PermissionScope.WORKSPACE, read_only=False,
        handler=lambda call: invoked.append(call.id) or ToolResult.from_text(
            tool_use_id=call.id, name=call.name, text="approved test action")))
    _, executor = build_native_mcp_registry(registry=registry, config=tools.client.config)
    assert executor.execute(ToolCall(id="first", name="sensitive_example", arguments={})).is_error
    assert not invoked
    paths = tools.client.config.paths
    pending = jsonl.read_all(paths.approvals_pending)
    assert len(pending) == 1
    jsonl.write_all(paths.approvals_approved, pending)
    jsonl.write_all(paths.approvals_pending, [])
    assert not executor.execute(ToolCall(id="retry", name="sensitive_example", arguments={})).is_error
    assert invoked == ["retry"]
    assert executor.execute(ToolCall(id="again", name="sensitive_example", arguments={})).is_error
    assert invoked == ["retry"]


def test_real_agent_role_create_read_delete(tools, tmp_path):
    catalog = writable(tools)
    payload = {"name": "external_researcher", "prompt": "Read-only market researcher.", "allowed_skills": ["news"]}
    saved = catalog.call("nerya_native_role_save", payload)
    assert not is_error(saved), saved
    path = tmp_path / "subagents" / "external_researcher.agent.md"
    assert path.exists()
    viewed = catalog.call("nerya_native_role_get", {"name": "external_researcher"})
    assert not is_error(viewed), viewed
    assert "Read-only market researcher." in json.dumps(viewed)
    deleted = catalog.call("nerya_native_role_delete", {"name": "external_researcher"})
    assert not is_error(deleted), deleted
    assert not path.exists()
    assert is_error(catalog.call("nerya_native_role_save", {**payload, "name": "../../escape"}))


def test_config_change_creates_proposal_not_live_file(tools, tmp_path):
    catalog = writable(tools)
    result = catalog.call("nerya_native_evolve_core_config_patch", {
        "target": "agents.yml", "summary": "Reduce concurrency",
        "config_after": {"max_parallel": 2},
    })
    assert not is_error(result), result
    assert not (tmp_path / "agents.yml").exists()
    assert list((tmp_path / "evolution" / "proposals").glob("*/after/agents.yml"))


def test_remote_cannot_enable_mcp_or_change_protected_risk(tools):
    catalog = writable(tools)
    for config_after in ({"mcp": {"enabled": True}}, {"runtime": {"live_trading_enabled": True}}):
        result = catalog.call("nerya_native_evolve_core_config_patch", {
            "target": "nerya.yml", "summary": "Forbidden widening", "config_after": config_after,
        })
        assert is_error(result), result


def test_strategy_generation_is_typed_and_proposal_only(tools, tmp_path):
    catalog = writable(tools)
    schema = catalog.describe("nerya_strategy_generate")["inputSchema"]
    assert set(schema["required"]) == {"strategy_id", "markets", "accounts"}
    request = {"strategy_id": "external_trend", "markets": ["PAPER:BTCUSDT"], "accounts": ["paper_main"]}
    assert is_error(catalog.call("nerya_strategy_generate", {**request, "mode": "live"}))
    result = catalog.call("nerya_strategy_generate", request)
    assert not is_error(result), result
    assert not (tmp_path / "strategies" / "external_trend").exists()
    assert list((tmp_path / "evolution" / "proposals").glob("*/after/strategies/external_trend/strategy.yml"))


@pytest.mark.parametrize("target", ["../outside", "vault/secrets.json", "/etc/passwd"])
def test_config_path_boundary(tools, target):
    assert is_error(build_catalog(tools).call("nerya_config_get", {"target": target}))


def test_config_redaction_and_symlink_boundary(tools, tmp_path):
    path = tmp_path / "agents.yml"
    path.write_text("token: short-secret\nmodel: local-model\napi_key: key-secret\n", encoding="utf-8")
    result = build_catalog(tools).call("nerya_config_get", {"target": "agents.yml"})
    text = json.dumps(result)
    assert "short-secret" not in text and "key-secret" not in text
    assert result["config"]["model"] == "local-model"
    (tmp_path / "workspace.yml").symlink_to(path)
    assert is_error(build_catalog(tools).call("nerya_config_get", {"target": "workspace.yml"}))
    assert is_error(build_catalog(tools).call("nerya_proposals_show", {"proposal_id": "../../escape"}))


def test_public_envelopes_remove_traces_and_secret_text():
    value = {"text": '{"token":"short-secret"}', "diff": "+api_key: other-secret",
             "metadata": {"access_token": "third-secret", "trace": "private stack"},
             "expected_hash": "a" * 64, "revision": "b" * 64,
             "enabled_revision": "c" * 64, "catalog_generation": "d" * 64, "tokens": 12}
    result = public_result(value)
    text = json.dumps(result)
    assert all(s not in text for s in ("short-secret", "other-secret", "third-secret", "private stack"))
    assert result["expected_hash"] == "a" * 64
    assert result["revision"] == "b" * 64
    assert result["enabled_revision"] == "c" * 64
    assert result["catalog_generation"] == "d" * 64
    assert result["tokens"] == 12
    assert not is_error({"status": {"healthy": True}})


@pytest.mark.parametrize("value", [False, None, "false", "true", 1])
def test_disabled_or_non_boolean_enabled_never_starts(tools, value, monkeypatch):
    from nerya.mcp import server
    tools.client.config.data["mcp"]["enabled"] = value
    with pytest.raises(ValueError, match="disabled"):
        server.create_server(tools)


@pytest.mark.parametrize("block,key,value", [
    ("native_tools", "allow_mutating", "false"),
    ("native_tools", "allow_tools", "role_list"),
    ("dynamic_tools", "allow_actions", "news.recent"),
    ("dynamic_tools", "enabled", 1),
])
def test_malformed_exposure_configuration_fails_closed(tools, block, key, value):
    tools.client.config.data["mcp"][block][key] = value
    with pytest.raises(ValueError):
        build_catalog(tools)


def test_http_settings_require_token_and_host_allowlist(tools, monkeypatch):
    cfg = tools.client.config
    cfg.data["mcp"].update(enabled=True, transport="http", auth_mode="bearer")
    monkeypatch.delenv("NERYA_MCP_TOKEN", raising=False)
    with pytest.raises(ValueError, match="token"):
        server_settings(cfg)
    token = "test-credential-" + "x" * 32
    monkeypatch.setenv("NERYA_MCP_TOKEN", token)
    settings = server_settings(cfg)
    assert settings.transport == "streamable-http"
    assert settings.allowed_hosts == ["127.0.0.1:8765"]
    assert token not in repr(settings)
    with pytest.raises(ValueError, match="allowed_hosts"):
        server_settings(cfg, host="0.0.0.0")
    with pytest.raises(ValueError, match="port"):
        server_settings(cfg, port=True)
    cfg.data["mcp"]["allowed_hosts"] = ["nerya.example:443"]
    assert server_settings(cfg, host="0.0.0.0").host == "0.0.0.0"
    assert server_settings(cfg, transport="stdio").token == ""


def test_cli_shared_catalog_json_and_profile_without_sdk(tools, monkeypatch, capsys):
    seen = []
    def boot(workspace, *, profile=None):
        seen.append((workspace, profile))
        print("diagnostic noise")
        return tools
    monkeypatch.setattr(NeryaTools, "boot", boot)
    original_import = builtins.__import__
    def no_mcp(name, globals=None, locals=None, fromlist=(), level=0):
        # Relative imports such as ``from ..mcp.lazy`` are Nerya's own code,
        # not an import of the optional third-party MCP SDK.
        if level == 0 and (name == "mcp" or name.startswith("mcp.")):
            raise ImportError("optional SDK intentionally absent")
        return original_import(name, globals, locals, fromlist, level)
    monkeypatch.setattr(builtins, "__import__", no_mcp)
    assert main(["tools", "list", "--workspace", "selected", "--profile", "dev"]) == 0
    captured = capsys.readouterr()
    assert "tools" in json.loads(captured.out)
    assert "diagnostic noise" in captured.err
    assert seen == [("selected", "dev")]
    assert main(["agent", "list"]) == 0
    assert not is_error(json.loads(capsys.readouterr().out))
    assert main(["config", "get", "agents.yml"]) == 0
    assert json.loads(capsys.readouterr().out)["target"] == "agents.yml"
    assert main(["tools", "call", "missing"]) == 1
    assert json.loads(capsys.readouterr().out)["error"]["code"] == "not_found"
    tools.client.config.data["mcp"]["enabled"] = True
    from nerya.mcp.server import create_server
    with pytest.raises(RuntimeError, match="optional"):
        create_server(tools)


@pytest.mark.parametrize("raw", ["[]", "{", "", '{"x":NaN}', '{"x":Infinity}'])
def test_cli_invalid_json_is_nonzero_and_never_boots(raw, monkeypatch, capsys):
    monkeypatch.setattr(NeryaTools, "boot", lambda *a, **k: pytest.fail("invalid input booted workspace"))
    assert main(["tools", "call", "nerya_info", "--input", raw]) == 2
    assert json.loads(capsys.readouterr().out)["error"]["code"] == "invalid_arguments"


def test_cli_reads_stdin_and_enforces_argument_schema(tools, monkeypatch, capsys):
    monkeypatch.setattr(NeryaTools, "boot", lambda *a, **k: tools)
    monkeypatch.setattr("sys.stdin", io.StringIO('{"name":"market_analyst"}'))
    assert main(["tools", "call", "nerya_native_role_get", "--input-file", "-"]) == 0
    assert not is_error(json.loads(capsys.readouterr().out))
    assert main(["tools", "call", "nerya_native_role_get", "--input", "{}"] ) == 1
    assert json.loads(capsys.readouterr().out)["error"]["code"] == "invalid_arguments"


def test_duplicate_catalog_names_and_bad_arguments():
    catalog = ToolCatalog()
    calls = []
    tool = ExposedTool("test", "test", {"type": "object", "properties": {}}, True,
                       lambda **kwargs: calls.append(kwargs) or {"ok": True})
    catalog.add(tool)
    with pytest.raises(ValueError, match="Duplicate"):
        catalog.add(tool)
    for payload in ([], {"x": float("nan")}, {"x": "x" * 1_048_577}):
        assert is_error(catalog.call("test", payload))
    assert calls == []


def test_retired_global_permission_lists_do_not_hide_tools(tools):
    cfg = tools.client.config.data["mcp"]
    cfg["allow_tools"] = ["nerya_info", "nerya_native_role_list", "nerya_native_role_save"]
    cfg["deny_tools"] = ["nerya_info"]
    catalog = build_catalog(tools)
    assert not is_error(catalog.call("nerya_info"))
    assert "nerya_native_write_file" in catalog.tools
    expected = set(catalog.tools)
    cfg["allow_tools"] = []
    cfg["native_tools"].update(enabled=False, allow_mutating=False, allow_exec=False, allow_tools=[])
    cfg["dynamic_tools"].update(enabled=False, allow_mutating=False, allow_skills=[])
    assert set(build_catalog(tools).tools) == expected


def test_dynamic_catalog_and_compatibility_helper_use_client_and_real_schema(tools, monkeypatch):
    from nerya.mcp.dynamic_tools import DynamicMCPRegistry
    from nerya.mcp.server import build_dynamic_registry

    schema = {"type": "object", "properties": {"value": {"type": "integer"}}, "required": ["value"]}
    row = SimpleNamespace(name="nerya_dynamic_echo", description="Echo", input_schema=schema,
                          read_only=True, fn=lambda value: {"value": value})
    view = SimpleNamespace(tools=[row])
    def build(client, *, policy):
        assert client is tools.client
        assert policy is not None
        return view
    monkeypatch.setattr(DynamicMCPRegistry, "build", build)
    catalog = build_catalog(tools, include_legacy=False, include_native=False)
    assert catalog.describe(row.name)["inputSchema"] == schema
    assert catalog.call(row.name, {"value": 12}) == {"value": 12}
    assert is_error(catalog.call(row.name, {"value": "wrong"}))
    assert build_dynamic_registry(tools) is view


def test_config_proposal_preserves_partial_mcp_block_but_rejects_restriction_removal(tools):
    from nerya.core.errors import ProtectedScopeViolation
    from nerya.evolution.self_config import propose_core_config_patch

    before = {"mcp": {"enabled": True, "allow_tools": ["nerya_info"]}}
    after = deepcopy(before)
    after["agent"] = {"max_iterations": 12}
    proposal = propose_core_config_patch(tools.client.config.paths, target="nerya.yml",
                                         summary="Unrelated configuration change", config_after=after,
                                         current_config=before)
    assert proposal.kind == "core_config_patch"
    for weakened in ({"mcp": {"enabled": True}}, {}):
        with pytest.raises(ProtectedScopeViolation, match="mcp"):
            propose_core_config_patch(tools.client.config.paths, target="nerya.yml",
                                      summary="Remove restriction", config_after=weakened,
                                      current_config=before)


def test_disabled_serve_never_boots_kernel(tools, monkeypatch):
    from nerya.mcp import server

    monkeypatch.setattr(server, "load_config", lambda *a, **k: tools.client.config)
    monkeypatch.setattr(server.InternalClient, "from_config",
                        lambda *a, **k: pytest.fail("Disabled server booted a kernel"))
    with pytest.raises(ValueError, match="disabled"):
        server.serve()
