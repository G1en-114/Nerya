"""Research guidance and evidence transport, not empirical alpha claims."""
import json
import re
from pathlib import Path

import pytest

from nerya.llm.tool_compaction import compact_tool_result
from nerya.skills.manifest import SkillManifest

pytestmark = pytest.mark.smoke
BUILTIN = Path(__file__).resolve().parents[1] / "nerya/skills/builtin"


def test_research_guidance_is_lazy_and_does_not_invent_executable_audits():
    root = BUILTIN / "backtest"
    manifest = SkillManifest.from_skill_md(root / "SKILL.md")
    assert manifest.id == "backtest"
    entry = (root / "SKILL.md").read_text()
    assert "one native call" in entry and "only when requested" in entry
    for name in ("causality-audit.md", "research-validation.md"):
        assert f"references/{name}" in entry
        assert (root / "references" / name).is_file()
    causality = (root / "references/causality-audit.md").read_text()
    assert "no native dynamic-lookahead or recursive-audit action" in causality
    assert "inconclusive/nondeterminism" in causality
    assert "forced liquidation" in causality and "unexercised branches" in causality
    research = (root / "references/research-validation.md").read_text()
    assert "no enforced holdout lock" in research
    assert "not_run" in research and "data hashes" in research
    assert "do NOT implement" in research and "latency-bars" in research


def test_related_skills_route_to_one_shared_research_contract():
    for name in ("quant_research", "factor_library"):
        text = (BUILTIN / name / "SKILL.md").read_text()
        assert 'Skill(skill="backtest", file="references/research-validation.md")' in text
        assert 'Skill(skill="backtest", file="references/causality-audit.md")' in text


def test_factor_governance_reuses_native_schema_and_does_not_invent_lifecycle_actions():
    from pydantic import ValidationError
    from nerya.research.factors import FactorDefinition

    root = BUILTIN / "factor_library"
    entry = (root / "SKILL.md").read_text()
    assert "references/factor-governance.md" in entry
    governance = (root / "references/factor-governance.md").read_text()
    examples = re.findall(r"```json\n(.*?)\n```", governance, re.DOTALL)
    assert examples
    for example in examples:
        definition = json.loads(example)
        assert FactorDefinition.model_validate(definition).status == "candidate"
        for unsupported in ("validated", "production", "degraded"):
            with pytest.raises(ValidationError):
                FactorDefinition.model_validate({**definition, "status": unsupported})
    assert "fingerprints; it is not statistical correlation deduplication" in governance
    assert "no new pipeline config files" in governance
    assert "no enforced holdout lock" in governance
    assert 'Skill(skill="backtest", file="references/research-validation.md")' in governance
    assert not (BUILTIN / "quant_factor_library").exists()


def test_tool_compaction_keeps_negative_evidence_and_model_limits():
    bias = {"static_temporal_scan": "passed", "static_warnings": [
        {"code": "lookahead_dynamic_shift", "file": "main.py", "line": 6,
         "message": "Direction requires review"}], "historical_prefix_only": True}
    research = {"version": 1, "scope": "this_run_only", "checks": [
        {"id": key, "status": "not_run"} for key in ("dynamic_lookahead", "warmup_stability",
            "out_of_sample", "walk_forward", "cost_stress", "parameter_sensitivity", "ablation")]}
    result = compact_tool_result("strategy_backtest", {"ok": True,
        "result_type": "backtest_result", "strategy_id": "fixture", "backtest_ts": "20260928_000000",
        "bias_checks": bias, "research_checks": research,
        "provenance": {"assumptions": {"execution_model_limits": {"funding": "not_modeled"}}},
        "padding": "x" * 20000}, size_threshold=0)
    assert result.kept["bias_checks"] == bias
    assert result.kept["research_checks"] == research
    assert result.kept["provenance"]["assumptions"]["execution_model_limits"]["funding"] == "not_modeled"
