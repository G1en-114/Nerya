"""Unit-explicit SDK candle snapshots shared by live and historical data."""
from __future__ import annotations
from copy import deepcopy
from typing import Any
from ..data.history_store import seconds, timeframe_seconds


def candle_snapshots(rows, timeframe: str) -> list[dict[str, Any]]:
    result = []
    try:
        duration = timeframe_seconds(timeframe) * 1000
    except ValueError:
        duration = None  # Calendar intervals need a calendar-aware close time.
    for raw in rows:
        row = deepcopy(raw)
        stamp = next((row[key] for key in ("ts", "ts_ms", "timestamp_ms", "open_time_ms", "timestamp")
                      if key in row and row[key] is not None), None)
        if stamp is not None:
            opened = seconds(stamp)
            row.update(ts=opened, ts_ms=opened*1000, timestamp_ms=opened*1000, open_time_ms=opened*1000)
            if duration is not None:
                row["close_time_ms"] = opened*1000 + duration
        result.append(row)
    return result


class StateMapping:
    """Mapping conveniences delegate to scoped get/set, including deadlines."""
    def __getitem__(self, key):
        missing = object()
        result = self.get(key, missing)
        if result is missing:
            raise KeyError(key)
        return result

    def __setitem__(self, key, value):
        self.set(key, value)

    def __delitem__(self, key):
        self[key]
        self.delete(key)

    def __contains__(self, key):
        missing = object()
        return self.get(key, missing) is not missing
