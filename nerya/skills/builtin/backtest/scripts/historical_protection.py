"""Historical execution of a bounded subset of the public protection SDK.

No broker, executor thread, model, clock or network access. OHLC does not reveal
the intrabar path: use the adverse stop first when both bounds are touched and
advance trailing watermarks only after evaluating the existing stop. These
assumptions are exported with each report, never presented as real fills.
"""
from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Any

from .slippage import apply_slippage, compute_fee, fee_bps_for, slip_bps_for

MODEL = {
    "version": "ohlcv-protection-v1",
    "supported": ["stop_loss:pct/price", "take_profit:pct/price", "trailing_stop:pct", "time_limit_sec"],
    "collision": "stop_before_take_profit",
    "trailing": "prior_bar_watermark; newly activated trail starts next bar",
    "gaps": "adverse stop gaps execute at bar open plus configured slippage",
    "timing": "OHLC bar precision; time limit evaluated at bar close",
    "scope": "Historical simulation, not broker-native protection execution",
}


def _finite(value: Any, name: str, *, allow_zero: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"protection {name} must be a finite number")
    if value < 0 or (value == 0 and not allow_zero):
        raise ValueError(f"protection {name} must be positive")
    return float(value)


def normalize_protection(value: Any, *, side: str | None = None) -> dict[str, Any]:
    if value is None or value is False:
        return {}
    raw = value.asdict() if hasattr(value, "asdict") else value
    if not isinstance(raw, dict):
        raise ValueError("protection must be a mapping or ProtectionRule")
    if not raw:
        return {}
    # Public ProtectionRule carries identity/lifecycle metadata in addition to
    # executable rules. The open call owns market/side; these fields are not a
    # request to start actual executors during a historical replay.
    metadata = {"protection_id", "position_id", "executor_id", "strategy_id", "account_id", "market", "side",
                "mode", "status", "exchange_order_ids", "created_at", "updated_at", "triggered_at", "triggered_kind", "notes"}
    supported = {"stop_loss", "take_profit", "trailing_stop", "time_limit_sec", "trigger_source"}
    if raw.get("partial_exits") or raw.get("native"):
        raise ValueError("partial exits and exchange-native protection overrides need an explicit historical execution model")
    unknown = set(raw) - supported - metadata - {"partial_exits", "native"}
    if unknown:
        raise ValueError("unsupported protection fields: " + ", ".join(sorted(unknown)))
    source = str(raw.get("trigger_source") or "mark")
    if source not in {"mark", "last", "candle_close"}:
        raise ValueError(f"historical OHLC cannot supply protection trigger_source={source!r}")
    out: dict[str, Any] = {"trigger_source": source}
    for name in ("stop_loss", "take_profit"):
        rule = raw.get(name)
        if rule is None:
            continue
        rule = rule.asdict() if hasattr(rule, "asdict") else rule
        if not isinstance(rule, dict) or set(rule) - {"type", "value"}:
            raise ValueError(f"invalid {name} rule")
        kind = str(rule.get("type") or "pct")
        if kind not in {"pct", "price"}:
            raise ValueError(f"historical {name} type={kind!r} is not implemented; retain the risk rule, do not delete it")
        amount = _finite(rule.get("value"), name)
        if kind == "pct" and (name == "stop_loss" or side == "short") and amount >= 1:
            raise ValueError(f"invalid {name} percentage for {side or 'position'}")
        out[name] = {"type": kind, "value": amount}
    trail = raw.get("trailing_stop")
    if trail is not None:
        if not isinstance(trail, dict) or set(trail) - {"activation_pct", "trail_pct"}:
            raise ValueError("invalid trailing_stop rule")
        activation = _finite(trail.get("activation_pct", 0), "activation_pct", allow_zero=True)
        distance = _finite(trail.get("trail_pct"), "trail_pct")
        if distance >= 1:
            raise ValueError("historical trail_pct must be less than one")
        out["trailing_stop"] = {"activation_pct": activation, "trail_pct": distance}
    duration = raw.get("time_limit_sec")
    if duration is not None:
        _finite(duration, "time_limit_sec")
        if int(duration) != duration:
            raise ValueError("time_limit_sec must be an integer")
        out["time_limit_sec"] = int(duration)
    if len(out) == 1:
        raise ValueError("protection must include at least one supported exit rule")
    return out


@dataclass
class ActiveProtection:
    rule: dict[str, Any]
    entry_price: float
    side: int
    opened_ts: int
    high_water: float
    low_water: float
    intent_id: str
    trail_active: bool = False


def arm(portfolio, fill: dict[str, Any], rule: dict[str, Any]) -> None:
    position = portfolio.position(fill["market"])
    if not position.qty:
        portfolio.protections.pop(fill["market"], None)
        return
    trail = rule.get("trailing_stop") or {}
    portfolio.protections[fill["market"]] = ActiveProtection(rule, position.avg_price,
        1 if position.qty > 0 else -1, int(fill["ts"]), float(fill["price"]), float(fill["price"]),
        str(fill["intent_id"]), bool(trail and trail["activation_pct"] == 0))


def settle_protections(portfolio, bars: dict[str, dict[str, Any]], config) -> list[dict[str, Any]]:
    from .data_cache import _tf_seconds
    fills = []
    for market, state in list(portfolio.protections.items()):
        position = portfolio.position(market)
        if not position.qty or position.qty * state.side <= 0:
            portfolio.protections.pop(market, None)
            continue
        if market not in bars:
            continue
        bar = bars[market]
        op, high, low, close = (float(bar[key]) for key in ("open", "high", "low", "close"))
        close_only = state.rule["trigger_source"] == "candle_close"
        test_high, test_low = (close, close) if close_only else (high, low)
        stops = []
        stop = state.rule.get("stop_loss")
        if stop:
            level = stop["value"] if stop["type"] == "price" else state.entry_price * (1 - state.side * stop["value"])
            stops.append((level, "stop_loss"))
        trail = state.rule.get("trailing_stop")
        if trail and state.trail_active:
            level = state.high_water * (1 - trail["trail_pct"]) if state.side > 0 else state.low_water * (1 + trail["trail_pct"])
            stops.append((level, "trailing_stop"))
        stops.sort(key=lambda item: state.side * item[0], reverse=True)
        reason, execution = "", 0.0
        target = state.rule.get("take_profit")
        target_level = (target["value"] if target["type"] == "price" else state.entry_price * (1 + state.side * target["value"])) if target else None
        # Open is known to precede the unknown high/low sequence. A gapped
        # take-profit at open cannot be replaced by a later intrabar stop.
        if not close_only:
            for level, kind in stops:
                if (state.side > 0 and op <= level) or (state.side < 0 and op >= level):
                    reason, execution = kind, op
                    break
            if not reason and target_level is not None and ((state.side > 0 and op >= target_level) or (state.side < 0 and op <= target_level)):
                reason, execution = "take_profit", op
        for level, kind in stops:
            if reason:
                break
            if (state.side > 0 and test_low <= level) or (state.side < 0 and test_high >= level):
                reason = kind
                execution = close if close_only else min(op, level) if state.side > 0 else max(op, level)
                break
        if not reason and target:
            level = target["value"] if target["type"] == "price" else state.entry_price * (1 + state.side * target["value"])
            if (state.side > 0 and test_high >= level) or (state.side < 0 and test_low <= level):
                reason, execution = "take_profit", close if close_only else level
        duration = state.rule.get("time_limit_sec")
        if not reason and duration and int(bar["ts"]) + _tf_seconds(config.tf) >= state.opened_ts + duration:
            reason, execution = "time_limit", close
        if reason:
            side = "sell" if position.qty > 0 else "buy"
            slip = slip_bps_for(market, config.slip_bps_by_venue)
            price = apply_slippage(execution, side, slip)
            qty = abs(position.qty)
            fill = {"ts": int(bar["ts"]), "market": market, "side": side, "qty": qty, "price": price,
                    "ideal_price": execution, "notional": qty * price,
                    "fee": compute_fee(qty * price, fee_bps_for(market, config.fee_bps_by_venue)),
                    "slippage_bps": slip, "slippage_usd": abs(qty * (price - execution)),
                    "reason": "protection:" + reason, "intent_id": f"protection:{state.intent_id}:{bar['ts']}",
                    "protection_fill": True, "engine_generated": True, "forced_close": False,
                    "execution_time_precision": "bar", "protection_model": MODEL["version"]}
            portfolio.apply_fill(fill)
            portfolio.protections.pop(market, None)
            fills.append(fill)
        else:
            state.high_water = max(state.high_water, high)
            state.low_water = min(state.low_water, low)
            if trail:
                favorable = state.high_water / state.entry_price - 1 if state.side > 0 else 1 - state.low_water / state.entry_price
                state.trail_active |= favorable >= trail["activation_pct"]
    return fills
