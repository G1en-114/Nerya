"""Offline regression tests: synthetic evidence only, never live market claims."""
import copy
import json
import subprocess
import sys
from pathlib import Path

import pytest

from nerya.agent.chart_hook import extract_chart_blocks
from nerya.charting.composer import load_chart_artifact
from nerya.core.paths import WorkspacePaths
from nerya.skills.builtin.markets.scripts.get_candles import _build_chart
from nerya.skills.builtin.research.scripts.publish_visuals import publish_visuals
from nerya.workspace.artifact_store import ArtifactStore


def fixture_payload():
    source = {"skill": "research", "action": "acceptance_fixture", "as_of": "2026-09-20T12:00:00Z", "artifact_path": "test-fixture.json"}
    instrument = {"market": "BINANCE:BTC/USDT", "venue": "binance", "name": "Bitcoin · TEST FIXTURE", "interval": "1h", "news_status": "ok", "news_as_of": source["as_of"], "news": [
        {"title": "Bitcoin evidence · TEST FIXTURE", "url": "https://example.com/test-evidence", "source": "TEST FIXTURE", "published_at": "2026-09-20T11:00:00Z"}]}
    candle = {"title": "BTC/USDT · TEST FIXTURE", "chart_kind": "candlestick", "instrument": {"market": "BTC/USDT", "venue": "binance"}, "source": source, "series": [
        {"type": "candlestick", "name": "OHLC", "data": [{"time": 1790000000 + i * 3600, "open": 100 + i, "high": 103 + i, "low": 99 + i, "close": 102 + i, "volume": 20 + i} for i in range(4)]}]}
    study = {"title": "Observed net flow · TEST FIXTURE · USD", "chart_kind": "multi", "source": source, "caption": "TEST FIXTURE: inflow minus outflow; USD", "series": [
        {"name": "Inflow · USD", "type": "line", "data": [{"time": 1790000000 + i * 3600, "value": 10 + i} for i in range(4)]},
        {"name": "Outflow · USD", "type": "line", "data": [{"time": 1790000000 + i * 3600, "value": 8 + i * 2} for i in range(4)]},
        {"name": "Net · USD", "type": "histogram", "data": [{"time": 1790000000 + i * 3600, "value": 2 - i} for i in range(4)]}]}
    return {"instruments": [instrument], "charts": [candle, study]}


@pytest.mark.parametrize("prefix", ["", "tool stdout:\n", "```json\n"])
def test_publisher_is_recognized_by_existing_agent_hook(prefix):
    result = publish_visuals(fixture_payload())
    blocks = extract_chart_blocks(prefix + json.dumps(result))
    assert len(blocks) == 2
    assert blocks[0]["instrument"]["market"] == "BINANCE:BTC/USDT"
    assert blocks[0]["research_context"]["instruments"][0]["news"][0]["source"] == "TEST FIXTURE"
    assert "instrument" not in blocks[1]
    assert result["receipt"]["chart_ids"] == [block["chart_id"] for block in blocks]


def test_bulk_survives_readback_and_can_be_republished(tmp_path):
    result = publish_visuals(fixture_payload(), tmp_path)
    assert result["receipt"]["bulk_verified"]
    store = ArtifactStore(WorkspacePaths(root=tmp_path))
    for block in result["chart_blocks"]:
        assert block["path"] == "bulk"
        assert "data" not in block["series"][0]
        artifact = load_chart_artifact(store, block["chart_id"])
        assert len(artifact["series"][0]["data"]) == 4
    again = publish_visuals({"instruments": result["research_context"]["instruments"], "chart_blocks": result["chart_blocks"]}, tmp_path)
    assert again["receipt"]["chart_ids"] == result["receipt"]["chart_ids"]
    assert len(again["research_context"]["instruments"]) == 1


def test_identity_is_snapshot_based():
    raw = fixture_payload()
    before = copy.deepcopy(raw)
    first = publish_visuals(raw)
    assert raw == before
    assert first["receipt"] == publish_visuals(raw)["receipt"]
    raw["charts"][1]["series"][0]["data"][1]["value"] += 1
    assert first["receipt"]["chart_ids"][1] != publish_visuals(raw)["receipt"]["chart_ids"][1]


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), True, None])
def test_bad_numbers_fail_without_chart_output(bad, tmp_path):
    raw = fixture_payload()
    raw["charts"][1]["series"][0]["data"][0]["value"] = bad
    with pytest.raises((ValueError, TypeError)):
        publish_visuals(raw, tmp_path)
    assert not list(tmp_path.rglob("*.json"))


@pytest.mark.parametrize("case", ["milliseconds", "duplicate", "ohlc", "source", "url", "date"])
def test_invalid_evidence_is_rejected(case):
    raw = fixture_payload()
    candle = raw["charts"][0]["series"][0]["data"]
    if case == "milliseconds": candle[0]["time"] *= 1000
    if case == "duplicate": candle[1]["time"] = candle[0]["time"]
    if case == "ohlc": candle[0]["high"] = 0
    if case == "source": raw["charts"][1]["source"] = {"skill": "research", "action": "test", "as_of": "2026-09-20T12:00:00Z"}
    if case == "url": raw["instruments"][0]["news"][0]["url"] = "javascript:alert(1)"
    if case == "date": raw["instruments"][0]["news"][0]["published_at"] = "2026-09-20"
    with pytest.raises(ValueError): publish_visuals(raw)


def test_missing_news_and_metadata_only_are_honest():
    out = publish_visuals({"instruments": [{"market": "AAPL", "news_status": "unavailable"}]})
    assert out["chart_blocks"] == []
    assert out["research_context"]["instruments"][0]["news"] == []
    assert out["research_context"]["instruments"][0]["venue"] == ""


def test_cli_emits_complete_tool_output(tmp_path):
    source = tmp_path / "input.json"
    source.write_text(json.dumps(fixture_payload()))
    proc = subprocess.run([sys.executable, "-m", "nerya.skills.builtin.research.scripts.publish_visuals", "--input", str(source), "--workspace", str(tmp_path)], capture_output=True, text=True, timeout=20)
    assert proc.returncode == 0, proc.stderr
    assert len(extract_chart_blocks(proc.stdout)) == 2
    assert json.loads(proc.stdout)["receipt"]["bulk_verified"]


def test_native_script_run_announces_every_chart_after_stdout_truncation(tmp_path):
    from nerya.agent.chart_hook import extract_chart_marker_ids
    from nerya.tools.native.skill import SkillIndex, script_run_handler
    from nerya.tools.types import ToolCall

    raw = fixture_payload()
    raw["instruments"][0]["news"] *= 10
    source = tmp_path / "native-input.json"
    source.write_text(json.dumps(raw))
    root = Path(__file__).resolve().parents[1]
    result = script_run_handler(
        ToolCall(name="script_run", arguments={"skill_id": "research", "name": "publish_visuals.py",
                 "args": ["--input", str(source), "--workspace", str(tmp_path)]}),
        skill_index=SkillIndex([root / "nerya/skills/builtin"]), cwd=tmp_path,
    )
    assert not result.is_error, result.text()
    structured = next(part.data for part in result.content if part.type == "json")
    output = structured["stdout_json"]
    assert len(json.dumps(output)) > 8000
    assert len(structured["stdout"]) == 8000
    expected = output["receipt"]["chart_ids"]
    assert set(extract_chart_marker_ids(structured["stdout"])) == set(expected)
    assert set(extract_chart_marker_ids(result.text())) == set(expected)
    from nerya.llm.tool_compaction import compact_tool_result
    compacted = compact_tool_result("script_run", structured, raw_ref="test-fixture")
    assert not compacted.skipped
    kept = compacted.kept["stdout_json"]["notes"]
    assert kept["receipt"]["chart_ids"] == expected
    assert len(kept["chart_blocks"]) == 2
    assert kept["research_context"]["instruments"][0]["news"]
    assert set(extract_chart_marker_ids(json.dumps(compacted.kept))) == set(expected)
    assert len(json.dumps(kept, ensure_ascii=False).encode()) <= 48 * 1024
    store = ArtifactStore(WorkspacePaths(root=tmp_path))
    for block in output["chart_blocks"]:
        artifact = load_chart_artifact(store, block["chart_id"])
        assert artifact["chart_kind"] == block["chart_kind"]
        assert artifact["source"] == block["source"]
        assert artifact["series"][0]["data"]


def test_market_skill_emits_explicit_identity_and_asof():
    rows = [{"ts_ms": 1790000000000, "open": 100, "high": 110, "low": 90, "close": 105, "volume": 10}]
    args = dict(market="BINANCE:BTC/USDT", venue="binance", interval="1h", ohlcv=rows, workspace=None, path="inline")
    block = _build_chart(**args)
    assert block["source"]["as_of"]
    assert block["instrument"]["market"] == args["market"]
    rows[0]["close"] = 106
    assert _build_chart(**args)["chart_id"] != block["chart_id"]


def test_skills_link_to_executable_contract():
    root = Path(__file__).resolve().parents[1] / "nerya/skills/builtin"
    for skill in ("research", "analysis", "strategy_author"):
        text = (root / skill / "SKILL.md").read_text()
        assert "visual-deliverables.md" in text
    ref = (root / "research/references/visual-deliverables.md").read_text()
    assert "publish_visuals.py" in ref and "receipt.chart_ids" in ref
