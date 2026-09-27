import ast

import pytest

from nerya.core.paths import WorkspacePaths
from nerya.evolution.strategy_code_generator import StrategyCodeGenerator, StrategyGenerationRequest
from nerya.strategies.documentation import documentation_errors
from nerya.strategies.validator import validate_proposal_files
from nerya.strategies.workflow_templates import create_workflow_template

pytestmark = pytest.mark.smoke


@pytest.mark.parametrize("strategy_class", ["scalping", "trend", "news", "agent", "agent_team"])
def test_generated_source_has_valid_documentation_without_changing_python(tmp_path, strategy_class):
    req = StrategyGenerationRequest(strategy_id="explained_strategy", strategy_class=strategy_class, markets=("binance:BTCUSDT",), accounts=("paper_main",))
    result = StrategyCodeGenerator(WorkspacePaths(tmp_path)).generate(req, validate=True, create_proposal_record=False)
    source = result.files["main.py"]
    assert result.validation.ok
    assert "# @nerya.version 1" in source
    assert documentation_errors(source) == []
    without_comments = "\n".join(line for line in source.splitlines() if not line.lstrip().startswith("# @nerya."))
    assert ast.dump(ast.parse(source)) == ast.dump(ast.parse(without_comments))


def test_invalid_opt_in_documentation_blocks_candidate_but_legacy_and_quoted_examples_do_not(tmp_path):
    req = StrategyGenerationRequest(strategy_id="explained_strategy", markets=("binance:BTCUSDT",), accounts=("paper_main",))
    files = StrategyCodeGenerator(WorkspacePaths(tmp_path)).generate(req, create_proposal_record=False).files
    files["main.py"] += "\n# @nerya.next missing | bad branch\n# @nerya.step evaluate | Duplicate\n"
    result = validate_proposal_files(strategy_id=req.strategy_id, files=files, smoke_test=False)
    assert not result.ok
    assert any(issue.code == "script_documentation_invalid" for issue in result.blockers)
    assert documentation_errors("# old script\ndef run(ctx): pass\n") == []
    assert documentation_errors('example = """\n# @nerya.version 1\n"""\n') == []
    assert documentation_errors("# @nerya.version 1\n")


@pytest.mark.parametrize("template", ["multi_script", "script_agent", "scheduler_agent"])
def test_workflow_examples_explain_every_script(tmp_path, template):
    result = create_workflow_template(WorkspacePaths(tmp_path), {"template": template, "accounts": ["paper_main"], "markets": ["binance:BTCUSDT"]})
    assert result["ok"], result
    scripts = [node for node in result["workflow"]["strategy"]["nodes"] if node["kind"] == "script"]
    assert scripts
    for node in scripts:
        assert "# @nerya.version 1" in node["content"]
        assert documentation_errors(node["content"]) == []


def test_timeline_preserves_explanation_when_source_preview_is_truncated():
    from nerya.evolution.timeline import _inline_json_artifact

    source = "print('source-only')" * 5000
    output = {"summary": "Skip incomplete signals", "proposed_changes": [{"file": "main.py", "rationale": "Missing inputs", "before_summary": "Always dispatch", "after_summary": "Skip empty inputs", "scope": ["Signal gate"], "after_content": source}], "expected_effect": {"return": 0, "verified": False}}
    artifact = _inline_json_artifact("output", "Subagent output", output, kind="output")
    assert artifact["truncated"]
    explanation = artifact["metadata"]["review_explanation"]
    assert explanation["proposed_changes"][0]["rationale"] == "Missing inputs"
    assert "after_content" not in explanation["proposed_changes"][0]
    assert explanation["expected_effect"] == {"return": 0, "verified": False}


def test_colon_header_separator_matches_the_plain_annotation_contract(tmp_path):
    req=StrategyGenerationRequest(strategy_id="colon_docs", markets=("binance:BTCUSDT",),accounts=("paper_main",))
    source=StrategyCodeGenerator(WorkspacePaths(tmp_path)).generate(req,create_proposal_record=False).files["main.py"]
    source=source.replace("# @nerya.title ","# @nerya.title: ")
    assert documentation_errors(source)==[]
