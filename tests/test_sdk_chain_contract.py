"""Regression contracts for one-prompt authoring; prices here are fixtures."""
from __future__ import annotations

import pytest
import json

from nerya.llm.tool_compaction import compact_tool_result
from nerya.skills.builtin.backtest.scripts.config import load_config
from nerya.skills.builtin.backtest.scripts.engine import _views_from_strategy_config
from nerya.strategies.context import StrategyConfig
from nerya.skills.builtin.backtest.scripts.mock_ctx import MockMarket, BacktestUnsupportedSurfaceError
from nerya.data.features import compute_features

pytestmark = pytest.mark.smoke


def test_live_and_replay_configuration_share_explicit_parameters():
    extras = {"params": {"threshold": 73, "enabled": False, "zero": 0}, "timeframe": "4h"}
    live = StrategyConfig(strategy_id="config_contract", title="test", mode="paper",
                          markets=("BINANCE:BTCUSDT",), accounts=(), news_sources=(), extras=extras)
    replay, _ = _views_from_strategy_config("config_contract", load_config(markets=list(live.markets)),
                                            {"strategy_id": live.strategy_id, "extras": extras})
    for view in (live, replay):
        assert view.params == extras["params"]
        assert view.timeframe == "4h"
        assert view.get("params") == extras["params"]
        assert view["timeframe"] == "4h"
        assert view.get("missing", 19) == 19
        assert view.params["enabled"] is False
        assert view.params["zero"] == 0
        copy = view.params
        copy["threshold"] = 1
        assert view.params["threshold"] == 73
        assert view.get("__dict__") is None
        with pytest.raises(KeyError):
            view["missing"]


@pytest.mark.parametrize("count", [10, 50])
def test_compaction_retains_whole_ranked_universe(count):
    ids = [f"BINANCE:ASSET{i}USDT" for i in range(count)]
    output = {"ok": True, "rank_by": "market_cap", "venue": "binance", "quote": "USDT",
              "count": count, "requested_count": count, "market_ids": ids,
              "venue_mapping_complete": True, "needs_symbol_validation": False,
              "markets": [{"market": m, "rank": i + 1, "symbol": f"ASSET{i}"} for i, m in enumerate(ids)],
              "source": "test", "fetched_at": "2026-09-27T00:00:00Z", "padding": "x" * 4096}
    result = compact_tool_result("market_data", output)
    assert result.kept["market_ids"] == ids
    assert len(result.kept["markets"]) == count
    assert result.kept["venue_mapping_complete"] is True
    assert result.kept["needs_symbol_validation"] is False
    assert result.kept["count"] == count


def test_backtest_compaction_preserves_all_execution_evidence():
    replay = {"decisions": 21900, "status_counts": {"hold": 21000, "submitted": 900},
              "errors": 0, "reason_counts": {f"hold_{i}": i for i in range(100)},
              "order_attempts": 900, "orders_submitted": 900, "orders_filled": 884,
              "orders_rejected": 16, "sdk_errors": 0, "forced_closes": 4,
              "rejection_reasons": {"insufficient_cash": 16}, "order_accounting_ok": True}
    result = compact_tool_result("strategy_backtest", {"result_type": "backtest", "replay": replay,
                                                        "markets": [f"BINANCE:X{i}" for i in range(10)]}, size_threshold=0)
    for key in ("order_attempts", "orders_submitted", "orders_filled", "orders_rejected",
                "sdk_errors", "forced_closes", "order_accounting_ok", "rejection_reasons"):
        assert result.kept["replay"][key] == replay[key]


def test_replay_features_include_the_live_sdk_indicators():
    rows = [{"ts": 1700000000+i*3600, "open": 100+i, "high": 103+i,
             "low": 98+i, "close": 101+i, "volume": 10+i} for i in range(60)]
    market = MockMarket("BINANCE:BTCUSDT", {"BINANCE:BTCUSDT": rows}, primary_timeframe="1h")
    result = market.features("BINANCE:BTCUSDT", timeframe="1h", lookback=60)
    for key, value in compute_features(rows).items():
        assert result[key] == value
    returned = market.candles("BINANCE:BTCUSDT", timeframe="1h")
    returned[-1]["close"] = 1
    assert market.mark_price("BINANCE:BTCUSDT") == 160
    ticker = market.ticker("BINANCE:BTCUSDT")
    assert ticker["last"] == ticker["mid"] == 160
    assert ticker["bid"] is None and ticker["ask"] is None
    assert ticker["source"] == "historical_bar_close"


def test_timeframe_availability_is_checked_for_the_requested_market():
    candle = {"ts": 1700000000, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 1}
    market = MockMarket("BINANCE:BTCUSDT", {"BINANCE:ETHUSDT": [candle]},
                        {"BINANCE:BTCUSDT": {"4h": [candle]}}, primary_timeframe="1h")
    with pytest.raises(BacktestUnsupportedSurfaceError):
        market.candles("BINANCE:ETHUSDT", timeframe="4h")
    with pytest.raises(BacktestUnsupportedSurfaceError):
        market.candles("BINANCE:ETHUSDT", timeframe="1M")


def test_economic_fail_completes_verification_but_source_changes_invalidate_it(tmp_path):
    from nerya.strategies.verification import completed_replay_receipt, source_revision
    from nerya.core.runtime_identity import BUILD_ID, SDK_BUILD_ID
    from nerya.strategies.workflow_service import _read_files
    (tmp_path / "main.py").write_text("def run(ctx):\n    return ctx.result.hold(reason='test')\n")
    revision = source_revision(_read_files(tmp_path)[0])
    run = tmp_path / "backtests" / "20260927_000000"
    run.mkdir(parents=True)
    metrics = {"verdict": "FAIL", "requested_window_complete": True, "requested_window_days": 365,
               "replay": {"errors": 0, "sdk_errors": 0, "order_accounting_ok": True},
               "provenance": {"version": 1, "source_revision": revision, "runtime_build_id": BUILD_ID, "sdk_build_id": SDK_BUILD_ID,
                 "strategy_id": "test", "proposal_id": "prp_test", "source_changed_during_run": False,
                 "data_kind": "historical", "datasets": [{"market": "BINANCE:BTCUSDT", "timeframe": "1h",
                   "rows": 8760, "first_ts": 1735689600, "last_ts": 1767222000,
                   "sha256": "a" * 64, "duplicate_timestamps": 0, "out_of_order": False}]}}
    (run / "metrics.json").write_text(json.dumps(metrics))
    (run / "run.json").write_text(json.dumps({"status": "completed"}))
    receipt = completed_replay_receipt(tmp_path, "test", "prp_test")
    assert receipt and receipt["verdict"] == "FAIL" and receipt["status"] == "completed"
    assert completed_replay_receipt(tmp_path, "test", "prp_other") is None
    (tmp_path / "main.py").write_text("def run(ctx):\n    return ctx.result.hold(reason='changed')\n")
    assert completed_replay_receipt(tmp_path, "test", "prp_test") is None


@pytest.mark.parametrize("args", [
    {"method": "fixed_usd", "fixed_usd": float("nan")},
    {"method": "fixed_base", "fixed_base": float("inf")},
    {"method": "fixed_usd", "fixed_usd": True},
    {"method": "fixed_usd", "fixed_usd": 10, "max_notional_usd": 0},
    {"method": "unknown", "fixed_usd": 10},
    {"method": "volatility_target", "target_volatility_pct": -1},
])
def test_shared_sizing_rejects_nonfinite_or_undefined_intents(args):
    from nerya.trading.order_intents import SizingPolicy
    from nerya.core.errors import IntentValidationError
    with pytest.raises(IntentValidationError):
        SizingPolicy(**args)


def test_backtest_listing_is_scoped_to_the_candidate(tmp_path):
    from types import SimpleNamespace
    from nerya.core.paths import WorkspacePaths
    from nerya.api.routes_strategy import routes
    paths = WorkspacePaths(root=tmp_path)
    published = tmp_path / "strategies/test/backtests/published"
    candidate = tmp_path / "evolution/proposals/prp_test/after/strategies/test/backtests/candidate"
    for directory in (published, candidate):
        directory.mkdir(parents=True)
        (directory / "metrics.json").write_text(json.dumps({"verdict": "FAIL"}))
    handler = next(handler for method, path, handler in routes() if path == "/strategy/backtests")
    client = SimpleNamespace(config=SimpleNamespace(paths=paths))
    result = handler(client, {"strategy_id": "test", "proposal_id": "prp_test"})
    assert [row["ts"] for row in result["backtests"]] == ["candidate"]
    result = handler(client, {"strategy_id": "test"})
    assert [row["ts"] for row in result["backtests"]] == ["published"]


def test_low_level_sell_honors_quantity_instead_of_flattening_the_position():
    from nerya.skills.builtin.backtest.scripts.engine import run_backtest
    market = "MOCK:A"
    rows = [{"ts":1700000000+i*3600, "open":100, "high":101, "low":99, "close":100, "volume":1} for i in range(5)]
    held = []
    def strategy(ctx):
        held.append(sum(p.size for p in ctx.portfolio.positions(market)))
        if len(held) == 1:
            return ctx.trading.submit_intent(market=market, side="buy", size=10, size_unit="base")
        if len(held) == 2:
            return ctx.trading.submit_intent(market=market, side="sell", size=2, size_unit="base")
        return ctx.result.hold(reason="quantity test")
    cfg = load_config(markets=[market], overrides={"tf":"1h", "warmup_bars":0,
                      "fee_bps_by_venue":{"MOCK":0}, "slip_bps_by_venue":{"MOCK":0}})
    result = run_backtest(None, cfg, run_fn=strategy, candles_by_market={market:rows})
    assert held[:3] == [0, 10, 8]
    assert [trade["qty"] for trade in result.trades] == [10, 2, 8]


def test_position_reversal_uses_the_new_fill_cost_basis():
    from nerya.skills.builtin.backtest.scripts.portfolio import PortfolioState
    book = PortfolioState(10000)
    book.apply_fill({"market":"MOCK:A", "side":"buy", "qty":10, "price":100, "ts":1})
    book.apply_fill({"market":"MOCK:A", "side":"sell", "qty":15, "price":120, "ts":2})
    assert book.position("MOCK:A").qty == -5
    assert book.position("MOCK:A").avg_price == 120
    assert book.realized_pnl == 200
    book.apply_fill({"market":"MOCK:A", "side":"buy", "qty":5, "price":110, "ts":3})
    assert book.realized_pnl == 250
    assert book.cash == 10250


def test_repair_prefix_does_not_make_an_old_report_the_latest(tmp_path):
    import os
    from nerya.strategies.verification import _read_report
    for index, name in enumerate(("repair_20260101_000000", "20260927_000000", "run-1_20260927_000000")):
        folder = tmp_path / "backtests" / name
        folder.mkdir(parents=True)
        (folder / "metrics.json").write_text(json.dumps({"verdict":"FAIL"}))
        # Filesystems can give consecutive writes identical mtimes. Specify
        # distinct publication times rather than depending on machine speed.
        modified = 1_790_000_000 + index
        os.utime(folder, (modified, modified))
    report, warnings = _read_report(tmp_path)
    assert report["id"] == "run-1_20260927_000000"
    assert not warnings


def test_authoring_contract_advertises_direct_files_and_never_enables_tuning_implicitly():
    from nerya.tools.native.strategy_runtime import _request_from_args, STRATEGY_DRAFT_PROPOSAL_SCHEMA
    body = "def run(ctx):\n    return ctx.result.hold(reason='contract')\n"
    request = _request_from_args({"strategy_id":"direct_bundle", "files":{"main.py":body}})
    assert request.files["main.py"] == body
    assert request.create_tuning is False
    assert "files" in STRATEGY_DRAFT_PROPOSAL_SCHEMA["properties"]
    assert STRATEGY_DRAFT_PROPOSAL_SCHEMA["properties"]["create_tuning"]["default"] is False


def test_sdk_identity_ignores_presentation_but_tracks_execution_dependencies(tmp_path):
    from nerya.core.runtime_identity import source_sdk_build_id
    (tmp_path / "strategies").mkdir()
    (tmp_path / "agent").mkdir()
    execution = tmp_path / "strategies/calculation.py"
    execution.write_text("VALUE = 1")
    renderer = tmp_path / "agent/tool_projection.py"
    renderer.write_text("LABEL = 'one'")
    original = source_sdk_build_id(tmp_path)
    renderer.write_text("LABEL = 'two'")
    assert source_sdk_build_id(tmp_path) == original
    execution.write_text("VALUE = 2")
    assert source_sdk_build_id(tmp_path) != original


def test_fixed_sizing_and_template_risk_cap_conflict_is_caught_before_execution():
    from types import SimpleNamespace
    from nerya.strategies.configuration_contract import configuration_issues
    manifest=SimpleNamespace(policy=SimpleNamespace(max_single_order_usd=100),
        extras={"params":{"sizing":{"method":"fixed_usd","fixed_usd":1000}},"schedule_enabled":False})
    issues=configuration_issues(manifest)
    assert {code for code,_ in issues} == {"strategy_sizing_policy_conflict","invalid_schedule_field"}


def test_historical_settlement_enforces_declared_strategy_risk_limits():
    from types import SimpleNamespace
    from nerya.skills.builtin.backtest.scripts.engine import settle
    from nerya.skills.builtin.backtest.scripts.portfolio import PortfolioState
    bar={"ts":1700006400,"open":100,"high":101,"low":99,"close":100,"volume":1}
    cfg=load_config(markets=["MOCK:A"],overrides={"tf":"1h","warmup_bars":0})
    policy=SimpleNamespace(max_single_order_usd=100,max_daily_notional_usd=0,max_open_positions=1)
    order={"market":"MOCK:A","side":"buy","size":1000,"size_unit":"usd","plan_action":"open_position"}
    fills,rejects=settle([order],{"MOCK:A":bar},{"MOCK:A":bar},PortfolioState(10000),cfg,policy=policy)
    assert not fills and rejects[0]["reject_reason"]=="max_single_order_usd"


def test_inline_schedule_alias_is_canonicalized_without_enabling_it():
    from nerya.evolution.strategy_code_generator import _normalize_inline_manifest
    from nerya.core.yaml_io import loads
    result=loads(_normalize_inline_manifest("strategy_id: example\nschedule_enabled: false\nschedule:\n  type: cron\n  cron: '0 */4 * * *'\n  enabled: true\n"))
    assert result["schedule"]["enabled"] is False
    assert "schedule_enabled" not in result
