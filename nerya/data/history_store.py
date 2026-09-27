"""Transactional historical candle storage. No network, strategy or model IO.

All windows are UTC [start, end), timestamps are candle open times in seconds.
The database is a local file; SQLite is part of Python's standard library.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator


class HistoryDataError(ValueError):
    """Invalid or untrustworthy historical input; never silently fabricate it."""
    reason = "backtest_data_invalid"


def timeframe_seconds(value: str) -> int:
    # Uppercase M is a calendar month, not a minute. Do not lowercase it.
    match = re.fullmatch(r"([1-9][0-9]*)([smhdw])", str(value))
    if not match:
        raise HistoryDataError(f"unsupported fixed timeframe: {value!r}")
    return int(match[1]) * {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}[match[2]]


def seconds(value: Any) -> int:
    if isinstance(value, bool):
        raise HistoryDataError("boolean timestamp is invalid")
    try:
        number = float(value)
        if not math.isfinite(number) or number <= 0:
            raise ValueError()
        stamp = int(number)
        while stamp >= 100_000_000_000:
            stamp //= 1000
        return stamp
    except (TypeError, ValueError, OverflowError) as exc:
        raise HistoryDataError(f"invalid candle timestamp: {value!r}") from exc


def market_key(market: str) -> str:
    venue, sep, symbol = str(market).strip().partition(":")
    if not sep or not re.fullmatch(r"[A-Za-z0-9_]+", venue) or not symbol.strip():
        raise HistoryDataError("historical data requires an explicit VENUE:SYMBOL market")
    if len(market) > 512 or any(ord(c) < 32 for c in market):
        raise HistoryDataError("invalid market identifier")
    # Preserve case-sensitive on-chain identifiers. Market is a SQL value, not
    # a filesystem component; punctuation cannot escape the data directory.
    return venue.upper() + ":" + symbol.strip()


def is_sample(market: str, row: dict[str, Any]) -> bool:
    envelope = row.get("_envelope") or {}
    labels = {str(row.get("source", "")).lower(), str(row.get("data_kind", "")).lower()}
    if isinstance(envelope, dict):
        labels.update(str(envelope.get(k, "")).lower() for k in ("mode", "truth", "source"))
    return (market.split(":", 1)[0].upper() in {"MOCK", "PAPER"}
            or bool(row.get("fixture")) or bool(labels & {"mock", "paper", "sample", "synthetic"}))


def normalize_row(row: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(row, dict):
        raise HistoryDataError("candle must be an OHLCV mapping")
    stamp = seconds(row.get("ts", row.get("ts_ms", row.get("timestamp"))))
    try:
        values = {k: float(row[k]) for k in ("open", "high", "low", "close", "volume")}
    except (ValueError, TypeError, KeyError) as exc:
        raise HistoryDataError(f"invalid OHLCV at {stamp}") from exc
    if not all(math.isfinite(v) for v in values.values()):
        raise HistoryDataError(f"non-finite OHLCV at {stamp}")
    if min(values[k] for k in ("open", "high", "low", "close")) <= 0 or values["volume"] < 0:
        raise HistoryDataError(f"non-positive price or negative volume at {stamp}")
    if values["low"] > min(values["open"], values["close"]) or values["high"] < max(values["open"], values["close"]):
        raise HistoryDataError(f"OHLC range is inconsistent at {stamp}")
    normalized: dict[str, Any] = {"ts": stamp, **values}
    # Preserve truth and useful source fields instead of stripping mock labels.
    for key in ("_envelope", "source", "data_kind", "fixture", "volume_available", "price_currency"):
        if key in row:
            normalized[key] = row[key]
    return normalized


def rows_hash(rows: Iterable[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for row in rows:
        digest.update(json.dumps(row, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode())
        digest.update(b"\n")
    return digest.hexdigest()


def window_grid(start: int, end: int, tf: str) -> tuple[int, int, int]:
    step = timeframe_seconds(tf)
    if end <= start:
        raise HistoryDataError("historical end must be after start")
    anchor = 345600 if tf.endswith("w") else 0  # Monday, 1970-01-05 UTC.
    first = anchor + ((int(start) - anchor + step - 1) // step) * step
    stop = anchor + ((int(end) - anchor + step - 1) // step) * step
    return first, stop, step


def coverage(rows: Iterable[dict[str, Any]], start: int, end: int, tf: str) -> dict[str, Any]:
    """Coverage of expected 24/7 opens without materializing a huge time grid."""
    first, stop, step = window_grid(start, end, tf)
    stamps = sorted({int(row["ts"]) for row in rows if start <= int(row["ts"]) < end})
    cursor = first
    gaps: list[dict[str, int]] = []
    aligned = 0
    for stamp in stamps:
        if (stamp - first) % step or stamp < first or stamp >= stop:
            continue
        aligned += 1
        if stamp > cursor:
            gaps.append({"start": cursor, "end": stamp, "bars": (stamp - cursor) // step})
        cursor = stamp + step
    if cursor < stop:
        gaps.append({"start": cursor, "end": stop, "bars": (stop - cursor) // step})
    expected = max(0, (stop - first) // step)
    return {"start": start, "end": end, "end_exclusive": True, "timeframe": tf,
            "rows": len(stamps), "expected_bars": expected, "aligned_bars": aligned,
            "first_ts": stamps[0] if stamps else None, "last_ts": stamps[-1] if stamps else None,
            "missing_bars": max(0, expected - aligned), "missing_ranges": gaps,
            "coverage_ratio": aligned / expected if expected else 1.0,
            "complete": bool(expected and aligned == expected), "calendar": "24x7"}


class HistoryStore:
    """One row per market/timeframe/open-time, committed a segment at a time."""

    def __init__(self, root: str | Path):
        self.root = Path(root).expanduser().resolve()
        self.path = self.root / "history-v2.sqlite3"

    @contextmanager
    def _connection(self, *, write: bool = False) -> Iterator[sqlite3.Connection]:
        if self.path.is_symlink():
            raise HistoryDataError("history database must not be a symlink")
        if write:
            self.root.mkdir(parents=True, exist_ok=True)
            if self.path.is_symlink():
                raise HistoryDataError("history database must not be a symlink")
            con = sqlite3.connect(self.path, timeout=30)
        else:
            con = sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True, timeout=30)
        try:
            con.row_factory = sqlite3.Row
            con.execute("PRAGMA busy_timeout=30000")
            if write:
                # WAL is a database-level mode, not per-connection setup. Do
                # not renegotiate it for every history batch: concurrent data
                # workers previously raced here and could surface transient
                # SQLITE_BUSY / disk I/O errors on a healthy database.
                current = con.execute("PRAGMA journal_mode").fetchone()
                if str(current[0] if current else "").lower() != "wal":
                    for attempt in range(8):
                        try:
                            mode = con.execute("PRAGMA journal_mode=WAL").fetchone()
                            if str(mode[0] if mode else "").lower() == "wal":
                                break
                            raise sqlite3.OperationalError("failed to enable WAL journal mode")
                        except sqlite3.OperationalError as exc:
                            try:
                                check = con.execute("PRAGMA journal_mode").fetchone()
                                if str(check[0] if check else "").lower() == "wal":
                                    break
                            except sqlite3.Error:
                                pass
                            if not any(token in str(exc).lower() for token in ("locked", "busy")) or attempt == 7:
                                raise
                            time.sleep(min(0.01 * 2 ** attempt, 0.2))
                con.execute("PRAGMA synchronous=FULL")
                con.executescript("""
                    CREATE TABLE IF NOT EXISTS candles (
                        market TEXT NOT NULL, timeframe TEXT NOT NULL, ts INTEGER NOT NULL,
                        payload TEXT NOT NULL, source TEXT NOT NULL, verified INTEGER NOT NULL,
                        updated_at REAL NOT NULL,
                        PRIMARY KEY (market, timeframe, ts)
                    ) WITHOUT ROWID;
                    CREATE TABLE IF NOT EXISTS imports (
                        path TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, imported_at REAL NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS history_jobs (
                        id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at REAL NOT NULL
                    );
                """)
            yield con
            if write:
                con.commit()
        except Exception:
            if write:
                con.rollback()
            raise
        finally:
            con.close()

    def put(self, market: str, tf: str, rows: Iterable[dict[str, Any]], *, source: str,
            verified: bool = True, closed_before: int | None = None) -> int:
        key = market_key(market)
        step = timeframe_seconds(tf)
        cutoff = int(time.time()) if closed_before is None else int(closed_before)
        unique: dict[int, dict[str, Any]] = {}
        for row in rows:
            if is_sample(key, row):
                raise HistoryDataError("sample/mock data cannot enter the historical store")
            item = normalize_row(row)
            first, _, _ = window_grid(item["ts"], item["ts"] + step, tf)
            if first != item["ts"]:
                raise HistoryDataError(f"off-grid candle for {tf} at {item['ts']}; refusing mixed timeframes")
            if item["ts"] + step > cutoff:
                continue  # A forming candle is not immutable historical evidence.
            unique[item["ts"]] = item
        if not unique:
            return 0
        if not source.strip():
            raise HistoryDataError("historical rows require a source identifier")
        now = time.time()
        values = [(key, tf, ts, json.dumps(row, ensure_ascii=False, allow_nan=False, sort_keys=True),
                   source, int(verified), now) for ts, row in sorted(unique.items())]
        with self._connection(write=True) as con:
            con.executemany("""INSERT INTO candles VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(market, timeframe, ts) DO UPDATE SET
                  payload=excluded.payload, source=excluded.source,
                  verified=excluded.verified, updated_at=excluded.updated_at
                WHERE excluded.verified >= candles.verified""", values)
        return len(values)

    def read(self, market: str, tf: str, start: int, end: int, *, verified_only: bool = True) -> list[dict[str, Any]]:
        key = market_key(market)
        window_grid(start, end, tf)
        if not self.path.exists():
            return []
        query = "SELECT payload FROM candles WHERE market=? AND timeframe=? AND ts>=? AND ts<?"
        if verified_only:
            query += " AND verified=1"
        with self._connection() as con:
            try:
                return [json.loads(row[0]) for row in con.execute(query + " ORDER BY ts", (key, tf, start, end))]
            except sqlite3.OperationalError as exc:
                if "no such table: candles" in str(exc):
                    return []  # Another writer has created the file, not yet its schema.
                raise

    def inspect(self, market: str, tf: str, start: int, end: int) -> dict[str, Any]:
        rows = self.read(market, tf, start, end)
        return {"market": market_key(market), **coverage(rows, start, end, tf),
                "sha256": rows_hash(rows), "store_path": str(self.path)}

    def inventory(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        with self._connection() as con:
            return [dict(row) for row in con.execute("""SELECT market, timeframe,
                COUNT(*) AS rows, MIN(ts) AS first_ts, MAX(ts) AS last_ts,
                SUM(verified) AS verified_rows, MAX(updated_at) AS updated_at,
                GROUP_CONCAT(DISTINCT source) AS sources
                FROM candles GROUP BY market, timeframe ORDER BY market, timeframe""")]

    def available_timeframes(self, market: str) -> list[str]:
        """Verified local timeframes for one exact market, shortest first."""
        key = market_key(market)
        if not self.path.exists():
            return []
        with self._connection() as con:
            try:
                rows = con.execute(
                    "SELECT DISTINCT timeframe FROM candles WHERE market=? AND verified=1",
                    (key,),
                ).fetchall()
            except sqlite3.OperationalError as exc:
                if "no such table: candles" in str(exc):
                    return []
                raise
        values = [str(row[0]) for row in rows]
        return sorted(values, key=lambda value: (timeframe_seconds(value), value))

    def record_job(self, receipt: dict[str, Any]) -> None:
        with self._connection(write=True) as con:
            con.execute("INSERT OR REPLACE INTO history_jobs VALUES (?, ?, ?)",
                        (receipt["job_id"], json.dumps(receipt, ensure_ascii=False, allow_nan=False), time.time()))

    def job(self, job_id: str) -> dict[str, Any] | None:
        if not self.path.exists():
            return None
        with self._connection() as con:
            row = con.execute("SELECT payload FROM history_jobs WHERE id=?", (job_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def migrate_legacy(self, market: str, tf: str, directory: Path) -> dict[str, Any]:
        """Explicit, non-destructive import. Missing old truth is NOT verified."""
        key = market_key(market)
        timeframe_seconds(tf)
        receipt: dict[str, Any] = {"imported_rows": 0, "files": 0, "errors": [], "verified": False}
        for path in sorted(directory.glob("*.parquet")):
            if path.is_symlink() or not re.fullmatch(r"[0-9]+_[0-9]+\.parquet", path.name):
                continue
            try:
                data = path.read_bytes()
                fingerprint = hashlib.sha256(data).hexdigest()
                with self._connection(write=True) as con:
                    old = con.execute("SELECT fingerprint FROM imports WHERE path=?", (str(path.resolve()),)).fetchone()
                if old and old[0] == fingerprint:
                    continue
                rows = json.loads(data)
                if not isinstance(rows, list):
                    raise HistoryDataError("legacy file is not a candle list")
                receipt["imported_rows"] += self.put(key, tf, rows, source="legacy_unverified", verified=False)
                with self._connection(write=True) as con:
                    con.execute("INSERT OR REPLACE INTO imports VALUES (?, ?, ?)", (str(path.resolve()), fingerprint, time.time()))
                receipt["files"] += 1
            except (OSError, ValueError, TypeError) as exc:
                receipt["errors"].append({"file": path.name, "error": str(exc)[:300]})
        return receipt
