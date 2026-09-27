"""R07/R08 offline contracts; all mutable Skill roots live in tmp_path."""
from pathlib import Path

import pytest

from nerya.core import yaml_io
from nerya.core.config import Config
from nerya.core.paths import WorkspacePaths
from nerya.skills import management
from nerya.skills.kernel import SkillKernel
from nerya.tools.native.skill import (
    SkillIndex, script_inspect_handler, script_run_handler, skill_index_handler,
    skill_view_handler,
)
from nerya.tools.native.skill_tool import skill_tool_handler
from nerya.tools.types import ToolCall, ToolErrorKind


def write_skill(root, name, body="version one"):
    path = root / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\nname: {name}\ndescription: test workflow\n---\n{body}\n")
    return path


@pytest.fixture
def config(tmp_path, monkeypatch):
    monkeypatch.setenv("NERYA_USER_SKILLS_ROOT", str(tmp_path / "home"))
    cfg = Config(paths=WorkspacePaths(root=tmp_path / "workspace"))
    cfg.paths.skills.mkdir(parents=True)
    return cfg


def live_index(kernel):
    return SkillIndex([], registry_provider=lambda: kernel.registry, refresh_registry=kernel.reload)


def invoke(index, *, metadata=None, **arguments):
    return skill_tool_handler(ToolCall(id="test", name="Skill", arguments=arguments,
                                      metadata=metadata or {}), skill_index=index)


def data(result):
    return next(part.data for part in result.content if part.type == "json")


def test_same_source_canonical_name_and_generation_across_consumers(config, tmp_path):
    write_skill(tmp_path / "home" / "same", "My Skill", "home body")
    installed = write_skill(config.paths.skills_installed / "same", "My Skill", "installed body")
    kernel = SkillKernel.boot(config)
    index = live_index(kernel)
    for expected, body in [(installed, "installed body"),
                           (config.paths.skills / "same" / "SKILL.md", "workspace body")]:
        if expected != installed:
            write_skill(expected.parent, "My Skill", body)
        kernel.reload()
        row = next(row for row in management.catalog(config, limit=200)["skills"] if row["id"] == "my_skill")
        assert row["source"] == kernel.view("My Skill")["source"]
        assert row["title"] == "My Skill"
        assert any(s["source"] == "user_home" for s in row["shadowed"])
        for alias in ["My Skill", "my_skill"]:
            result = invoke(index, skill=alias)
            assert not result.is_error
            assert body in result.text()
            assert data(result)["path"] == str(expected)
            assert data(result)["skill_id"] == "my_skill"
            assert data(result)["revision"] == management.read(config, alias)["revision"]
            assert data(result)["revision"] == kernel.view(alias)["revision"]
        assert index.catalog_generation == kernel.catalog_generation == management.catalog(config)["catalog_generation"]
        assert index.get("My Skill") is index.get("my_skill")


def test_refresh_add_delete_disable_and_existing_body_policy(config):
    a = write_skill(config.paths.skills / "a", "a")
    kernel = SkillKernel.boot(config)
    index = live_index(kernel)
    original = invoke(index, skill="a")
    generation = data(original)["catalog_generation"]
    write_skill(a.parent, "a", "version two")
    # A conversation already contains version one; another read reports the
    # actual new bytes and also the older catalog revision until reload.
    updated = invoke(index, skill="a")
    assert "version one" in original.text() and "version two" in updated.text()
    assert data(updated)["revision"] != data(updated)["catalog_revision"]
    assert data(updated)["body_policy"] == "latest_on_read"
    assert data(updated)["catalog_generation"] == generation
    b = write_skill(config.paths.skills / "b", "b")
    refreshed = invoke(index, skill="b", refresh=True)
    assert not refreshed.is_error
    assert data(refreshed)["catalog_generation"] != generation
    assert kernel.view("a")["revision"] == data(updated)["revision"]
    b.unlink()
    yaml_io.dump(config.paths.skills_enabled, {"enabled": []})
    kernel.reload()
    assert index.records() == []
    assert invoke(index, skill="a").error.kind == ToolErrorKind.NOT_FOUND
    assert invoke(index, skill="b").error.kind == ToolErrorKind.NOT_FOUND
    assert index.catalog_generation == management.catalog(config)["catalog_generation"]
    yaml_io.dump(config.paths.skills_enabled, {"enabled": ["a"]})
    assert not invoke(index, skill="a", refresh=True).is_error


def test_procedural_entry_filename_and_legacy_id(config):
    path = config.paths.skills / "legacy.md"
    path.write_text("---\nid: Legacy_ID\ndescription: older playbook\n---\nLegacy body\n")
    kernel = SkillKernel.boot(config)
    index = live_index(kernel)
    for alias in ["Legacy_ID", "legacy_id"]:
        loaded = invoke(index, skill=alias)
        assert not loaded.is_error
        assert "Legacy body" in loaded.text()
        assert data(loaded)["skill_id"] == "legacy_id"
        assert data(loaded)["path"] == str(path)
        assert management.read(config, alias)["text"] == path.read_text()
        assert kernel.registry.get(alias).action("run")(None)["body"].strip() == "Legacy body"


def test_top_level_procedural_skill_keeps_run_and_pending_stays_inactive(config):
    path = write_skill(config.paths.skills, "Root Playbook")
    write_skill(config.paths.skills / "pending" / "draft", "unapproved")
    write_skill(config.paths.skills / "rejected" / "draft", "rejected")
    kernel = SkillKernel.boot(config)
    assert kernel.registry.get("Root Playbook").action("run")(None)["body"].strip() == "version one"
    index = live_index(kernel)
    assert data(invoke(index, skill="Root Playbook"))["path"] == str(path)
    assert index.get("unapproved") is None
    assert index.get("rejected") is None


def test_enabled_raw_name_and_canonical_update_applies(config):
    path = write_skill(config.paths.skills / "named", "My Skill")
    yaml_io.dump(config.paths.skills_enabled, {"enabled": ["My Skill"]})
    kernel = SkillKernel.boot(config)
    assert [entry.manifest.id for entry in kernel.registry.list()] == ["my_skill"]
    before = management.read(config, "My Skill")
    result = management.manage(config, "update", "My Skill", revision=before["revision"],
                               content=path.read_text().replace("version one", "version two"))
    assert result["applied"] is True
    assert "version two" in path.read_text()


@pytest.fixture
def scoped_index(tmp_path):
    for directory, name in [("a", "Allowed A"), ("b", "Blocked B")]:
        md = write_skill(tmp_path / directory, name)
        (md.parent / "references").mkdir()
        (md.parent / "references" / "notes.md").write_text(name + " notes\n")
        (md.parent / "scripts").mkdir()
        (md.parent / "scripts" / "helper.py").write_text("raise AssertionError('must not execute')\n")
    return SkillIndex([tmp_path])


@pytest.mark.parametrize("action,extra", [
    ("load", {}), ("read", {"file": "references/notes.md"}),
    ("inspect", {"script": "helper.py"}),
])
def test_role_allows_a_rejects_b_for_raw_and_canonical_names(scoped_index, action, extra):
    metadata = {"allowed_skills": ["Allowed A"]}
    for name in ["Allowed A", "allowed_a"]:
        assert not invoke(scoped_index, metadata=metadata, action=action, skill=name, **extra).is_error
    for name in ["Blocked B", "blocked_b"]:
        result = invoke(scoped_index, metadata=metadata, action=action, skill=name,
                        allowed_skills=[name], **extra)
        assert result.error.kind == ToolErrorKind.PERMISSION_DENIED
    listing = invoke(scoped_index, action="list", metadata=metadata)
    assert [r["skill_id"] for r in data(listing)["skills"]] == ["allowed_a"]
    prompt = scoped_index.render_for_prompt(allowed_skills=["Allowed A"])
    assert "allowed_a" in prompt and "blocked_b" not in prompt


@pytest.mark.parametrize("metadata", [{}, {"allowed_skills": []}, {"allowed_skills": None}])
def test_empty_role_scope_keeps_legacy_access(scoped_index, metadata):
    assert not invoke(scoped_index, skill="blocked_b", metadata=metadata).is_error


@pytest.mark.parametrize("handler,args", [
    (skill_view_handler, {"skill_id": "blocked_b", "file": "references/notes.md"}),
    (script_inspect_handler, {"skill_id": "blocked_b", "name": "helper.py"}),
    (script_run_handler, {"skill_id": "blocked_b", "name": "helper.py"}),
])
def test_legacy_entries_cannot_bypass_scope(scoped_index, handler, args):
    call = ToolCall(id="legacy", name="legacy", arguments=args, metadata={"allowed_skills": ["allowed_a"]})
    assert handler(call, skill_index=scoped_index).error.kind == ToolErrorKind.PERMISSION_DENIED
    listing = skill_index_handler(call, skill_index=scoped_index)
    assert [r["skill_id"] for r in data(listing)["skills"]] == ["allowed_a"]


def test_reference_paths_and_nested_skill_scope(tmp_path):
    hub = write_skill(tmp_path / "hub", "hub")
    child = write_skill(hub.parent / "child", "other")
    namespace = write_skill(hub.parent / "leaf", "hub.leaf")
    for path in [child, namespace]:
        (path.parent / "references").mkdir()
        (path.parent / "references" / "notes.md").write_text("local notes\n")
    (hub.parent / "escape.md").symlink_to(child)
    index = SkillIndex([tmp_path])
    metadata = {"allowed_skills": ["hub"]}
    for file in ["child/SKILL.md", "child/references/notes.md", "escape.md"]:
        assert invoke(index, skill="hub", file=file, metadata=metadata).error.kind == ToolErrorKind.PERMISSION_DENIED
    assert not invoke(index, skill="hub", file="leaf/references/notes.md", metadata=metadata).is_error
    for file in ["../outside.md", str(tmp_path / "outside.md")]:
        assert invoke(index, skill="hub", file=file, metadata=metadata).is_error
    assert [r.skill_id for r in index.catalog(allowed_skills=["hub.leaf"])] == ["hub.leaf"]
    assert invoke(index, skill="hub", metadata={"allowed_skills": ["hub.leaf"]}).is_error


def test_malformed_scope_does_not_grant_access(scoped_index):
    for value in ["allowed_a", 7, [None], [""]]:
        assert invoke(scoped_index, skill="allowed_a", metadata={"allowed_skills": value}).is_error


def test_sibling_single_file_and_disabled_nested_reference_cannot_bypass(config):
    for name in ["legacy_a", "legacy_b"]:
        (config.paths.skills / f"{name}.md").write_text(f"---\nid: {name}\n---\n{name}\n")
    hub = write_skill(config.paths.skills / "hub", "hub")
    write_skill(hub.parent / "child", "other")
    kernel = SkillKernel.boot(config)
    index = live_index(kernel)
    result = invoke(index, skill="legacy_a", file="legacy_b.md",
                    metadata={"allowed_skills": ["legacy_a"]})
    assert result.error.kind == ToolErrorKind.PERMISSION_DENIED
    yaml_io.dump(config.paths.skills_enabled, {"enabled": ["hub"]})
    kernel.reload()
    assert invoke(index, skill="hub", file="child/SKILL.md").error.kind == ToolErrorKind.NOT_FOUND
