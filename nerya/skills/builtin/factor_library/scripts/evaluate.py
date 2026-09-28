"""Chronological, local-only factor diagnostics, not a portfolio backtest."""
from __future__ import annotations

import hashlib
import uuid
from pathlib import Path
from typing import Any, Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, ConfigDict, Field

from .....data.history_store import HistoryStore, coverage, market_key, rows_hash, timeframe_seconds
from .....research.factors import FactorStore, now
from ...backtest.scripts.history_data import resolve_window, store_root
from .expressions import FactorExpression

ENGINE_VERSION = "factor_diagnostics_v1"


class EvaluationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    factor_id: str
    version: int = Field(ge=1, strict=True)
    market: str
    timeframe: str
    start: str
    end: str
    instrument_type: Literal["spot", "perpetual"]
    horizon: int = Field(default=5, ge=1, le=1000, strict=True)
    test_fraction: float = Field(default=0.3, ge=0.2, le=0.5)
    fee_bps: float = Field(ge=0, le=1000)
    slippage_bps: float = Field(ge=0, le=1000)
    data_dir: str | None = None
    compare: list[dict[str, Any]] = Field(default_factory=list, max_length=5)


def number(value: Any) -> float | None:
    try:
        return float(value) if np.isfinite(float(value)) else None
    except (TypeError, ValueError):
        return None


def correlation(x: pd.Series, y: pd.Series, *, rank: bool = False) -> float | None:
    paired = pd.DataFrame({"x": x, "y": y}).dropna()
    if len(paired) < 3 or paired.x.nunique() < 2 or paired.y.nunique() < 2:
        return None
    if rank:
        paired = paired.rank(method="average")
    return number(paired.x.corr(paired.y))


def summarize(sample: pd.DataFrame, edges: np.ndarray, direction: int, cost_bps: float) -> dict[str, Any]:
    counts = np.searchsorted(edges, sample.factor.to_numpy(), side="right")
    quantiles = []
    for bucket in range(len(edges) + 1):
        returns = sample.forward[counts == bucket]
        quantiles.append({"bucket": bucket + 1, "count": len(returns), "mean_forward_bps": number(returns.mean() * 10000)})
    low, high = quantiles[0]["mean_forward_bps"], quantiles[-1]["mean_forward_bps"]
    # These are overlapping event studies, not self-financing positions.
    # Do not compound them into portfolio returns or annualized Sharpe ratios.
    spread = (high - low) * direction if high is not None and low is not None and len(quantiles) > 1 else None
    favored = sample.forward[counts == (len(edges) if direction == 1 else 0)]
    gross = number(favored.mean() * 10000)
    return {"samples": len(sample), "ic": correlation(sample.factor, sample.forward),
            "rank_ic": correlation(sample.factor, sample.forward, rank=True), "quantiles": quantiles,
            "quantile_spread_bps": spread, "favored_bucket_mean_bps": gross,
            "fee_slippage_adjusted_mean_bps": gross - cost_bps if gross is not None else None,
            "double_cost_mean_bps": gross - 2 * cost_bps if gross is not None else None}


def analyze(frame: pd.DataFrame, factor: dict[str, Any], request: EvaluationRequest) -> dict[str, Any]:
    engine = FactorExpression(factor["expression"], factor["parameters"])
    values = engine.calculate(frame)
    h = request.horizon
    split = int(len(frame) * (1 - request.test_fraction))
    forward = frame.open.shift(-(h + 1)) / frame.open.shift(-1) - 1
    sample = pd.DataFrame({"factor": values, "forward": forward, "ts": frame.ts})
    # Train labels must settle BEFORE the first test candle. Purging is based
    # on original row positions, never on an already dropna-filtered frame.
    train = sample.iloc[:max(0, split - h - 1)].dropna()
    test = sample.iloc[split:].dropna()
    if len(train) < 30 or len(test) < 20:
        raise ValueError(f"insufficient usable samples after warmup/purge: train={len(train)}, test={len(test)} (need 30/20)")
    if train.factor.nunique() < 2:
        raise ValueError("factor is constant in training data; IC and quantile analysis are undefined")
    edges = np.unique(train.factor.quantile([0.2, 0.4, 0.6, 0.8]).to_numpy())
    direction = 1 if factor["direction"] == "higher_is_bullish" else -1
    costs = 2 * (request.fee_bps + request.slippage_bps)
    slices = []
    # Fixed chronological test blocks, not a claim of retrained walk-forward.
    for indices in np.array_split(np.arange(split, len(frame)), 3):
        if len(indices) <= h + 1:
            continue
        block = sample.iloc[indices[:-(h + 1)]].dropna()
        slices.append({"start": int(frame.ts.iloc[indices[0]]), "end": int(frame.ts.iloc[indices[-1]]),
                       **summarize(block, edges, direction, costs)})
    preview = sample.iloc[::max(1, len(sample) // 160)]
    warnings = ["Overlapping forward returns are descriptive, not independent observations or portfolio P&L.",
                "The test window is now inspected; do not reuse it as a locked final test after tuning.",
                "Costs are an entry/exit fee-and-slippage sensitivity check, not an execution simulation."]
    if request.instrument_type == "perpetual":
        warnings.append("Funding, liquidation and mark-price effects are NOT included; adjusted means are not net perpetual returns.")
    if len(edges) < 4:
        warnings.append("Tied training values reduced the number of quantile buckets.")
    if values.iloc[max(0, engine.lookback - 1):].isna().any():
        warnings.append("Undefined formula values after warmup were omitted, never filled with future data.")
    return {"in_sample": summarize(train, edges, direction, costs),
            "out_of_sample": summarize(test, edges, direction, costs), "test_blocks": slices,
            "split": {"test_start": int(frame.ts.iloc[split]), "purge_bars": h + 1,
                      "train_samples": len(train), "test_samples": len(test), "test_fraction": request.test_fraction},
            "quantile_edges": edges.tolist(), "preview": [{"time": int(row.ts), "value": number(row.factor)} for row in preview.itertuples()],
            "warnings": warnings, "pending_checks": ["walk_forward", "parameter_sensitivity", "strategy_ablation", "capacity", "cross_market"],
            "validation_status": "research_only", "performance_evidence": False,
            "label": f"bar-close factor[t] vs open[t+{h + 1}]/open[t+1]-1"}


def evaluate(config: Any, payload: dict[str, Any], *, check_cancel=None) -> dict[str, Any]:
    req = EvaluationRequest.model_validate(payload)
    store = FactorStore(config.paths.root)
    factor = store.get(req.factor_id, req.version)
    market = market_key(req.market)
    step = timeframe_seconds(req.timeframe)
    start, end = resolve_window(start=req.start, end=req.end)
    if (end - start) // step > 200000:
        raise ValueError("factor diagnostics are limited to 200000 bars per run; use a bounded research window")
    run = {"run_id": "factor_" + uuid.uuid4().hex, "factor_id": req.factor_id, "version": req.version,
           "created_at": now(), "engine": ENGINE_VERSION, "status": "running", "request": req.model_dump(),
           "factor_snapshot": factor, "profile": {"asset_class": "crypto", "instrument_type": req.instrument_type,
                "venue": market.partition(":")[0], "market": market, "timeframe": req.timeframe,
                "fee_bps": req.fee_bps, "slippage_bps": req.slippage_bps}, "random_seed": None,
           "implementation_sha256": hashlib.sha256(Path(__file__).read_bytes() + Path(__file__).with_name("expressions.py").read_bytes()).hexdigest()}
    directory = store.safe_path(store.root / "runs" / run["run_id"])
    directory.mkdir(parents=True, exist_ok=False)
    try:
        if check_cancel:
            check_cancel()
        if factor["markets"] and market not in factor["markets"]:
            raise ValueError("market is outside the factor's declared applicability")
        if factor["timeframes"] and req.timeframe not in factor["timeframes"]:
            raise ValueError("timeframe is outside the factor's declared applicability")
        rows = HistoryStore(store_root(config, req.data_dir)).read(market, req.timeframe, start, end)
        quality = coverage(rows, start, end, req.timeframe)
        run["data"] = {**quality, "market": market, "sha256": rows_hash(rows), "source": "verified_local_history"}
        if not quality["complete"]:
            raise ValueError(f"local data incomplete: {quality['missing_bars']} missing bars; use historical_data to repair this exact window")
        frame = pd.DataFrame(rows)[["ts", "open", "high", "low", "close", "volume"]]
        # The mutable shared cache is NOT the immutable experiment dataset.
        snapshot = directory / "candles.csv.gz"
        frame.to_csv(snapshot, index=False, compression={"method": "gzip", "mtime": 0})
        run["data"]["snapshot"] = str(snapshot.relative_to(config.paths.root))
        run["data"]["snapshot_sha256"] = hashlib.sha256(snapshot.read_bytes()).hexdigest()
        analysis = analyze(frame, factor, req)
        comparisons = []
        own = FactorExpression(factor["expression"], factor["parameters"]).calculate(frame)
        test_start = int(len(frame) * (1 - req.test_fraction))
        for reference in req.compare:
            if check_cancel:
                check_cancel()
            if set(reference) != {"factor_id", "version"}:
                raise ValueError("comparisons require exact factor_id and version")
            other = store.get(reference["factor_id"], reference["version"])
            if (other["markets"] and market not in other["markets"]) or (other["timeframes"] and req.timeframe not in other["timeframes"]):
                raise ValueError("comparison factor is outside its declared applicability")
            values = FactorExpression(other["expression"], other["parameters"]).calculate(frame)
            comparisons.append({**reference, "definition_hash": other["definition_hash"], "factor_snapshot": other,
                                "rank_correlation": correlation(own.iloc[test_start:], values.iloc[test_start:], rank=True)})
        if check_cancel:
            check_cancel()
        # Publish metrics only after every requested diagnostic succeeds.
        # A failed comparison must not render as a completed factor report.
        run["analysis"] = {**analysis, "comparisons": comparisons}
        run["status"] = "completed"
    except Exception as exc:
        run["status"] = "cancelled" if type(exc).__name__ == "CancelledError" else "blocked" if isinstance(exc, ValueError) else "failed"
        run["error"] = str(exc)
    run["manifest_path"] = str((directory / "manifest.json").relative_to(config.paths.root))
    from ...backtest.scripts.run_state import atomic_json
    atomic_json(directory / "manifest.json", run)
    store.record(run)
    return {"ok": run["status"] == "completed", "result_type": "factor_evaluation", "run": run}
