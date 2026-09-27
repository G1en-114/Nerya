"""Exercise the actual bootstrap and child metadata boundaries, without models."""
from dataclasses import replace
from nerya.core.config import Config
from nerya.core.paths import WorkspacePaths
from nerya.skills.kernel import SkillKernel
from nerya.tools.native.bootstrap import build_native_tool_deps
from nerya.tools.native.skill_tool import skill_tool_handler
from nerya.tools.types import ToolCall
from nerya.subagents.runtime import SubAgentRuntime
from nerya.subagents.registry import SubAgentExecutionPolicy, SubAgentSpec


def skill(root, name):
    path = root / name / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\nname: {name}\ndescription: isolated fixture\n---\nPrivate {name} instructions")


def test_bootstrap_index_adopts_reloaded_catalog(tmp_path, monkeypatch):
    monkeypatch.setenv("NERYA_USER_SKILLS_ROOT", str(tmp_path / "home"))
    cfg = Config(paths=WorkspacePaths(tmp_path / "workspace"))
    skill(cfg.paths.skills, "scope_a")
    kernel = SkillKernel.boot(cfg)
    deps = build_native_tool_deps(workspace_root=cfg.paths.root, skill_roots=[], config=cfg, paths=cfg.paths, skills=kernel)
    skill(cfg.paths.skills, "scope_b")
    kernel.reload()
    result = skill_tool_handler(ToolCall(name="Skill", arguments={"skill":"scope_b"}), skill_index=deps.skill_index)
    assert not result.is_error and "Private scope_b" in result.text()
    denied = skill_tool_handler(ToolCall(name="Skill", arguments={"skill":"scope_b"}, metadata={"allowed_skills":["scope_a"]}), skill_index=deps.skill_index)
    assert denied.is_error and "Private scope_b" not in denied.text()


def test_child_preload_cannot_escape_role_skill_assignment(tmp_path, monkeypatch):
    monkeypatch.setenv("NERYA_USER_SKILLS_ROOT", str(tmp_path / "home"))
    cfg = Config(paths=WorkspacePaths(tmp_path / "workspace"))
    for name in ("scope_a", "scope_b"):
        skill(cfg.paths.skills, name)
    rt = SubAgentRuntime(config=cfg, skills=SkillKernel.boot(cfg), llm=None, tool_registry=None, tool_executor=None)
    spec = SubAgentSpec(name="reader", prompt_path=tmp_path/"role.md", prompt="Read", allowed_skills=["scope_a"],
                        execution_policy=SubAgentExecutionPolicy(preload_skills=["scope_a", "scope_b"]))
    context = rt._preloaded_skill_context(spec)
    assert "Private scope_a" in context
    assert "Private scope_b" not in context
    assert "Private scope_b" in rt._preloaded_skill_context(replace(spec, allowed_skills=[]))
