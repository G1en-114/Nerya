"""Order receipts are not fills. All prices here are deterministic fixtures."""
from collections import Counter

import pytest

from nerya.skills.builtin.backtest.scripts.config import load_config
from nerya.skills.builtin.backtest.scripts.engine import run_backtest
from nerya.skills.builtin.backtest.scripts.metrics import assemble_metrics

pytestmark = pytest.mark.smoke
T = 1700000000


def bars(prices):
    return [dict(ts=T + i * 3600, open=p, high=p * 1.01, low=p * .99,
                 close=p, volume=10, fixture=True) for i, p in enumerate(prices)]


def config(markets, **overrides):
    return load_config(markets=markets, overrides={"warmup_bars": 0,
        "fee_bps_by_venue": {"MOCK": 0}, "slip_bps_by_venue": {"MOCK": 0}, **overrides})


def test_ten_markets_ok_return_still_submits_and_capacity_rejects_are_counted():
    markets = [f"MOCK:ASSET{i}" for i in range(10)]
    receipts = []
    def run(ctx):
        if not ctx.state.get("submitted"):
            ctx.state.set("submitted", True)
            for market in markets:
                receipts.append(ctx.trading.open_position(market=market, side="long",
                    sizing={"method": "fixed_usd", "fixed_usd": 100}, confidence=.65))
        return ctx.result.ok(reason="strategy bookkeeping; not proof of fills")
    result = run_backtest(None, config(markets, max_open_trades=1),
        candles_by_market={m: bars([100, 101, 102]) for m in markets}, run_fn=run,
        strategy_config={"policy": {"min_confidence": .5}})
    assert result.order_attempts == 10
    assert all(r["status"] == "submitted" and r["order"]["filled_size"] == 0 for r in receipts)
    assert Counter(r["reject_reason"] for r in result.rejected_signals) == {"max_open_trades": 9}
    evidence = assemble_metrics(result)["replay"]
    assert evidence["orders_submitted"] == 10
    assert evidence["orders_filled"] == 1
    assert evidence["orders_rejected"] == 9
    assert evidence["forced_closes"] == 1
    assert evidence["order_accounting_ok"] is True


def test_swallowed_sizing_error_is_an_attempt_not_silent_no_signal():
    from nerya.core.errors import IntentValidationError
    def run(ctx):
        try:
            ctx.trading.open_position(market="MOCK:A", side="long",
                sizing={"method": "fixed_usd", "fixed_usd": 0})
        except IntentValidationError:
            pass
        return ctx.result.ok(reason="claimed work")
    result = run_backtest(None, config(["MOCK:A"]), candles_by_market={"MOCK:A": bars([100, 100])}, run_fn=run)
    metrics = assemble_metrics(result)
    assert metrics["replay"]["order_attempts"] == 2
    assert metrics["replay"]["orders_submitted"] == 0
    assert metrics["replay"]["sdk_errors"] == 2
    assert "sdk_order_errors" in metrics["flags"]
    assert metrics["verdict"] == "FAIL"


def test_confidence_rejection_records_reason_before_queueing():
    def run(ctx):
        return ctx.trading.open_position(market="MOCK:A", side="long",
            sizing={"method": "fixed_usd", "fixed_usd": 100}, confidence=.49)
    result = run_backtest(None, config(["MOCK:A"]), candles_by_market={"MOCK:A": bars([100, 100])},
        run_fn=run, strategy_config={"policy": {"min_confidence": .5}})
    evidence = assemble_metrics(result)["replay"]
    assert evidence["order_attempts"] == evidence["orders_rejected"] == 2
    assert evidence["orders_submitted"] == evidence["orders_filled"] == 0
    assert evidence["rejection_reasons"] == {"confidence_below_minimum": 2}


def test_ok_without_orders_is_not_trade_execution_evidence():
    def run(ctx):
        return ctx.result.ok(reason="10 markets executed", actions=[("MOCK:A", "skip_warmup", None)])
    result = run_backtest(None, config(["MOCK:A"]), candles_by_market={"MOCK:A": bars([100, 100])}, run_fn=run)
    metrics = assemble_metrics(result)
    assert metrics["replay"]["orders_filled"] == 0
    assert metrics["replay"]["ok_without_orders"] == 2
    assert metrics["replay"]["action_counts"] == {"skip_warmup": 2}
    assert "no_order_attempts" in metrics["flags"]


def test_benchmark_is_equal_weight_not_price_weighted_and_keeps_missing_market():
    data = {"MOCK:EXPENSIVE": bars([10000, 11000]), "MOCK:CHEAP": bars([1, .9, .9])}
    result = run_backtest(None, config(list(data), initial_capital_usd=1000),
        candles_by_market=data, run_fn=lambda ctx: ctx.result.hold())
    assert [v for _, v in result.benchmark_series] == pytest.approx([1000, 1000, 1000])
    assert "market_data_gaps" in assemble_metrics(result)["flags"]


def test_trigger_identity_is_distinct_from_configured_universe():
    seen = []
    def run(ctx):
        seen.append((ctx.trigger.get("market"), ctx.config.markets))
        return ctx.result.hold()
    markets = ["MOCK:A", "MOCK:B"]
    run_backtest(None, config(markets), candles_by_market={m: bars([100]) for m in markets}, run_fn=run)
    assert [m for m, _ in seen] == markets
    assert all(tuple(markets) == universe for _, universe in seen)


def test_multi_market_history_prefix_is_built_once_per_timestamp(monkeypatch):
    from nerya.skills.builtin.backtest.scripts import engine

    markets = ["MOCK:A", "MOCK:B", "MOCK:C"]
    data = {market: bars([100, 101, 102, 103]) for market in markets}
    original = engine._rows_until_ts_indexed
    calls = 0

    def counted(rows, ts, index):
        nonlocal calls
        calls += 1
        return original(rows, ts, index)

    monkeypatch.setattr(engine, "_rows_until_ts_indexed", counted)
    run_backtest(None, config(markets), candles_by_market=data,
                 run_fn=lambda ctx: ctx.result.hold())
    assert calls == len(markets) * 4


def test_wrapped_legacy_payload_cannot_skip_confidence_validation():
    def run(ctx):
        return ctx.trading.submit_intent(kwargs={"market": "MOCK:A", "side": "buy", "size": 100,
            "size_unit": "usd", "confidence": .3})
    result = run_backtest(None, config(["MOCK:A"]), candles_by_market={"MOCK:A": bars([100])},
        run_fn=run, strategy_config={"policy": {"min_confidence": .5}})
    assert result.order_events[0]["market"] == "MOCK:A"
    assert result.order_events[0]["phase"] == "rejected"
    assert not result.trades


def test_legacy_unspecified_confidence_matches_live_optional_field_contract():
    def run(ctx):
        if not ctx.state.get("sent"):
            ctx.state.set("sent", True)
            return ctx.trading.submit_intent(payload={"market": "MOCK:A", "side": "buy",
                "size": 100, "size_unit": "usd", "confidence": None})
        return ctx.result.hold()
    result = run_backtest(None, config(["MOCK:A"]), candles_by_market={"MOCK:A": bars([100, 100])},
        run_fn=run, strategy_config={"policy": {"min_confidence": .5}})
    assert assemble_metrics(result)["replay"]["orders_filled"] == 1
