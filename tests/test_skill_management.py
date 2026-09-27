"""All Skill definitions and scoped changes remain safe and apply immediately."""

import pytest

from nerya.core import yaml_io
from nerya.mcp.tools import NeryaTools
from nerya.skills import management as m
from nerya.skills.registry import SkillRegistry
from nerya.subagents.registry import save_role, load_registry

pytestmark = pytest.mark.smoke


def playbook(name="test_skill", body="Read local data safely."):
    return f"---\nname: {name}\ndescription: A testing workflow.\n---\n\n{body}\n"


@pytest.fixture
def config(tmp_path, monkeypatch):
    monkeypatch.setenv("NERYA_USER_SKILLS_ROOT", str(tmp_path / "no-home-skills"))
    cfg = NeryaTools.boot(tmp_path).client.config
    directory = tmp_path / "skills" / "test_skill"
    directory.mkdir(parents=True)
    (directory / "SKILL.md").write_text(playbook())
    (directory / "references").mkdir()
    (directory / "references" / "notes.md").write_text("Local notes.\n")
    return cfg


def test_complete_catalog_and_asset_read(config):
    first = m.catalog(config, limit=2)
    assert first["total"] > 30
    assert first["next_offset"] == 2
    assert len(m.catalog(config, offset=2, limit=2)["skills"]) == 2
    ws = m.catalog(config, scope="workspace")
    assert [row["id"] for row in ws["skills"]] == ["test_skill"]
    result = m.read(config, "test_skill", file="references/notes.md", limit=5)
    assert result["text"] == "Local"
    assert result["next_offset"] == 5
    assert "references/notes.md" in result["files"]
    yaml_io.dump(config.paths.skills_enabled, {"enabled": []})
    assert not any(row["enabled"] for row in m.catalog(config, limit=200)["skills"])
    assert SkillRegistry.load_builtin(config.paths, config=config).list() == []
    assert m.read(config, "test_skill")["text"] == playbook()


def test_update_create_and_delete_apply_immediately(config):
    old = m.read(config, "test_skill")
    with pytest.raises(ValueError, match="stale_revision"):
        m.manage(config, "update", "test_skill", revision="stale", content=playbook(body="New"))
    updated = m.manage(config, "update", "test_skill", revision=old["revision"], content=playbook(body="Changed"))
    assert updated["applied"] is True
    assert (config.paths.skills / "test_skill" / "SKILL.md").read_text() == playbook(body="Changed")

    created = m.manage(config, "create", "another_skill", revision="missing", content=playbook("another_skill"))
    assert created["applied"] is True
    assert (config.paths.skills / "another_skill" / "SKILL.md").read_text() == playbook("another_skill")

    yaml_io.dump(config.paths.skills_enabled, {"enabled": ["test_skill", "another_skill"]})
    current = m.read(config, "test_skill")
    deleted = m.manage(config, "delete", "test_skill", revision=current["revision"])
    assert deleted["applied"] is True
    assert not (config.paths.skills / "test_skill" / "SKILL.md").exists()
    assert not (config.paths.skills / "test_skill" / "references" / "notes.md").exists()
    assert yaml_io.load(config.paths.skills_enabled)["enabled"] == ["another_skill"]


def test_agent_assignment_applies_immediately_and_empty_means_none(config):
    save_role(config.paths, name="test_agent", prompt="A safe role", allowed_skills=["test_skill"])
    catalog = m.catalog(config, scope="agent", agent_id="test_agent")
    assert [row["id"] for row in catalog["skills"]] == ["test_skill"]
    assert m.read(config, "test_skill", scope="agent", agent_id="test_agent")["shared_definition"]
    result = m.manage(config, "disable", "test_skill", scope="agent", agent_id="test_agent", revision=catalog["binding_revision"])
    assert result["applied"] is True
    assert load_registry(config.paths)["test_agent"].allowed_skills == []
    with pytest.raises(ValueError, match="not assigned"):
        m.read(config, "test_skill", scope="agent", agent_id="test_agent")


def test_paths_symlinks_content_and_redaction(config, tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_text("private")
    root = config.paths.skills / "test_skill"
    (root / "references" / "leak.md").symlink_to(outside)
    for path in ("../../outside.txt", "/etc/passwd", "references/leak.md", "../outside.txt"):
        with pytest.raises(ValueError):
            m.read(config, "test_skill", file=path)
    notes = root / "references/notes.md"
    notes.write_text("password: tiny-secret\n" + "a" * 5)
    pieces = []
    offset = 0
    while True:
        value = m.read(config, "test_skill", file="references/notes.md", offset=offset, limit=8)
        pieces.append(value["text"])
        if value["next_offset"] is None:
            break
        offset = value["next_offset"]
    assert "tiny-secret" not in "".join(pieces)
    with pytest.raises(ValueError):
        m.manage(config, "create", "bad", revision="missing", content="not a Skill playbook")


def test_hierarchy_search_and_child_asset_edit(config):
    parent = config.paths.skills / "parent_demo"
    child = parent / "parent_demo.child"
    child.mkdir(parents=True)
    (parent / "SKILL.md").write_text(playbook("parent_demo"))
    (child / "SKILL.md").write_text(playbook("parent_demo.child", "Distinctive child evidence"))
    (child / "scripts").mkdir()
    (child / "scripts" / "run.py").write_text("print('old')\n")
    roots = m.catalog(config, scope="workspace", hierarchical=True)
    assert "parent_demo.child" not in {row["id"] for row in roots["skills"]}
    assert next(row for row in roots["skills"] if row["id"] == "parent_demo")["method_count"] == 1
    found = m.catalog(config, scope="workspace", hierarchical=True, query="Distinctive")
    # Search indexes name and description, not arbitrary playbook body.
    assert found["skills"] == []
    found = m.catalog(config, scope="workspace", hierarchical=True, query="parent_demo.child")
    assert [row["id"] for row in found["skills"]] == ["parent_demo"]
    children = m.catalog(config, scope="workspace", parent="parent_demo")
    assert [row["id"] for row in children["skills"]] == ["parent_demo.child"]
    asset = m.read(config, "parent_demo.child", file="scripts/run.py")
    assert "scripts/run.py" in asset["files"]
    result = m.manage(config, "update", "parent_demo.child", file="scripts/run.py", revision=asset["revision"], content="print('new')\n")
    assert result["applied"] is True
    assert (child / "scripts" / "run.py").read_text() == "print('new')\n"
