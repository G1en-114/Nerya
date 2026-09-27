"""TP/SL is opt-in per strategy/order; only declared legs may be submitted."""
from contextlib import closing
import socket

import pytest

from nerya.core import yaml_io
from nerya.sdk.trading_api import TradingAPI
from nerya.tools.native.trading import trade_intent_submit_handler
from nerya.tools.types import ToolCall
from nerya.trading.executors.orchestrator import ExecutorOrchestrator
from nerya.trading.protection_store import ProtectionStore
from nerya.trading.submit import submit_trade_intent
from test_strategy_order_auto_approval import _config, _intent_spec
from test_ccxt_protection_routing import adapter, native_workspace

pytestmark = pytest.mark.smoke


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    def denied(*args, **kwargs):
        raise AssertionError("NETWORK_FORBIDDEN")
    monkeypatch.setattr(socket.socket, "connect", denied)
    monkeypatch.setattr(socket, "create_connection", denied)


CHOICES = [None, {}, {"stop_loss": {"type": "pct", "value": .02}},
           {"take_profit": {"type": "pct", "value": .04}},
           {"stop_loss": {"type": "pct", "value": .02},
            "take_profit": {"type": "pct", "value": .04}}]


@pytest.mark.parametrize("protection", CHOICES)
@pytest.mark.parametrize("entrypoint", ["agent", "script", "sdk"])
def test_strategy_chooses_exact_protection_legs(tmp_path, entrypoint, protection):
    cfg = _config(tmp_path)
    snapshot = {"price": 50000, "age_s": 0}
    if entrypoint == "agent":
        spec = _intent_spec("strategy_agent")
        spec.update(market_snapshot=snapshot, protection=protection)
        result = trade_intent_submit_handler(ToolCall(name="trade_intent_submit", arguments=spec, id="optional"), config=cfg)
        assert not result.is_error, result
        out = result.content[0].data
    elif entrypoint == "script":
        from test_strategy_execution_modes import _trading
        trading = _trading(cfg, mode="paper", account="paper_main")
        trading.strategy_id = "s1"
        out = trading.submit_intent(market="mock:BTC/USDT", side="buy", size=100,
            confidence=1, protection=protection, market_snapshot=snapshot)
    else:
        out = TradingAPI(config=cfg, skills=None).open_position(strategy_id="s1", account_id="paper_main",
            market="mock:BTC/USDT", side="long", sizing={"method":"fixed_usd", "fixed_usd":100},
            confidence=1, source="strategy_runtime", protection=protection, market_snapshot=snapshot)
    assert out["status"] == "filled", out
    with closing(ProtectionStore(cfg.paths)) as store:
        rules = store.list_active()
    with closing(ExecutorOrchestrator(cfg)) as orch:
        protectors = [run for run in orch.list_active() if run.kind == "position_protection"]
    if not protection:
        assert not rules and not protectors
        assert out["intent"]["meta"]["protection_present"] is False
    else:
        assert len(rules) == len(protectors) == 1
        assert bool(rules[0].stop_loss) == ("stop_loss" in protection)
        assert bool(rules[0].take_profit) == ("take_profit" in protection)


@pytest.mark.parametrize("legs", [(), ("stop_loss",), ("take_profit",), ("stop_loss", "take_profit")])
@pytest.mark.parametrize("venue", ["bybit", "binanceusdm"])
def test_adapter_never_invents_an_unrequested_leg(venue, legs):
    conn, client, market = adapter(venue)
    sent = []
    client.create_order = lambda *args: sent.append(args[-1]) or {"id":"entry", "amount":1, "filled":0}
    values = {"stop_loss":49000, "take_profit":52000}
    ack = conn.place_order(market=market, side="buy", order_type="market", size=1,
        managed_protection=True, **{leg: values[leg] for leg in legs})
    assert len(sent) == 1
    assert set(ack.raw.get("nerya_protection_routes", {})) == set(legs)
    assert ("stopLoss" in sent[0]) == (venue == "bybit" and "stop_loss" in legs)
    assert ("takeProfit" in sent[0]) == (venue == "bybit" and "take_profit" in legs)


@pytest.mark.parametrize("legs", [("stop_loss",), ("take_profit",)])
def test_deferred_protection_places_only_the_requested_leg(tmp_path, monkeypatch, legs):
    cfg, conn, book, rule, sent, rows, cancels = native_workspace(tmp_path, monkeypatch)
    rule.stop_loss = rule.stop_loss if "stop_loss" in legs else None
    rule.take_profit = rule.take_profit if "take_profit" in legs else None
    rule.native["routes"] = {leg:"standalone" for leg in legs}
    with closing(ProtectionStore(cfg.paths)) as store:
        store.upsert(rule)
    with closing(ExecutorOrchestrator(cfg)) as orch:
        orch.run_once()
        orch.run_once()
    assert len(sent) == 1
    assert ("stopLossPrice" in sent[0]) == ("stop_loss" in legs)
    assert ("takeProfitPrice" in sent[0]) == ("take_profit" in legs)


def test_canary_without_protection_still_requests_approval(tmp_path):
    cfg = _config(tmp_path)
    path = cfg.paths.strategy("s1") / "strategy.yml"
    manifest = yaml_io.load(path)
    manifest["status"] = "canary"
    yaml_io.dump(path, manifest)
    out = submit_trade_intent(cfg, spec=_intent_spec(), market_snapshot={"price":50000, "age_s":0})
    assert out["status"] == "pending_approval", out
    assert "canary_per_trade_approval_required" in out["risk_decision"]["reasons"]


@pytest.mark.parametrize("required", [True, False])
def test_explicit_strategy_protection_policy_is_enforced(tmp_path, required):
    cfg = _config(tmp_path)
    path = cfg.paths.strategy("s1") / "limits.yml"
    limits = yaml_io.load(path)
    limits["require_protection"] = required
    yaml_io.dump(path, limits)
    spec = _intent_spec()
    spec["meta"] = {"protection_present":True, "plan_protection_attached":True}
    out = submit_trade_intent(cfg, spec=spec, market_snapshot={"price":50000, "age_s":0})
    assert out["status"] == ("rejected" if required else "filled"), out
    if required:
        assert "strategy_requires_protection_rule" in out["risk_decision"]["reasons"]


def test_promotion_only_requires_protection_evidence_when_strategy_requires_it(tmp_path):
    from nerya.trading.promotion import EvidenceStore, evaluate_promotion
    cfg = _config(tmp_path)
    store = EvidenceStore(cfg.paths)
    for kind in ("static_review", "backtest", "paper_window"):
        store.record(strategy_id="s1", kind=kind, passed=True, payload={"test":True})
    assert evaluate_promotion(cfg.paths, strategy_id="s1", target="shadow").verdict == "allow"
    path = cfg.paths.strategy("s1") / "strategy.yml"
    manifest = yaml_io.load(path)
    manifest["policy"] = {"require_protection":True}
    yaml_io.dump(path, manifest)
    out = evaluate_promotion(cfg.paths, strategy_id="s1", target="shadow")
    assert out.missing_evidence == ["protection_check"]


def test_manifest_policy_roundtrip_and_explicit_limits_override(tmp_path):
    from nerya.strategies.package import StrategyPolicy
    from nerya.trading.strategies import load_strategy
    policy = StrategyPolicy.from_dict({"require_protection":True}, where="test")
    assert policy.asdict()["require_protection"] is True
    cfg = _config(tmp_path)
    path = cfg.paths.strategy("s1") / "strategy.yml"
    manifest = yaml_io.load(path)
    manifest["policy"] = policy.asdict()
    yaml_io.dump(path, manifest)
    assert load_strategy(cfg.paths, "s1").limits.require_protection is True
    limits_path = cfg.paths.strategy("s1") / "limits.yml"
    limits = yaml_io.load(limits_path)
    limits["require_protection"] = False
    yaml_io.dump(limits_path, limits)
    assert load_strategy(cfg.paths, "s1").limits.require_protection is False


def test_required_protection_accepts_single_leg_and_does_not_block_close(tmp_path):
    cfg = _config(tmp_path)
    path = cfg.paths.strategy("s1") / "limits.yml"
    limits = yaml_io.load(path)
    limits["require_protection"] = True
    yaml_io.dump(path, limits)
    spec = _intent_spec()
    spec["protection"] = {"take_profit":{"type":"pct", "value":.04}}
    snapshot = {"price":50000, "age_s":0}
    out = submit_trade_intent(cfg, spec=spec, market_snapshot=snapshot)
    assert out["status"] == "filled", out
    spec.pop("protection")
    spec.update(side="sell", plan_action="close_position")
    out = submit_trade_intent(cfg, spec=spec, market_snapshot=snapshot)
    assert out["status"] == "filled", out
