"""Compact discovery is presentation only, not a permission migration."""
from types import SimpleNamespace

import pytest

from nerya.core import yaml_io
from nerya.core.paths import WorkspacePaths
from nerya.skills import management
from nerya.skills.discovery import catalog_group, catalog_roots
from nerya.skills.registry import SkillRegistry
from nerya.subagents.registry import (
    DEFAULT_SUBAGENT_PROMPTS, DEFAULT_SUBAGENT_SKILLS, DEFAULT_TIERS,
    ROLE_FAMILIES, describe_role, list_roles, save_role,
)
from nerya.tools.native.agents import role_list_handler
from nerya.tools.types import ToolCall

pytestmark = pytest.mark.smoke


@pytest.fixture
def config(tmp_path, monkeypatch):
    monkeypatch.setenv("NERYA_USER_SKILLS_ROOT", str(tmp_path / "user-skills"))
    return SimpleNamespace(paths=WorkspacePaths(tmp_path))


def test_management_and_runtime_share_groups_and_exact_methods(config):
    registry = SkillRegistry.load_builtin()
    assert len(registry.list()) == 96
    all_rows = management.catalog(config, limit=200)["skills"]
    assert {row["id"] for row in all_rows} == set(registry.by_id)
    for group, count in (("core", 13), ("professional", 7)):
        result = management.catalog(config, view=group)
        expected = {e.manifest.id for e in registry.catalog() if catalog_group(e.manifest.metadata) == group}
        assert result["total"] == count
        assert {row["id"] for row in result["skills"]} == expected
        for root in result["skills"]:
            children = management.catalog(config, parent=root["id"], limit=200)["skills"]
            assert root["method_count"] == len(children)
            assert all(row["catalog_parent"] == root["id"] and not row["method_count"] for row in children)
            for child in children:
                assert management.read(config, child["id"])["text"]
    assert not config.paths.skills_enabled.exists()


def test_search_crosses_groups_and_pagination_keeps_parent(config):
    result = management.catalog(config, view="core", query="finance.equity_research.earnings", limit=1)
    assert result["total"] == 2
    assert result["next_offset"] == 1
    assert result["skills"][0]["catalog_parent"] == "equity_research"
    page = management.catalog(config, view="core", query="finance.equity_research.earnings", offset=1, limit=1)
    assert page["next_offset"] is None
    assert page["skills"][0]["id"] != result["skills"][0]["id"]
    with pytest.raises(ValueError):
        management.catalog(config, view="unknown")


def test_leaf_only_permissions_do_not_expand_or_disappear(config):
    leaf = "finance.equity_research.earnings_analysis"
    config.paths.skills_enabled.parent.mkdir(parents=True)
    yaml_io.dump(config.paths.skills_enabled, {"enabled": [leaf]})
    save_role(config.paths, name="specific_analyst", prompt="Read one earnings method.", allowed_skills=[leaf])
    before = config.paths.skills_enabled.read_bytes()
    registry = SkillRegistry.load_builtin(config.paths)
    assert list(registry.by_id) == [leaf]
    assert [e.manifest.id for e in registry.catalog()] == [leaf]
    catalog = management.catalog(config, scope="agent", agent_id="specific_analyst", view="core")
    assert [row["id"] for row in catalog["skills"]] == [leaf]
    assert catalog["skills"][0]["assigned"] is True
    assert catalog["skills"][0]["catalog_parent"] == ""
    assert config.paths.skills_enabled.read_bytes() == before
    assert describe_role(config.paths, "specific_analyst")["allowed_skills"] == [leaf]


def test_custom_override_controls_its_own_discovery(config):
    path = config.paths.skills / "self_modify" / "SKILL.md"
    path.parent.mkdir(parents=True)
    path.write_text("---\nname: self_modify\ndescription: My custom workflow\n---\nRead only.\n")
    row = next(row for row in management.catalog(config, view="core")["skills"] if row["id"] == "self_modify")
    assert row["source"] == "workspace"
    assert row["catalog_parent"] == ""
    builtin = management.catalog(config, scope="builtin", query="self_modify")["skills"][0]
    assert builtin["catalog_parent"] == "evolve"


def test_nested_groups_and_cycles_fail_open():
    assert catalog_roots([("root", None, ""), ("child", None, "root"), ("leaf", None, "child")]) == {
        "root": "root", "child": "root", "leaf": "root",
    }
    assert catalog_roots([("a", None, "b"), ("b", None, "a"), ("c", None, "missing")]) == {
        "a": "a", "b": "b", "c": "c",
    }


def test_seven_roles_keep_exact_profiles_and_policies(config):
    before = {name: describe_role(config.paths, name) for name in DEFAULT_SUBAGENT_PROMPTS}
    compact = list_roles(config.paths, include_profiles=False)
    assert {row["name"] for row in compact} == set(ROLE_FAMILIES)
    assert len(list_roles(config.paths)) == 33
    assert {row["name"] for row in compact} | {name for row in compact for name in row["profiles"]} == set(before)
    assert before == {name: describe_role(config.paths, name) for name in before}
    collector = before["web_researcher"]["execution_policy"]
    assert collector["locked_tier"] == "light"
    assert collector["max_iterations"] == 4
    assert "trade_intent_submit" not in collector["native_tools"]["allow"]
    for name in ("code_critic", "strategy_reviewer", "verification_lane", "bull_researcher", "bear_researcher"):
        assert before[name]["name"] == name
        assert before[name]["prompt"] == DEFAULT_SUBAGENT_PROMPTS[name]
    call = ToolCall(id="roles", name="role_list", arguments={})
    result = role_list_handler(call, config=config)
    data = next(part.data for part in result.content if part.type == "json")
    assert len(data["roles"]) == 7


def test_seeded_profiles_fold_but_operator_changes_stay_visible(config):
    for name, prompt in DEFAULT_SUBAGENT_PROMPTS.items():
        save_role(config.paths, name=name, prompt=prompt,
                  allowed_skills=DEFAULT_SUBAGENT_SKILLS[name], tier=DEFAULT_TIERS[name])
    assert len(list_roles(config.paths, include_profiles=False)) == 7
    save_role(config.paths, name="technical_analyst", prompt="My custom technical method.", allowed_skills=["analysis"])
    save_role(config.paths, name="my_reviewer", prompt="My independent reviewer.", allowed_skills=[])
    compact = list_roles(config.paths, include_profiles=False)
    assert len(compact) == 9
    custom = {row["name"]: row for row in compact}
    assert custom["technical_analyst"]["allowed_skills"] == ["analysis"]
    assert custom["my_reviewer"]["allowed_skills"] == []
    assert "technical_analyst" not in custom["market_analyst"]["profiles"]
