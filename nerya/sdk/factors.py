"""Compute a strategy's exported, immutable factor snapshot on closed bars."""
from __future__ import annotations

from typing import Any, Mapping, Sequence

import pandas as pd

from ..skills.builtin.factor_library.scripts.expressions import FactorExpression


def calculate_factor(snapshot: Mapping[str, Any], closed_candles: Sequence[Mapping[str, Any]]) -> list[float | None]:
    """No IO or library lookup. Caller supplies ordered, already closed candles.

    Persist the exact snapshot in factors.json alongside the strategy so native
    backtests freeze it with the source. Missing/warmup values return None.
    """
    engine = FactorExpression(str(snapshot["expression"]), dict(snapshot.get("parameters") or {}))
    if not closed_candles:
        return []
    frame = pd.DataFrame(closed_candles)
    if "ts" not in frame or not frame.ts.is_monotonic_increasing or frame.ts.duplicated().any():
        raise ValueError("factor candles require unique, increasing ts timestamps")
    values = engine.calculate(frame)
    return [float(value) if pd.notna(value) else None for value in values]
