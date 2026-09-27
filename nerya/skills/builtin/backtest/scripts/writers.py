"""CSV artifact writers for backtest results."""

from __future__ import annotations

import csv
import json
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

from .engine import BacktestResult


def create_run_dir(strategy_root: Path, *, kind: str = "") -> Path:
    """Atomically allocate a run; concurrent reruns never replace old evidence."""
    folder = strategy_root / "backtests"
    if folder.is_symlink() or not folder.resolve().is_relative_to(strategy_root.resolve()):
        raise ValueError("backtest artifacts must remain inside the strategy package")
    stamp = time.strftime("%Y%m%d_%H%M%S", time.gmtime())
    for attempt in range(1000):
        prefix = (kind + "_") if kind else ""
        if attempt:
            prefix = f"{kind or 'run'}-{attempt}_"
        target = strategy_root / "backtests" / (prefix + stamp)
        try:
            target.mkdir(parents=True, exist_ok=False)
            return target
        except FileExistsError:
            continue
    raise RuntimeError("Too many simultaneous backtests in one second")


def write_csv_artifacts(result: BacktestResult, out_dir: str | Path) -> dict[str, Path]:
    root = Path(out_dir)
    root.mkdir(parents=True, exist_ok=True)
    paths = {
        "ohlcv": root / "ohlcv_indicators_portfolio.csv",
        "trades": root / "trades.csv",
        "analysis": root / "analysis_by_reason.csv",
        "rejected": root / "rejected_signals.csv",
        "equity": root / "equity.csv",
        "benchmark": root / "benchmark.csv",
        "decisions": root / "decisions.csv",
        "signals": root / "signals.csv",
        "orders": root / "order_events.csv",
    }
    _write_rows(paths["ohlcv"], result.ohlcv_rows)
    _write_rows(paths["trades"], result.trades)
    _write_rows(paths["rejected"], result.rejected_signals)
    _write_rows(paths["analysis"], _analysis_by_reason(result.trades))
    _write_rows(paths["equity"], [{"ts": ts, "equity": value} for ts, value in result.equity_series])
    _write_rows(paths["benchmark"], [{"ts": ts, "equity": value} for ts, value in result.benchmark_series])
    _write_rows(paths["decisions"], result.decisions)
    _write_rows(paths["signals"], result.signals)
    _write_rows(paths["orders"], result.order_events)
    return paths


def _write_rows(path: Path, rows: list[dict[str, Any]]) -> None:
    keys: list[str] = []
    for row in rows:
        for key in row:
            if key not in keys:
                keys.append(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=keys or ["empty"])
        writer.writeheader()
        for row in rows:
            writer.writerow({key: json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list, tuple)) else value for key, value in row.items()})


def _analysis_by_reason(trades: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for trade in trades:
        grouped[str(trade.get("reason") or "unknown")].append(trade)
    out: list[dict[str, Any]] = []
    for reason, rows in sorted(grouped.items()):
        pnl = sum(float(r.get("pnl", 0.0) or 0.0) for r in rows)
        out.append({
            "reason": reason,
            "trades": len(rows),
            "total_notional": sum(float(r.get("notional", 0.0) or 0.0) for r in rows),
            "total_fees": sum(float(r.get("fee", 0.0) or 0.0) for r in rows),
            "total_pnl": pnl,
        })
    return out
