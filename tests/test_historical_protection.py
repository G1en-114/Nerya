"""OHLC execution-model fixtures; never published as real market evidence."""
import pytest
from nerya.skills.builtin.backtest.scripts.engine import run_backtest
from nerya.skills.builtin.backtest.scripts.config import load_config
from nerya.skills.builtin.backtest.scripts.order_evidence import execution_evidence
from nerya.skills.builtin.backtest.scripts.historical_protection import normalize_protection

pytestmark = pytest.mark.smoke
T = 1700006400


def run(prices, protection, side="long"):
    rows = [{"ts":T+i*3600, "open":o,"high":h,"low":l,"close":c,"volume":1}
            for i,(o,h,l,c) in enumerate(prices)]
    def strategy(ctx):
        if not ctx.state.get("entered"):
            ctx.state.set("entered", True)
            return ctx.trading.open_position(market="MOCK:A", side=side,
                sizing={"method":"fixed_base", "fixed_base":1}, confidence=.9, protection=protection)
        return ctx.result.hold(reason="hold")
    cfg = load_config(markets=["MOCK:A"], overrides={"warmup_bars":0,"tf":"1h",
        "fee_bps_by_venue":{"MOCK":0}, "slip_bps_by_venue":{"MOCK":0}})
    return run_backtest(None,cfg,run_fn=strategy,candles_by_market={"MOCK:A":rows})


@pytest.mark.parametrize("side,price", [("long",98),("short",102)])
def test_bracket_stop_first_when_both_levels_are_touched(side,price):
    result=run([(100,101,99,100),(100,110,90,100),(100,101,99,100)],
        {"stop_loss":{"type":"pct","value":.02},"take_profit":{"type":"pct","value":.03}}, side)
    assert len(result.trades)==2
    assert result.trades[-1]["price"]==pytest.approx(price)
    assert result.trades[-1]["reason"]=="protection:stop_loss"
    assert result.equity_series[-1][1]==pytest.approx(9998)
    evidence=execution_evidence(result)
    assert evidence["orders_submitted"]==evidence["orders_filled"]==1
    assert evidence["protective_closes"]==1 and evidence["forced_closes"]==0
    assert evidence["order_accounting_ok"] is True


def test_adverse_stop_gap_is_not_filled_at_an_unavailable_stop_price():
    result=run([(100,101,99,100),(100,101,99,100),(90,95,85,91)],
        {"stop_loss":{"type":"pct","value":.02}})
    assert result.trades[-1]["price"]==90


def test_take_profit_met_at_open_precedes_a_later_intrabar_stop():
    result=run([(100,101,99,100),(100,101,99,100),(105,110,90,95)],
        {"stop_loss":{"type":"pct","value":.02},"take_profit":{"type":"pct","value":.03}})
    assert result.trades[-1]["price"]==105
    assert result.trades[-1]["reason"]=="protection:take_profit"


def test_trailing_watermark_does_not_look_ahead_within_the_same_bar():
    result=run([(100,101,99,100),(100,110,99,108),(109,111,104,105)],
        {"trailing_stop":{"activation_pct":.05,"trail_pct":.05}})
    assert result.trades[-1]["ts"]==T+7200
    assert result.trades[-1]["price"]==pytest.approx(104.5)
    assert result.trades[-1]["reason"]=="protection:trailing_stop"


def test_candle_close_trigger_does_not_use_intrabar_low():
    result=run([(100,101,99,100),(100,102,90,101),(101,102,95,97)],
        {"stop_loss":{"type":"price","value":98}, "trigger_source":"candle_close"})
    assert result.trades[-1]["ts"]==T+7200
    assert result.trades[-1]["price"]==97


def test_time_limit_uses_bar_close_and_is_not_an_extra_sdk_submission():
    result=run([(100,101,99,100),(100,102,99,101),(101,102,99,100)],{"time_limit_sec":3600})
    assert result.trades[-1]["price"]==101
    assert result.trades[-1]["reason"]=="protection:time_limit"
    assert result.order_attempts==1


@pytest.mark.parametrize("rule", [
    {"stop_loss":{"type":"atr","value":2}},
    {"stop_loss":{"type":"pct","value":float("nan")}},
    {"stop_loss":{"type":"pct","value":.02},"partial_exits":[{"trigger_pct":.1,"close_pct":.5}]},
    {"take_profit":{"type":"pct","value":.1},"trigger_source":"bid_ask"},
])
def test_unsupported_or_invalid_risk_rules_are_never_discarded(rule):
    with pytest.raises(ValueError): normalize_protection(rule)
