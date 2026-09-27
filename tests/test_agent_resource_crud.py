from types import SimpleNamespace
import pytest

pytestmark = pytest.mark.smoke
from nerya.api.routes_teams import _save_role, _get_role, _delete_role
from nerya.core.paths import WorkspacePaths


def test_operator_role_crud_preserves_explicit_empty_skills(tmp_path):
    client = SimpleNamespace(config=SimpleNamespace(paths=WorkspacePaths(root=tmp_path)))
    created = _save_role(client, {"name": "market_analyst", "prompt": "Analyze evidence", "allowed_skills": ["research"], "tier": "medium"})
    assert created["ok"]
    updated = _save_role(client, {"name": "market_analyst", "prompt": "Review evidence", "allowed_skills": [], "tier": "medium"})
    assert updated["ok"]
    assert updated["role"]["allowed_skills"] == []
    assert _get_role(client, {"name": "market_analyst"})["role"]["allowed_skills"] == []
    assert _delete_role(client, {"name": "market_analyst"})["deleted"]
    assert _get_role(client, {"name": "market_analyst"})["role"]["source"] != "workspace"


def test_role_save_retains_model_override_when_not_in_request(tmp_path):
    client = SimpleNamespace(config=SimpleNamespace(paths=WorkspacePaths(root=tmp_path)))
    result = _save_role(client, {"name": "custom_reviewer", "prompt": "Review", "provider": "openai", "model": "example-model"})
    assert result["role"]["model"] == "example-model"
    result = _save_role(client, {"name": "custom_reviewer", "prompt": "Updated", "allowed_skills": []})
    assert result["role"]["provider"] == "openai"
    assert result["role"]["model"] == "example-model"
    result = _save_role(client, {"name": "custom_reviewer", "prompt": "Updated", "provider": "", "model": ""})
    assert result["role"]["model"] == ""


def test_role_toggle_persists_and_blocks_dispatch(tmp_path):
    from nerya.mcp.tools import NeryaTools
    config = NeryaTools.boot(tmp_path).client.config
    from nerya.subagents.dispatcher import SubAgentDispatcher
    client = SimpleNamespace(config=config)
    result = _save_role(client, {"name": "custom_disabled", "prompt": "Review", "allowed_skills": [], "enabled": False})
    assert result["role"]["enabled"] is False
    assert _get_role(client, {"name": "custom_disabled"})["role"]["enabled"] is False
    dispatcher = SubAgentDispatcher(config=config, skills=None, tool_registry=None, executor=None)
    result = dispatcher.dispatch("subagent:custom_disabled", payload={})
    assert not result["ok"] and result["error_kind"] == "disabled"
    result = _save_role(client, {"name": "custom_disabled", "prompt": "Review", "allowed_skills": [], "enabled": True})
    assert result["role"]["enabled"] is True
