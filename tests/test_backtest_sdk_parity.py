"""Isolated SDK replay regressions; fixture prices are not market evidence."""
from pathlib import Path

import pytest

from nerya.skills.builtin.backtest.scripts.config import load_config
from nerya.skills.builtin.backtest.scripts.engine import run_backtest, settle
from nerya.skills.builtin.backtest.scripts.mock_ctx import MockCtx, MockState
from nerya.skills.builtin.backtest.scripts.portfolio import PortfolioState
from nerya.strategies.context import StrategyPosition, StrategyTriggerContext
from nerya.trading.order_intents import SizingPolicy
from nerya.core.errors import IntentValidationError


MARKET = "MOCK:BTCUSDT"
pytestmark = pytest.mark.smoke


def context(state=None):
    bar = {"ts": 1700000000, "open": 110, "high": 111, "low": 109, "close": 110, "volume": 1}
    return MockCtx(strategy_id="sdk_parity", market_name=MARKET,
        bars_by_market={MARKET: [bar]}, current_bar=bar, pending_orders=[],
        config_obj=load_config(markets=[MARKET], overrides={"warmup_bars": 0}),
        state=state or MockState())


def test_replay_position_uses_live_read_model():
    ctx = context()
    assert ctx.portfolio.position(MARKET) is None
    ctx.state.set(f"position:{MARKET}", {"qty": -2, "avg_price": 100})
    position = ctx.portfolio.position(MARKET)
    assert isinstance(position, StrategyPosition)
    assert position.qty == position["size"] == position.get("quantity") == -2
    assert position.avg_price == position["entry_price"] == 100
    assert position["side"] == "short"
    assert position.unrealized_pnl_usd == -20
    assert position.market_value_usd == 220
    assert ctx.portfolio.position("BTC/USDT") == position


def test_replay_context_has_typed_trigger_and_stable_metadata():
    ctx = context()
    assert isinstance(ctx.trigger, StrategyTriggerContext)
    assert ctx.trigger.source == "backtest"
    assert ctx.trigger.strategy_id == ctx.strategy_id
    assert ctx.trigger.occurred_at == ctx.clock.now_iso()
    assert ctx.run_id and ctx.session_id is None
    ctx.run_deadline.raise_if_exceeded()
    assert ctx.stream is None and ctx.backtest_replay is None
    ctx.audit.log("sdk_check", {"run_id": ctx.run_id})
    assert ctx.audit.events()[0]["payload"]["run_id"] == ctx.run_id


def test_news_dedupe_persists_between_replay_ticks():
    state = MockState()
    news = [{"id": "recorded-headline", "title": "unit fixture"}]
    assert context(state).dedupe.news(news) == news
    assert context(state).dedupe.news(news) == []
    assert context(state).dedupe.news(news, bucket="other") == news


def test_typed_sdk_sizing_is_not_dropped():
    ctx = context()
    ctx.trading.open_position(market=MARKET, side="long", sizing=SizingPolicy(method="fixed_base", fixed_base=2))
    assert ctx.pending_orders[0]["size"] == 2
    assert ctx.pending_orders[0]["size_unit"] == "base"


@pytest.mark.parametrize("kwargs", [{}, {"reduce_pct": 0}, {"reduce_pct": -0.1}, {"reduce_pct": 2}, {"fixed_base": 0}])
def test_invalid_reduce_never_turns_into_full_close(kwargs):
    ctx = context()
    with pytest.raises((ValueError, IntentValidationError)):
        ctx.trading.reduce_position(market=MARKET, side="long", **kwargs)
    assert not ctx.pending_orders


def test_fixed_base_reduce_matches_engine_settlement():
    ctx = context()
    ctx.state.set(f"position:{MARKET}", {"qty": 5, "avg_price": 100})
    ack = ctx.trading.reduce_position(market=MARKET, side="long", fixed_base=2)
    assert ack["status"] == "submitted" and ack["order"]["filled_size"] == 0
    assert ack["execution_estimate"]["size"] == 2
    portfolio = PortfolioState(10000)
    portfolio.apply_fill({"market": MARKET, "side": "buy", "qty": 5, "price": 100, "fee": 0})
    fills, rejects = settle(ctx.pending_orders, {MARKET: ctx.current_bar}, {MARKET: ctx.current_bar}, portfolio, ctx.config_obj)
    assert not rejects and fills[0]["qty"] == 2
    assert portfolio.position(MARKET).qty == 3


def test_strategy_error_result_is_not_successful_performance():
    ctx = context()
    with pytest.raises(RuntimeError, match="fixture strategy failed"):
        run_backtest(None, ctx.config_obj, candles_by_market=ctx.bars_by_market,
            run_fn=lambda ctx: ctx.result.error(message="fixture strategy failed"))
