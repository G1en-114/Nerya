"""Exercise the emitted repair logic with explicitly synthetic signal fixtures."""
import runpy
from dataclasses import replace
from pathlib import Path

import pytest

from nerya.skills.builtin.backtest.scripts.mock_ctx import MockCtx, MockState
from nerya.skills.builtin.backtest.scripts.config import load_config

pytestmark = pytest.mark.smoke
RUN = runpy.run_path(str(Path(__file__).parents[1] / "scripts/repair_alphatrend_order_flow.py"))["RUN"]
MARKETS = ["MOCK:A", "MOCK:B"]


def module(signal):
    namespace = {"StrategyContext": object, "StrategyResult": object,
        "_pos_int": int,
        "_params": lambda ctx: {"sma_filter_window": 1, "macd_slow": 1, "macd_signal": 1,
            "atr_window": 1, "atr_stop_multiplier": 2, "trailing_atr_multiplier": 3, "per_market_stake_usd": 100},
        "_closed_candles": lambda ctx, market, preset: [(i, 100, 101, 99, 100) for i in range(4)],
        "_signal": lambda *args: signal}
    exec(RUN, namespace)
    return namespace


def context(market="MOCK:B", state=None):
    bar = {"ts": 1700000000, "open": 100, "high": 101, "low": 99, "close": 100}
    return MockCtx(strategy_id="fixture", market_name=market, bars_by_market={m: [bar] for m in MARKETS},
        current_bar=bar, pending_orders=[], config_obj=load_config(markets=MARKETS), state=state or MockState())


def signal(**overrides):
    return {"close": 100, "atr": 2, "golden": True, "death": False,
            "above_sma": True, "below_sma": False, **overrides}


def test_event_uses_trigger_market_not_first_universe_member():
    code = module(signal())
    ctx = context()
    result = code["run"](ctx)
    assert result["status"] == "submitted"
    assert [r["market"] for r in ctx.pending_orders] == ["MOCK:B"]
    assert ctx.state.get("alphatrend_v3:MOCK:B")["atr"] == 2
    assert "entry" not in ctx.state.get("alphatrend_v3:MOCK:B")
    second = code["run"](ctx)
    assert second.reason == "skip_duplicate_candle" and len(ctx.pending_orders) == 1


def test_timer_iterates_universe_once_and_receipts_not_labels_drive_summary():
    code = module(signal())
    ctx = context()
    ctx.trigger = replace(ctx.trigger, payload={})
    result = code["run"](ctx)
    assert {r["market"] for r in ctx.pending_orders} == set(MARKETS)
    assert "submitted=2, filled=0" in result.reason
    assert code["run"](ctx).status.value == "hold"
    assert len(ctx.pending_orders) == 2


@pytest.mark.parametrize("short,close,extreme", [(False, 100, 110), (True, 100, 90)])
def test_armed_trailing_stop_remains_reachable_after_price_retraces(short, close, extreme):
    code = module(signal(close=close, golden=False))
    state = MockState()
    state.set("position:MOCK:B", {"qty": -1 if short else 1, "avg_price": 100})
    state.set("alphatrend_v3:MOCK:B", {"entry": 100, "side": "short" if short else "long",
        "atr": 2, "extreme": extreme, "stop_moved": True})
    ctx = context(state=state)
    receipt = code["run"](ctx)
    assert receipt["status"] == "submitted"
    assert "trailing_stop" in ctx.pending_orders[0]["reason"]
    assert ctx.state.get("alphatrend_v3:MOCK:B")["entry"] == 100


def test_unknown_event_market_is_not_silently_routed_to_btc():
    ctx = context()
    ctx.trigger.payload["market"] = "MOCK:UNKNOWN"
    result = module(signal())["run"](ctx)
    assert result.status.value == "error" and not ctx.pending_orders
