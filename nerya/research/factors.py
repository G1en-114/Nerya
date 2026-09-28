"""Workspace-local metadata registry with immutable definitions and runs.

No default factors, external database, trading calls or automatic promotion.
An evaluation is evidence about one version and one market, not a global badge.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictFloat

from ..skills.builtin.factor_library.scripts.expressions import FactorExpression


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def encode(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def digest(value: Any) -> str:
    return hashlib.sha256(encode(value).encode()).hexdigest()


class FactorDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    factor_id: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$")
    name: str = Field(min_length=1, max_length=160)
    category: Literal["momentum", "trend", "volatility", "volume", "mean_reversion", "custom"] = "custom"
    expression: str = Field(min_length=1, max_length=2000)
    parameters: dict[str, StrictFloat] = Field(default_factory=dict)
    description: str = Field(default="", max_length=4000)
    hypothesis: str = Field(default="", max_length=4000)
    direction: Literal["higher_is_bullish", "lower_is_bullish"] = "higher_is_bullish"
    markets: list[str] = Field(default_factory=list, max_length=100)
    timeframes: list[str] = Field(default_factory=list, max_length=20)
    tags: list[str] = Field(default_factory=list, max_length=20)
    status: Literal["candidate", "retired", "rejected"] = "candidate"


class FactorStore:
    def __init__(self, workspace: str | Path):
        self.workspace = Path(workspace).resolve()
        self.root = self.workspace / "artifacts" / "factors"
        self.path = self.root / "library.sqlite3"

    def safe_path(self, path: Path) -> Path:
        if path.is_symlink() or not path.resolve().is_relative_to(self.workspace):
            raise ValueError("factor artifacts must remain inside the workspace; symlinks are not allowed")
        for parent in path.parents:
            if parent == self.workspace:
                break
            if parent.is_symlink():
                raise ValueError("factor artifact parents must not be symlinks")
        return path

    @contextmanager
    def connection(self, *, write: bool = False):
        self.safe_path(self.path)
        if write:
            self.root.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(str(self.path) if write else self.path.as_uri() + "?mode=ro", uri=not write, timeout=30)
        con.row_factory = sqlite3.Row
        try:
            if write:
                con.executescript("""
                    CREATE TABLE IF NOT EXISTS factor_versions (
                        factor_id TEXT NOT NULL, version INTEGER NOT NULL,
                        fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
                        PRIMARY KEY(factor_id, version));
                    CREATE TABLE IF NOT EXISTS factor_runs (
                        run_id TEXT PRIMARY KEY, factor_id TEXT NOT NULL,
                        version INTEGER NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);
                    CREATE INDEX IF NOT EXISTS factor_runs_version ON factor_runs(factor_id, version);
                """)
                con.execute("BEGIN IMMEDIATE")
            yield con
            if write:
                con.commit()
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()

    def get(self, factor_id: str, version: int | None = None) -> dict[str, Any]:
        if version is not None and (type(version) is not int or version < 1):
            raise ValueError("factor version must be a positive integer, not a boolean, string or float")
        if not self.path.exists():
            raise ValueError("factor not found")
        with self.connection() as con:
            row = con.execute("SELECT payload FROM factor_versions WHERE factor_id=?" +
                              (" AND version=?" if version is not None else " ORDER BY version DESC LIMIT 1"),
                              (factor_id, version) if version is not None else (factor_id,)).fetchone()
        if row is None:
            raise ValueError("factor version not found")
        return json.loads(row[0])

    def list(self, query: str = "") -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        with self.connection() as con:
            rows = con.execute("""SELECT v.payload,
                (SELECT COUNT(*) FROM factor_runs r WHERE r.factor_id=v.factor_id AND r.version=v.version) AS runs
                FROM factor_versions v JOIN
                (SELECT factor_id, MAX(version) AS version FROM factor_versions GROUP BY factor_id) latest
                USING(factor_id,version) ORDER BY v.factor_id""").fetchall()
        items = [{**json.loads(row[0]), "run_count": row[1]} for row in rows]
        needle = query.lower().strip()
        return [item for item in items if not needle or needle in " ".join(str(item.get(k, "")) for k in
                ("factor_id", "name", "category", "description", "tags", "expression")).lower()]

    def sourced_from(self, identity: dict[str, Any]) -> list[dict[str, Any]]:
        """Keep historical extraction links even after a newer version changes source."""
        if not self.path.exists():
            return []
        with self.connection() as con:
            rows = con.execute("SELECT payload FROM factor_versions ORDER BY factor_id, version DESC").fetchall()
        matches: dict[str, dict[str, Any]] = {}
        for row in rows:
            factor = json.loads(row[0])
            source = factor.get("source_backtest") or {}
            if factor["factor_id"] not in matches and all(source.get(key) == value for key, value in identity.items()):
                matches[factor["factor_id"]] = factor
        return list(matches.values())

    def save(self, definition: dict[str, Any], *, expected_version: int, reason: str,
             source_backtest: dict[str, Any] | None = None) -> dict[str, Any]:
        parsed = FactorDefinition.model_validate(definition)
        if type(expected_version) is not int or expected_version < 0:
            raise ValueError("expected_version must be a nonnegative integer")
        from ..data.history_store import market_key, timeframe_seconds
        parsed.name = parsed.name.strip()
        if not parsed.name:
            raise ValueError("factor name must not be blank")
        parsed.markets = list(dict.fromkeys(market_key(value) for value in parsed.markets))
        parsed.timeframes = list(dict.fromkeys(value.strip() for value in parsed.timeframes))
        for timeframe in parsed.timeframes:
            timeframe_seconds(timeframe)
        engine = FactorExpression(parsed.expression, parsed.parameters)
        if not reason.strip() or len(reason) > 2000:
            raise ValueError("a change reason is required (at most 2000 characters)")
        fingerprint = digest({"expression": engine.canonical, "parameters": parsed.parameters, "direction": parsed.direction})
        with self.connection(write=True) as con:
            previous = con.execute("SELECT version,payload FROM factor_versions WHERE factor_id=? ORDER BY version DESC LIMIT 1", (parsed.factor_id,)).fetchone()
            current = previous[0] if previous else 0
            if isinstance(expected_version, bool) or expected_version != current:
                raise ValueError(f"version conflict: expected {expected_version}, current {current}; reload before saving")
            old = json.loads(previous[1]) if previous else {}
            item = {**parsed.model_dump(), "version": current + 1, "fingerprint": fingerprint,
                    "inputs": sorted(engine.inputs), "lookback": engine.lookback, "available_at": "bar_close",
                    "missing_values": "preserve_nan", "created_at": old.get("created_at", now()),
                    "updated_at": now(), "change_reason": reason.strip(),
                    "source_backtest": source_backtest if source_backtest is not None else old.get("source_backtest")}
            item["definition_hash"] = digest({key: item[key] for key in ("factor_id", "version", "expression", "parameters", "direction")})
            con.execute("INSERT INTO factor_versions VALUES (?,?,?,?)", (parsed.factor_id, item["version"], fingerprint, encode(item)))
            duplicates = [row[0] for row in con.execute("SELECT DISTINCT factor_id FROM factor_versions WHERE fingerprint=? AND factor_id<>?", (fingerprint, parsed.factor_id))]
        return {"factor": item, "duplicates": duplicates}

    def detail(self, factor_id: str, version: int | None = None) -> dict[str, Any]:
        factor = self.get(factor_id, version)
        with self.connection() as con:
            versions = [json.loads(row[0]) for row in con.execute("SELECT payload FROM factor_versions WHERE factor_id=? ORDER BY version DESC", (factor_id,))]
            runs = [json.loads(row[0]) for row in con.execute("SELECT payload FROM factor_runs WHERE factor_id=? AND version=? ORDER BY created_at DESC LIMIT 100", (factor_id, factor["version"]))]
        return {"factor": factor, "versions": versions, "runs": runs}

    def record(self, run: dict[str, Any]) -> None:
        self.get(run["factor_id"], run["version"])
        with self.connection(write=True) as con:
            con.execute("INSERT INTO factor_runs VALUES (?,?,?,?,?)", (run["run_id"], run["factor_id"], run["version"], run["created_at"], encode(run)))
