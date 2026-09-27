"""Pure, prefix-causal indicator functions available to strategy packages.

No model, account, filesystem or network access. AlphaTrend follows the
ATR-support/resistance recurrence and two-bar time shift described by its
author: https://www.tradingview.com/script/o50NYLAZ-AlphaTrend/
The default ATR is a simple mean of true range; Wilder smoothing is an explicit
option, not a silent substitution. Undefined zero-flow momentum is neutral 50.
"""
from __future__ import annotations

from collections import deque
from collections.abc import Mapping, Sequence
import math
from typing import Any

__all__ = ["alphatrend"]


def alphatrend(candles: Sequence[Mapping[str, Any]], *, period: int = 14,
               coefficient: float = 1.0, offset: int = 2,
               momentum: str = "auto", atr_smoothing: str = "sma") -> dict[str, Any]:
    """Aligned alpha/lagged lines and confirmed crossover arrays.

    ``offset`` is a delay in bars, NOT an upper/lower price channel. ``auto``
    uses MFI when every bar in the causal momentum window supplies volume;
    absent volume switches to RSI. Zero reported volume is still volume data.
    Call with closed candles and sufficient warmup; no future row influences
    any earlier output. The function never mutates its input.
    """
    if type(period) is not int or not 1 <= period <= 100000 or type(offset) is not int or offset < 1:
        raise ValueError("period and offset must be positive integers")
    if isinstance(coefficient, bool) or not isinstance(coefficient, (int, float)) or not math.isfinite(coefficient) or coefficient <= 0:
        raise ValueError("coefficient must be finite and positive")
    if momentum not in {"auto", "mfi", "rsi"} or atr_smoothing not in {"sma", "rma"}:
        raise ValueError("unsupported momentum or ATR smoothing mode")
    alpha: list[float | None] = []
    atr_values: list[float | None] = []
    momentum_values: list[float | None] = []
    sources: list[str] = []
    trs, flows, changes = deque(), deque(), deque()
    tr_sum = 0.0
    prev_close = prev_typical = None
    avg_gain = avg_loss = None
    prev_alpha = 0.0
    prior_atr = None
    for index, row in enumerate(candles):
        values = [row.get(key) for key in ("high", "low", "close")]
        if any(isinstance(v, bool) or v is None for v in values):
            raise ValueError(f"invalid OHLC at index {index}")
        high, low, close = map(float, values)
        if not all(math.isfinite(v) and v > 0 for v in (high, low, close)) or low > close or close > high:
            raise ValueError(f"invalid OHLC at index {index}")
        volume = row.get("volume") if row.get("volume_available") is not False else None
        if volume is not None:
            if isinstance(volume, bool) or not math.isfinite(float(volume)) or float(volume) < 0:
                raise ValueError(f"invalid volume at index {index}")
            volume = float(volume)
        typical = (high + low + close) / 3
        tr = high - low if prev_close is None else max(high - low, abs(high - prev_close), abs(low - prev_close))
        trs.append(tr); tr_sum += tr
        if len(trs) > period:
            tr_sum -= trs.popleft()
        atr = None if len(trs) < period else tr_sum / period
        if atr is not None and atr_smoothing == "rma" and prior_atr is not None:
            atr = (prior_atr * (period - 1) + tr) / period
        if atr is not None:
            prior_atr = atr
        if prev_close is not None:
            delta = close - prev_close
            changes.append((max(delta, 0), max(-delta, 0)))
            if len(changes) > period:
                changes.popleft()
            if len(changes) == period:
                if avg_gain is None:
                    avg_gain = sum(g for g, _ in changes) / period
                    avg_loss = sum(l for _, l in changes) / period
                else:
                    avg_gain = (avg_gain * (period - 1) + max(delta, 0)) / period
                    avg_loss = (avg_loss * (period - 1) + max(-delta, 0)) / period
            money = typical * volume if volume is not None else None
            flows.append((money if typical > prev_typical else 0, money if typical < prev_typical else 0, volume is not None))
            if len(flows) > period:
                flows.popleft()
        available = len(flows) == period and all(known for _, _, known in flows)
        source = "mfi" if momentum == "mfi" or (momentum == "auto" and available) else "rsi"
        value = None
        if source == "mfi" and available:
            pos = sum(p for p, _, _ in flows)
            neg = sum(n for _, n, _ in flows)
            value = 100 * pos / (pos + neg) if pos + neg else 50.0
        elif source == "rsi" and avg_gain is not None:
            value = 100 * avg_gain / (avg_gain + avg_loss) if avg_gain + avg_loss else 50.0
        if value is not None and atr is not None:
            prev_alpha = max(prev_alpha, low - coefficient * atr) if value >= 50 else min(prev_alpha, high + coefficient * atr)
            alpha.append(prev_alpha)
        else:
            alpha.append(None)
        atr_values.append(atr); momentum_values.append(value); sources.append(source)
        prev_close, prev_typical = close, typical
    lagged = [None if i < offset else alpha[i - offset] for i in range(len(alpha))]
    buys, sells = [False] * len(alpha), [False] * len(alpha)
    for i in range(1, len(alpha)):
        if all(v is not None for v in (alpha[i], alpha[i-1], lagged[i], lagged[i-1])):
            buys[i] = alpha[i] > lagged[i] and alpha[i-1] <= lagged[i-1]
            sells[i] = alpha[i] < lagged[i] and alpha[i-1] >= lagged[i-1]
    return {"alpha": alpha, "lagged": lagged, "atr": atr_values,
            "momentum": momentum_values, "momentum_source": sources,
            "buy": buys, "sell": sells, "period": period, "coefficient": coefficient,
            "offset": offset, "atr_smoothing": atr_smoothing,
            "ready": bool(alpha and len(alpha) > offset and alpha[-1] is not None and lagged[-1] is not None)}
