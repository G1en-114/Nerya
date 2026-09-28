"""Deterministic factor regressions. All data is synthetic, in tmp_path only."""
from __future__ import annotations

import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest

from nerya.api.route_scopes import authorize, required_scope
from nerya.api.routes_factors import routes
from nerya.core.config import Config
from nerya.core.paths import WorkspacePaths
from nerya.data.history_store import HistoryStore
from nerya.research.factors import FactorStore
from nerya.sdk.factors import calculate_factor
from nerya.skills.builtin.factor_library.scripts.evaluate import EvaluationRequest, analyze, correlation
from nerya.skills.builtin.factor_library.scripts.expressions import FactorExpression
from nerya.skills.builtin.factor_library.scripts.library import operation, strategy_factor_snapshots
from nerya.tools.native.factor_library import SCHEMA, handler
from nerya.tools.types import ToolCall

pytestmark = pytest.mark.smoke


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    import socket
    def blocked(*args, **kwargs):
        raise AssertionError("factor unit tests must never access network")
    monkeypatch.setattr(socket.socket, "connect", blocked)


@pytest.fixture
def config(tmp_path):
    return Config(paths=WorkspacePaths(tmp_path))


@pytest.fixture
def bars():
    # Engine tests only; deliberately NOT a real-history or alpha claim.
    return [{"ts": 1704067200 + i * 3600, "open": 100 + i * .03 + np.sin(i / 9) * 3,
             "close": 100 + i * .03 + np.sin(i / 9) * 3 + .15, "high": 104 + i * .03 + np.sin(i / 9) * 3,
             "low": 96 + i * .03 + np.sin(i / 9) * 3, "volume": 1000 + (i % 17) * 15} for i in range(480)]


def definition(**extra):
    return {"factor_id": "test.momentum", "name": "Synthetic test momentum", "category": "momentum",
            "expression": "close / delay(close, n) - 1", "parameters": {"n": 10}, "direction": "higher_is_bullish", **extra}


def save(config, **extra):
    return operation(config, {"action": "save", "definition": definition(**extra), "expected_version": 0, "reason": "unit test"})["factor"]


def request(**extra):
    return {"factor_id": "test.momentum", "version": 1, "market": "BINANCE:TESTUSDT", "timeframe": "1h",
            "start": "2024-01-01T00:00:00Z", "end": "2024-01-21T00:00:00Z", "instrument_type": "spot",
            "fee_bps": 5, "slippage_bps": 2, **extra}


def cache(config, bars):
    HistoryStore(config.paths.artifacts / "backtest_cache").put("BINANCE:TESTUSDT", "1h", bars, source="unit-test-only")


def test_empty_reads_do_not_create_or_seed_library(config):
    assert operation(config, {"action": "list"}) == {"ok": True, "factors": []}
    assert operation(config, {"action": "data"})["datasets"] == []
    assert not (config.paths.artifacts / "factors").exists()


def test_versions_are_immutable_and_require_fresh_read(config):
    first = save(config)
    store = FactorStore(config.paths.root)
    second = store.save(definition(parameters={"n": 20}), expected_version=1, reason="longer lookback")["factor"]
    assert first["version"] == 1 and second["version"] == 2
    assert first["lookback"] == 11 and second["lookback"] == 21
    assert store.get(first["factor_id"], 1) == first
    assert store.get(first["factor_id"]) == second
    with pytest.raises(ValueError, match="version conflict"):
        store.save(definition(), expected_version=1, reason="stale edit")
    assert len(store.detail(first["factor_id"])["versions"]) == 2


def test_concurrent_edits_have_exactly_one_winner(config):
    save(config)
    def edit(i):
        try:
            FactorStore(config.paths.root).save(definition(name=f"revision {i}"), expected_version=1, reason="race test")
            return True
        except ValueError:
            return False
    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sum(executor.map(edit, [1, 2])) == 1


def test_dedup_and_no_automatic_validated_or_production(config):
    save(config)
    result = operation(config, {"action": "save", "definition": definition(factor_id="copy.factor"), "expected_version": 0, "reason": "test duplicate"})
    assert result["duplicates"] == ["test.momentum"]
    assert result["factor"]["status"] == "candidate"
    for status in ("validated", "production"):
        with pytest.raises(ValueError):
            save(config, factor_id=f"bad.{status}", status=status)


@pytest.mark.parametrize("expression", ["__import__('os').system('true')", "close.shift(-1)", "delay(close,-1)",
    "sma(close,0)", "close[-1]", "close.mean()", "open.__class__", "sum(close)", "1 + 2", "close ** 999999", "lambda:close"])
def test_unsafe_or_noncausal_expressions_rejected(expression):
    with pytest.raises(ValueError):
        FactorExpression(expression)


@pytest.mark.parametrize("expression", ["close / delay(close,n) - 1", "zscore(volume,n)", "ema(close,n) - sma(close,n)",
    "std(close,n)", "ts_max(high,n) - ts_min(low,n)", "log(close) + abs(delta(close,n))"])
def test_formula_outputs_are_prefix_invariant(bars, expression):
    engine = FactorExpression(expression, {"n": 10})
    frame = pd.DataFrame(bars)
    pd.testing.assert_series_equal(engine.calculate(frame).iloc[:120], engine.calculate(frame.iloc[:120]))


def test_warmup_and_zero_divisions_remain_missing(bars):
    frame = pd.DataFrame(bars)
    result = FactorExpression("close/delay(close,n)-1", {"n": 10}).calculate(frame)
    assert result.iloc[:10].isna().all()
    assert result.iloc[10] == pytest.approx(frame.close.iloc[10] / frame.close.iloc[0] - 1)
    assert FactorExpression("close / (volume - volume)").calculate(frame).isna().all()
    assert FactorExpression("log(-close)").calculate(frame).isna().all()


def test_ema_does_not_fill_undefined_inputs(bars):
    frame = pd.DataFrame(bars)
    frame.loc[120, "volume"] = 0
    engine = FactorExpression("ema(close / volume, n)", {"n": 10})
    values = engine.calculate(frame)
    assert pd.notna(values.iloc[119])
    assert pd.isna(values.iloc[120])
    assert pd.notna(values.iloc[121])
    pd.testing.assert_series_equal(values.iloc[:130], engine.calculate(frame.iloc[:130]))


@pytest.mark.parametrize("invalid", [True, "1", 1.0])
def test_version_pins_do_not_coerce_types(config, invalid):
    save(config)
    with pytest.raises(ValueError, match="integer"):
        FactorStore(config.paths.root).get("test.momentum", invalid)
    with pytest.raises(ValueError):
        EvaluationRequest(**request(version=invalid))
    with pytest.raises(ValueError):
        FactorStore(config.paths.root).save(definition(), expected_version=invalid, reason="bad version")


@pytest.mark.parametrize("invalid", [True, "10"])
def test_factor_parameters_do_not_coerce_types(config, invalid):
    with pytest.raises(ValueError):
        save(config, parameters={"n": invalid})


def test_sdk_matches_expression_and_rejects_bad_timestamps(bars):
    snapshot = definition()
    result = calculate_factor(snapshot, bars)
    assert result[:10] == [None] * 10
    assert result[25] == pytest.approx(bars[25]["close"] / bars[15]["close"] - 1)
    with pytest.raises(ValueError, match="increasing"):
        calculate_factor(snapshot, list(reversed(bars)))
    with pytest.raises(ValueError):
        calculate_factor(snapshot, [bars[0], bars[0]])


def test_train_thresholds_and_labels_never_use_test_prices(bars):
    factor = definition()
    req = EvaluationRequest(**request())
    frame = pd.DataFrame(bars)
    original = analyze(frame, factor, req)
    split = int(len(frame) * .7)
    mutated = frame.copy()
    mutated.loc[split:, ["open", "high", "low", "close"]] *= 100
    changed = analyze(mutated, factor, req)
    assert original["in_sample"] == changed["in_sample"]
    assert original["quantile_edges"] == changed["quantile_edges"]
    assert original["split"]["purge_bars"] == 6
    assert original["split"]["train_samples"] == split - 6 - 10


def test_rank_correlation_handles_ties_without_faking_zeros():
    assert correlation(pd.Series([1,1,2,4]), pd.Series([4,4,3,1]), rank=True) == pytest.approx(-1)
    assert correlation(pd.Series([1,1,1]), pd.Series([1,2,3])) is None


def test_completed_evaluation_has_immutable_data_and_explicit_scope(config, bars):
    first = save(config)
    cache(config, bars)
    result = operation(config, {"action": "evaluate", **request(instrument_type="perpetual")})
    assert result["ok"], result
    run = result["run"]
    assert run["factor_snapshot"]["definition_hash"] == first["definition_hash"]
    assert run["analysis"]["performance_evidence"] is False
    assert run["analysis"]["validation_status"] == "research_only"
    assert any("Funding" in warning for warning in run["analysis"]["warnings"])
    assert "walk_forward" in run["analysis"]["pending_checks"]
    out = run["analysis"]["out_of_sample"]
    assert out["favored_bucket_mean_bps"] - out["fee_slippage_adjusted_mean_bps"] == pytest.approx(14)
    assert out["favored_bucket_mean_bps"] - out["double_cost_mean_bps"] == pytest.approx(28)
    snapshot = config.paths.root / run["data"]["snapshot"]
    before = snapshot.read_bytes()
    assert hashlib.sha256(before).hexdigest() == run["data"]["snapshot_sha256"]
    cache(config, [{**row, "volume": row["volume"] + 1} for row in bars])
    assert snapshot.read_bytes() == before
    assert json.loads((config.paths.root / run["manifest_path"]).read_text()) == run
    store = FactorStore(config.paths.root)
    store.save(definition(parameters={"n": 15}), expected_version=1, reason="next revision")
    assert store.detail(first["factor_id"], 2)["runs"] == []
    assert store.detail(first["factor_id"], 1)["runs"][0]["run_id"] == run["run_id"]


def test_incomplete_data_persists_blocked_run_instead_of_metrics(config, bars):
    save(config)
    cache(config, bars[1:])
    result = operation(config, {"action": "evaluate", **request()})
    assert not result["ok"]
    assert result["run"]["status"] == "blocked"
    assert "1 missing bars" in result["run"]["error"]
    assert "analysis" not in result["run"]
    assert FactorStore(config.paths.root).detail("test.momentum")["runs"][0]["status"] == "blocked"


def test_market_mismatch_is_recorded_and_no_silent_substitution(config, bars):
    save(config, markets=["BINANCE:OTHERUSDT"])
    cache(config, bars)
    result = operation(config, {"action":"evaluate", **request()})
    assert not result["ok"] and "applicability" in result["run"]["error"]


def test_comparison_pins_both_versions(config, bars):
    save(config)
    save(config, factor_id="other.factor", expression="zscore(volume,n)")
    cache(config, bars)
    result = operation(config, {"action":"evaluate", **request(compare=[{"factor_id":"other.factor","version":1}])})
    assert result["ok"], result
    comparison = result["run"]["analysis"]["comparisons"][0]
    assert comparison["factor_snapshot"]["version"] == 1
    assert comparison["rank_correlation"] is not None


def test_failed_comparison_keeps_record_without_completed_metrics(config, bars):
    save(config)
    cache(config, bars)
    result = operation(config, {"action":"evaluate", **request(compare=[{"factor_id":"missing.factor","version":1}])})
    assert not result["ok"]
    assert result["run"]["status"] == "blocked"
    assert "analysis" not in result["run"]
    assert FactorStore(config.paths.root).detail("test.momentum")["runs"][0] == result["run"]


def test_extraction_provenance_survives_new_source_revision(config):
    store = FactorStore(config.paths.root)
    original = {"strategy_id":"baseline", "ts":"20240121_000000", "proposal_id":None}
    revised = {"strategy_id":"revision", "ts":"20240122_000000", "proposal_id":None}
    first = store.save(definition(), expected_version=0, reason="initial extraction", source_backtest=original)["factor"]
    second = store.save(definition(parameters={"n":20}), expected_version=1, reason="new source", source_backtest=revised)["factor"]
    assert store.sourced_from(original) == [first]
    assert store.sourced_from(revised) == [second]


def test_missing_frozen_source_never_suggests_using_current_source(config):
    root = config.paths.strategies / "legacy"
    run = root / "backtests" / "20240121_000000"
    run.mkdir(parents=True)
    (run / "metrics.json").write_text("{}")
    (root / "main.py").write_text("# not the original source")
    result = operation(config, {"action":"extract", "strategy_id":"legacy", "ts":"20240121_000000"})
    assert result["source_available"] is False
    assert result["source_files"] == {}
    assert "Do not reconstruct" in result["next_action"]


def test_export_and_replay_pin_validation(config):
    factor = save(config)
    output = operation(config, {"action":"export", "factor_id":factor["factor_id"], "version":1})
    assert strategy_factor_snapshots(config, output["files"]) == [factor]
    with pytest.raises(ValueError):
        operation(config, {"action":"export", "factor_id":factor["factor_id"]})
    with pytest.raises(ValueError, match="mismatch"):
        strategy_factor_snapshots(config, {"factors.json":json.dumps([{**factor,"expression":"volume"}])})
    assert strategy_factor_snapshots(config, {"main.py":"pass"}) == []


def test_source_extraction_reads_frozen_source_not_current_strategy(config):
    factor = save(config)
    root = config.paths.strategies / "source_test"
    run = root / "backtests" / "20240121_000000"
    frozen = run / "source" / "source_test"
    frozen.mkdir(parents=True)
    (frozen / "main.py").write_text("# frozen\nvalue = 'old'\n")
    (root / "main.py").write_text("# current\nvalue = 'new'\n")
    (run / "metrics.json").write_text(json.dumps({"provenance":{"source_revision":"abc","data_kind":"sample"}}))
    (run / "factor_snapshot.json").write_text(json.dumps([factor]))
    identity = {"strategy_id":"source_test", "ts":"20240121_000000"}
    output = operation(config, {"action":"extract", **identity})
    assert output["source_files"]["main.py"].startswith("# frozen")
    assert output["source_backtest"]["data_kind"] == "sample"
    assert output["used_factors"] == [factor] and output["extracted_factors"] == []
    operation(config, {"action":"save", "definition":definition(factor_id="extracted.factor"), "expected_version":0,"reason":"extract test", "source_backtest":identity})
    after = operation(config, {"action":"backtest", **identity})
    assert after["used_factors"] == [factor]
    assert after["extracted_factors"][0]["factor_id"] == "extracted.factor"
    for ts in ("../20240121_000000", "/tmp", "a/b"):
        with pytest.raises(ValueError):
            operation(config, {"action":"backtest", **identity, "ts":ts})


def test_factor_storage_rejects_symlink_parents(config, tmp_path):
    (tmp_path / "elsewhere").mkdir()
    config.paths.artifacts.mkdir()
    (config.paths.artifacts / "factors").symlink_to(tmp_path / "elsewhere")
    with pytest.raises(ValueError, match="symlink"):
        save(config)


def test_read_route_cannot_smuggle_write_action(config):
    mapping = {(verb,path):handle for verb,path,handle in routes()}
    result = mapping[("GET","/factors/list")](SimpleNamespace(config=config), {"action":"save", "definition":definition()})
    assert result == {"ok":True,"factors":[]}
    assert required_scope("POST","/factors/save") == "write:tools"
    assert authorize(["read:runtime"],"POST","/factors/evaluate")[0] is False
    assert authorize(["read:runtime"],"GET","/factors/get")[0] is True


def test_native_tool_and_http_share_contract(config):
    import jsonschema
    jsonschema.Draft202012Validator.check_schema(SCHEMA)
    result = handler(ToolCall(name="factor_library", arguments={"action":"list"}), config=config)
    assert result.content[0].data["factors"] == []
    failed = handler(ToolCall(name="factor_library", arguments={"action":"save"}), config=config)
    assert failed.content[0].data["ok"] is False


def test_native_backtest_freezes_declared_factor_version(config):
    from nerya.evolution.strategy_code_generator import StrategyCodeGenerator, StrategyGenerationRequest
    from nerya.skills.builtin.backtest.scripts.backtest_run import run_strategy_backtest
    factor = save(config)
    exported = operation(config, {"action":"export", "factor_id":factor["factor_id"],"version":1})
    generated = StrategyCodeGenerator(config.paths).generate(StrategyGenerationRequest(
        strategy_id="factor_pin_fixture", title="Factor pin test", prompt="Isolated factor snapshot regression",
        markets=("MOCK:BTCUSDT",), accounts=("paper_main",), schedule_cron="*/5 * * * *",
        files={"main.py":"def run(ctx):\n    return ctx.result.hold(reason='factor snapshot test')\n", **exported["files"]}),
        validate=True, create_proposal_record=True)
    assert generated.proposal
    result = run_strategy_backtest(proposal_id=generated.proposal.id, workspace=config.paths.root,
                                   allow_mock=True, settings={"window_days":7,"warmup_bars":20})
    assert result["ok"], result
    metrics = json.loads(Path(result["metrics_path"]).read_text())
    assert metrics["factor_refs"][0]["definition_hash"] == factor["definition_hash"]
    frozen = json.loads((Path(result["metrics_path"]).parent / "factor_snapshot.json").read_text())
    assert frozen == [factor]
    FactorStore(config.paths.root).save(definition(parameters={"n":30}), expected_version=1, reason="edited after replay")
    context = operation(config, {"action":"backtest", "strategy_id":"factor_pin_fixture", "ts":result["backtest_ts"], "proposal_id":generated.proposal.id})
    assert context["used_factors"] == [factor]
