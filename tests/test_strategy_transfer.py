"""Offline tests: portable source, no execution and no active workspace writes."""
from __future__ import annotations

import copy
import json
from types import SimpleNamespace

import pytest

from nerya.api.route_scopes import required_scope
from nerya.api.routes_strategies_runtime import routes
from nerya.core import yaml_io
from nerya.core.paths import WorkspacePaths
from nerya.evolution.patch_proposal import list_proposals
from nerya.strategies.workflow_graph import MAX_FILE_BYTES, WorkflowError
from nerya.strategies.workflow_service import propose_workflow, source_files
from nerya.strategies.workflow_templates import create_workflow_template
from nerya.strategies.workflow_transfer import export_workflow, import_workflow

pytestmark = pytest.mark.smoke


@pytest.fixture
def source(tmp_path):
    paths = WorkspacePaths(tmp_path)
    out = create_workflow_template(paths, {"template": "multi_script", "strategy_id": "portable_test",
        "markets": ["BINANCE:BTCUSDT"], "accounts": ["paper_main"]})
    assert out["ok"], out
    exported = export_workflow(paths, out["strategy_id"], out["proposal_id"])
    return paths, out, exported["bundle"]


def test_export_import_edit_export_round_trip(source):
    paths, original, bundle = source
    before = copy.deepcopy(bundle)
    bundle["files"]["notes.md"] = "# 中文策略\nKeep prompts and source exactly.\n"
    bundle["files"]["config.yml"] = "threshold: 0.3\n"
    imported = import_workflow(paths, {"bundle": bundle, "strategy_id": "portable_copy"})
    assert imported["ok"], imported
    assert imported["state"] == "pending_review"
    assert imported["validation"]["static_only"] is True
    assert not paths.strategy("portable_copy").exists()
    assert not paths.triggers_schedules_file.exists()
    files = source_files(paths, "portable_copy", imported["proposal_id"])[0]
    for name, text in bundle["files"].items():
        if name != "strategy.yml":
            assert files[name] == text
    assert export_workflow(paths, original["strategy_id"], original["proposal_id"])["bundle"] == before
    edited = propose_workflow(paths, {"strategy_id": "portable_copy", "proposal_id": imported["proposal_id"],
        "base_revision": imported["workflow"]["revision"], "changes": [
            {"node_id": "strategy:portable_copy", "config": {"title": "修改后策略", "description": "Saved through review"}},
            {"node_id": "script:signals.py", "content": files["signals.py"] + "\n# local edit\n"},
        ]})
    assert edited["ok"], edited
    reexported = export_workflow(paths, "portable_copy", edited["proposal_id"], base_revision=edited["workflow"]["revision"])
    assert reexported["bundle"]["title"] == "修改后策略"
    assert reexported["bundle"]["files"]["signals.py"].endswith("# local edit\n")
    assert source_files(paths, "portable_copy", imported["proposal_id"])[0] == files


def test_live_bundle_becomes_inert_paper_proposal(source):
    paths, _, bundle = source
    manifest = yaml_io.loads(bundle["files"]["strategy.yml"])
    manifest["mode"] = "live"
    manifest["schedule"]["enabled"] = True
    manifest["tuning"]["schedule"]["enabled"] = True
    manifest["tuning"]["guardrails"]["require_operator_approval"] = False
    bundle["files"]["strategy.yml"] = yaml_io.dumps(manifest)
    result = import_workflow(paths, {"bundle": bundle})
    assert result["ok"], result
    imported = result["workflow"]["manifest"]
    assert imported["mode"] == "paper"
    assert imported["schedule"]["enabled"] is False
    assert imported["tuning"]["schedule"]["enabled"] is False
    assert imported["tuning"]["guardrails"]["require_operator_approval"] is True
    assert imported["accounts"] == manifest["accounts"]
    assert not paths.strategy(result["strategy_id"]).exists()
    assert not paths.triggers_schedules_file.exists()


def test_import_and_edit_do_not_execute_uploaded_source(source, monkeypatch):
    from nerya.strategies import validator
    paths, _, bundle = source
    def never_execute(*args, **kwargs):
        pytest.fail("An authoring request executed untrusted strategy code")
    monkeypatch.setattr(validator, "_smoke_test_import", never_execute)
    bundle["files"]["main.py"] += '\nraise RuntimeError("must not run during import")\n'
    result = import_workflow(paths, {"bundle": bundle})
    assert result["ok"], result
    edited = propose_workflow(paths, {"strategy_id": result["strategy_id"], "proposal_id": result["proposal_id"],
        "base_revision": result["workflow"]["revision"], "changes": [
            {"node_id": f"strategy:{result['strategy_id']}", "config": {"title": "Safe edit"}},
        ]})
    assert edited["ok"], edited


@pytest.mark.parametrize("name", ["../escape.py", "/tmp/escape.py", "nested/../../escape.py", "C:/escape.py",
    "nested\\escape.py", "nested/./escape.py", "runs/private.json", "vault/key.json", "subagents/.env",
    "secrets.yml", "credentials.json", "nested/Accounts/account.json", "nested/file\x00.py", "binary.zip"])
def test_unsafe_paths_rejected_without_proposal(source, name):
    paths, _, bundle = source
    bundle["files"][name] = "{}"
    with pytest.raises(WorkflowError):
        import_workflow(paths, {"bundle": bundle})
    assert len(list_proposals(paths)) == 1


def test_conflicts_do_not_overwrite_active_or_candidate(source):
    paths, original, bundle = source
    with pytest.raises(WorkflowError, match="strategy_id_conflict"):
        import_workflow(paths, {"bundle": bundle, "strategy_id": original["strategy_id"]})
    target = paths.strategy("existing")
    target.mkdir(parents=True)
    (target / "keep.txt").write_text("untouched")
    with pytest.raises(WorkflowError, match="strategy_id_conflict"):
        import_workflow(paths, {"bundle": bundle, "strategy_id": "existing"})
    assert (target / "keep.txt").read_text() == "untouched"
    assert len(list_proposals(paths)) == 1


@pytest.mark.parametrize("value", [None, [], {"format": "other", "version": 1},
    {"format": "nerya.strategy", "version": True}, {"format": "nerya.strategy", "version": 2}])
def test_invalid_format(source, value):
    with pytest.raises(WorkflowError):
        import_workflow(source[0], {"bundle": value})


def test_size_type_and_case_collisions(source):
    paths, _, bundle = source
    for extra in [{"huge.md": "x" * (MAX_FILE_BYTES + 1)}, {"bad.md": 12}, {"Main.py": "pass"}]:
        with pytest.raises(WorkflowError):
            import_workflow(paths, {"bundle": {**bundle, "files": {**bundle["files"], **extra}}})
    with pytest.raises(WorkflowError):
        import_workflow(paths, {"bundle": bundle, "strategy_id": "../bad"})


@pytest.mark.parametrize("name,text", [("config.yml", "api_key: plaintext-value\n"),
    ("helper.py", 'PRIVATE_KEY = "not-a-vault-reference"\n'), ("notes.md", "sk-proj-" + "a1" * 20)])
def test_secret_content_is_rejected_without_echoing_it(source, name, text):
    paths, _, bundle = source
    bundle["files"][name] = text
    with pytest.raises(WorkflowError, match="credential") as error:
        import_workflow(paths, {"bundle": bundle})
    assert text.strip() not in str(error.value)
    assert len(list_proposals(paths)) == 1


def test_export_excludes_runtime_and_refuses_partial_source(source):
    paths, original, _ = source
    root = paths.proposals / original["proposal_id"] / "after" / "strategies" / original["strategy_id"]
    for name in ("runs/output.json", "accounts/account.json", ".env"):
        file = root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text("private runtime data")
    exported = export_workflow(paths, original["strategy_id"], original["proposal_id"])
    assert all(name not in exported["bundle"]["files"] for name in ("runs/output.json", "accounts/account.json", ".env"))
    with pytest.raises(WorkflowError, match="revision_conflict"):
        export_workflow(paths, original["strategy_id"], original["proposal_id"], base_revision="old")
    (root / "huge.py").write_text("#" * (MAX_FILE_BYTES + 1))
    with pytest.raises(WorkflowError, match="Export refused"):
        export_workflow(paths, original["strategy_id"], original["proposal_id"])


def test_workflow_metadata_is_remapped(source):
    paths, _, bundle = source
    bundle["files"]["workflow.json"] = json.dumps({"version": 1, "nodes": {
        "strategy:portable_test": {"position": {"x": 20, "y": 50}, "description": "Layout"}}, "edges": []})
    result = import_workflow(paths, {"bundle": bundle, "strategy_id": "remapped"})
    assert result["ok"], result
    assert result["workflow"]["metadata"]["nodes"]["strategy:remapped"]["position"] == {"x": 20, "y": 50}


@pytest.mark.parametrize("name,text", [("strategy.yml", "title: [unterminated"), ("config.json", "{invalid")])
def test_malformed_structured_files_return_controlled_errors(source, name, text):
    paths, _, bundle = source
    bundle["files"][name] = text
    with pytest.raises(WorkflowError, match="Invalid structured source"):
        import_workflow(paths, {"bundle": bundle})
    assert len(list_proposals(paths)) == 1


def test_conflicting_file_directory_paths_rejected(source):
    paths, _, bundle = source
    bundle["files"].update({"nested.py": "pass", "nested.py/helper.py": "pass"})
    with pytest.raises(WorkflowError, match="conflicting file and directory"):
        import_workflow(paths, {"bundle": bundle})
    assert len(list_proposals(paths)) == 1


def test_legacy_strategy_round_trip(tmp_path):
    paths = WorkspacePaths(tmp_path)
    root = paths.strategy("legacy")
    root.mkdir(parents=True)
    (root / "strategy.yml").write_text(yaml_io.dumps({"id": "legacy", "title": "Legacy", "driver": "prompt", "account_id": "paper_main", "markets": ["BINANCE:BTCUSDT"]}))
    (root / "agent.md").write_text("# Local prompt\nReview only.\n")
    exported = export_workflow(paths, "legacy")
    result = import_workflow(paths, {"bundle": exported["bundle"], "strategy_id": "legacy_copy"})
    assert result["ok"] and result["workflow"]["legacy"]
    assert result["workflow"]["manifest"]["id"] == "legacy_copy"
    assert not paths.strategy("legacy_copy").exists()
    assert export_workflow(paths, "legacy_copy", result["proposal_id"])["bundle"]["files"]["agent.md"] == (root / "agent.md").read_text()


def test_symlinked_source_cannot_be_exported(source):
    paths, original, _ = source
    root = paths.proposals / original["proposal_id"] / "after" / "strategies" / original["strategy_id"]
    (root / "linked.py").symlink_to(root / "main.py")
    with pytest.raises(WorkflowError, match="Export refused"):
        export_workflow(paths, original["strategy_id"], original["proposal_id"])


def test_routes_and_scopes(source):
    paths, original, bundle = source
    handlers = {(method, path): handler for method, path, handler in routes()}
    client = SimpleNamespace(config=SimpleNamespace(paths=paths))
    export_path = "/strategies/runtime/workflow/export"
    import_path = "/strategies/runtime/workflow/import"
    assert required_scope("GET", export_path) == "read:runtime"
    assert required_scope("POST", import_path) == "write:config"
    assert handlers["GET", export_path](client, {"strategy_id": original["strategy_id"], "proposal_id": original["proposal_id"]})["ok"]
    assert handlers["POST", import_path](client, {"bundle": bundle})["ok"]
    assert handlers["POST", import_path](client, {"bundle": {}})["ok"] is False
