"""Per-market chart evidence. Never fetch current prices to fill replay gaps."""
from __future__ import annotations

import copy
import csv
import math
import re
from bisect import bisect_right
from datetime import datetime
from pathlib import Path
from typing import Any

VISUALIZATION_REVISION = 3


def _number(value: Any) -> float | None:
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (ValueError, TypeError, OverflowError):
        return None


def _time(value: Any) -> int | None:
    number = _number(value)
    if number is None and isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                return None
            number = parsed.timestamp()
        except (ValueError, OverflowError):
            return None
    if number is None or number <= 0:
        return None
    return int(number / 1000 if number >= 1e12 else number)


def _interval_seconds(value: Any) -> int:
    match = re.fullmatch(r"(\d+)([smhdw])", str(value or ""))
    return int(match[1]) * {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}[match[2]] if match else 0


def trade_id(row: dict[str, Any], index: int) -> str:
    return str(row.get("trade_id") or f"trade:{index}")


def market_panels(rows: list[dict[str, Any]], trades: list[dict[str, Any]],
                  meta: dict[str, Any], signals: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Keep venue-qualified identities, all simultaneous fills, and explicit GBS signals.

    Marker time is the containing candle's OPEN time; execution_ts retains the
    actual event time. Out-of-range evidence stays in tables, never on a random bar.
    A missing market can only be assigned when the entire run is single-market.
    """
    signals = signals or []
    known = list(dict.fromkeys(str(m) for m in (meta.get("markets") or []) if m))
    known = list(dict.fromkeys([*known, *(str(r["market"]) for r in rows if r.get("market"))]))
    fallback = known[0] if len(known) == 1 else ""
    grouped: dict[str, list[dict[str, Any]]] = {market: [] for market in known}
    for row in rows:
        grouped.setdefault(str(row.get("market") or fallback), []).append(row)
    interval = str(meta.get("tf") or "")
    step = _interval_seconds(interval)
    panels = []
    for market, source in grouped.items():
        candles: dict[int, dict[str, Any]] = {}
        for row in source:
            time = _time(row.get("ts", row.get("time")))
            values = {key: _number(row.get(key)) for key in ("open", "high", "low", "close")}
            if time is None or any(value is None or value <= 0 for value in values.values()):
                continue
            if values["high"] < max(values["open"], values["close"]) or values["low"] > min(values["open"], values["close"]):
                continue
            candles[time] = {"time": time, **values}
        ordered = [candles[time] for time in sorted(candles)]
        times = [row["time"] for row in ordered]
        # Irregular calendars are fine; do not map a fill across a missing bar.
        def bar_time(raw: Any) -> tuple[int, int] | None:
            time = _time(raw)
            if time is None or not times:
                return None
            index = bisect_right(times, time) - 1
            if index < 0:
                return None
            limit = times[index] + step if step else (times[index + 1] if index + 1 < len(times) else times[index] + 1)
            return (times[index], time) if time < limit else None

        markers: list[dict[str, Any]] = []
        for index, trade in enumerate(trades):
            if str(trade.get("market") or fallback) != market:
                continue
            side = str(trade.get("side") or "").lower()
            when = bar_time(trade.get("ts"))
            if not when or side not in ("buy", "sell"):
                continue
            markers.append({"id": trade_id(trade, index), "time": when[0], "execution_ts": when[1],
                "kind": "trade", "market": market, "price": _number(trade.get("price")),
                "position": "belowBar" if side == "buy" else "aboveBar",
                "color": "#10d993" if side == "buy" else "#ef4560",
                "shape": "arrowUp" if side == "buy" else "arrowDown",
                "text": "B" if side == "buy" else "S", "side": side,
                "reason": str(trade.get("reason") or "")})
        gbs_count = 0
        for index, signal in enumerate(signals):
            kind = str(signal.get("signal_kind") or "").lower()
            if kind != "gbs" and not kind.startswith("gbs:"):
                continue
            if str(signal.get("market") or fallback) != market:
                continue
            gbs_count += 1
            when = bar_time(signal.get("ts"))
            if not when:
                continue
            position = str(signal.get("position") or "aboveBar")
            markers.append({"id": f"gbs:{index}", "time": when[0], "execution_ts": when[1],
                "kind": "gbs", "market": market, "price": _number(signal.get("price")),
                "position": position if position in ("aboveBar", "belowBar", "inBar") else "aboveBar",
                "color": "#f5a524", "shape": "circle", "text": "GBS",
                "reason": str(signal.get("reason") or signal.get("reasoning_ref") or "")})
        markers.sort(key=lambda marker: (marker["time"], marker["execution_ts"]))
        panels.append({"id": "price" if len(grouped) == 1 else f"price:{market or 'unattributed'}",
            "type": "candlestick", "title": market or "Unattributed market", "market": market,
            "interval": interval, "gbs_count": gbs_count,
            "series": [{"kind": "candles", "name": market or "OHLC", "data": ordered},
                       {"kind": "markers", "name": "Executions & GBS", "data": markers}]})
    return panels


def read_rows(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    with path.open(encoding="utf-8", newline="") as stream:
        return list(csv.DictReader(stream))


def market_indicator_panels(rows: list[dict[str, Any]], prices: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """RSI observations also belong to one market, never an interleaved series."""
    result = []
    fallback = prices[0].get("market", "") if len(prices) == 1 else ""
    for panel in prices:
        market = panel.get("market", "")
        source = [row for row in rows if str(row.get("market") or fallback) == market]
        keys = sorted({key for row in source for key in row if key.startswith("rsi_")})
        series = []
        for key in keys:
            points = {}
            for row in source:
                time, value = _time(row.get("ts")), _number(row.get(key))
                if time is not None and value is not None:
                    points[time] = {"time": time, "value": value}
            if points:
                series.append({"kind": "line", "name": key, "data": [points[time] for time in sorted(points)]})
        if series:
            result.append({"id": "rsi" if len(prices) == 1 else f"rsi:{market}", "type": "line",
                "title": f"{market} · RSI", "market": market, "series": series,
                "guides": [{"value": 30}, {"value": 70}]})
    return result


def hydrate_market_details(chart: dict[str, Any], root: Path) -> dict[str, Any]:
    """Read-time upgrade of the known native v1 aggregate, without rewriting evidence.

    Custom/freeform charts are left alone. PnL, verdict and non-price series are
    not recalculated. This also makes old, persisted conversations usable.
    """
    meta = chart.get("meta") or {}
    if meta.get("visualization_revision") == VISUALIZATION_REVISION:
        return chart
    panels = chart.get("panels") or []
    ids = {p.get("id") for p in panels}
    native_v2 = meta.get("visualization_revision") == 2 and meta.get("market_details_source") == "recorded_csv"
    if not native_v2 and not {"price", "equity", "drawdown", "rsi", "missed"}.issubset(ids):
        return chart
    if not (root / "ohlcv_indicators_portfolio.csv").is_file():
        return chart
    rows = read_rows(root / "ohlcv_indicators_portfolio.csv")
    trades = read_rows(root / "trades.csv")
    signals = read_rows(root / "signals.csv")
    upgraded = copy.deepcopy(chart)
    if not native_v2:
        prices = market_panels(rows, trades, meta, signals)
        upgraded["panels"] = [*prices, *(p for p in panels if p.get("id") not in ("price", "rsi")), *market_indicator_panels(rows, prices)]
    # 只升级展示契约：补回同一批 CSV 里被截断的明细和覆盖元数据，不重算
    # 收益、不替换历史 K 线、更不把新缓存的数据塞进旧报告。
    import json
    try:
        metrics = json.loads((root / "metrics.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        metrics = {}
    coverage = {key: metrics[key] for key in ("requested_window_days", "requested_window_complete", "data_manifest") if isinstance(metrics, dict) and key in metrics}
    upgraded["meta"] = {**meta, "visualization_revision": VISUALIZATION_REVISION,
        "signals_recorded": (root / "signals.csv").is_file(), "trade_count": len(trades),
        "trades_displayed": len(trades), "market_details_source": "recorded_csv", **coverage}
    records = [{**trade, "trade_id": trade_id(trade, index)} for index, trade in enumerate(trades)]
    columns = list(dict.fromkeys(["trade_id", *(key for row in records for key in row)]))
    table = {"id": "trades", "columns": columns, "rows": [[row.get(key) for key in columns] for row in records]}
    upgraded["tables"] = [*(item for item in upgraded.get("tables", []) if item.get("id") != "trades"), table]
    return upgraded
