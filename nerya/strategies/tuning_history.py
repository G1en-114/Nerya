"""Recorded review evidence. Never substitute the current strategy for a past run."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from ..core import jsonl
from ..core.atomic_write import atomic_write_text
from ..core.paths import WorkspacePaths
from ..core.redaction import redact_display_dict

_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
_MAX_FILE = 1_048_576
_MAX_INDEX = 8_388_608
_SUMMARY_KEYS = ("run_id", "strategy_id", "status", "reason", "started_at", "finished_at", "duration_ms", "proposal_id", "package_hash", "ts")


def _identifier(value: str) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ValueError("invalid_history_identifier")
    return value


def _root(paths: WorkspacePaths, strategy_id: str) -> Path:
    base = paths.strategies.resolve()
    root = paths.strategy(_identifier(strategy_id))
    if root.is_symlink() or root.resolve().parent != base:
        raise ValueError("history_outside_strategy_root")
    return root.resolve()


def _artifact(root: Path, name: str) -> Path:
    directory = root / "reviews"
    path = directory / name
    if directory.is_symlink() or path.is_symlink() or path.resolve().parent != directory.resolve() or root not in path.resolve().parents:
        raise ValueError("history_outside_strategy_root")
    return path


def _tail(path: Path) -> tuple[list[dict[str, Any]], bool]:
    if not path.is_file():
        return [], False
    with path.open("rb") as stream:
        size = stream.seek(0, 2)
        partial = size > _MAX_INDEX
        stream.seek(max(0, size - _MAX_INDEX))
        if partial:
            stream.readline()  # Discard the first possibly incomplete row.
        raw = stream.read(_MAX_INDEX)
    rows = []
    for line in raw.splitlines():
        if len(line) > _MAX_FILE:
            partial = True
            continue
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                rows.append(value)
        except (ValueError, UnicodeError):
            partial = True
    return rows, partial


def record_tuning_result(paths: WorkspacePaths, result: dict[str, Any]) -> None:
    root = _root(paths, str(result.get("strategy_id") or ""))
    if not root.is_dir():
        return  # Do not create a strategy as a side effect of failed loading.
    run_id = _identifier(str(result.get("run_id") or ""))
    clean = redact_display_dict(result)
    target = _artifact(root, f"tuning_{run_id}_result.json")
    target.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(target, json.dumps(clean, ensure_ascii=False, default=str) + "\n")
    summary = {key: clean[key] for key in _SUMMARY_KEYS if key in clean}
    jsonl.append(_artifact(root, "run-history.jsonl"), summary)


def _records(paths: WorkspacePaths, strategy_id: str) -> tuple[dict[str, dict[str, Any]], bool]:
    root = _root(paths, strategy_id)
    legacy, partial = _tail(paths.journal("strategy_evolution"))
    recent, limited = _tail(_artifact(root, "run-history.jsonl"))
    merged: dict[str, dict[str, Any]] = {}
    for row in legacy + recent:
        run_id = row.get("run_id")
        if row.get("strategy_id") != strategy_id or not isinstance(run_id, str) or not _ID.fullmatch(run_id):
            continue
        merged[run_id] = {**merged.get(run_id, {}), **{k: row[k] for k in _SUMMARY_KEYS if k in row}}
    return merged, partial or limited


def tuning_history(paths: WorkspacePaths, strategy_id: str, *, limit: int = 100, offset: int = 0) -> dict[str, Any]:
    limit, offset = max(1, min(500, int(limit))), max(0, int(offset))
    records, partial = _records(paths, strategy_id)
    rows = sorted(records.values(), key=lambda row: (str(row.get("started_at") or row.get("ts") or ""), str(row["run_id"])), reverse=True)
    page = rows[offset:offset + limit]
    return {"ok": True, "strategy_id": strategy_id, "runs": redact_display_dict(page), "has_more": offset + limit < len(rows), "next_offset": offset + len(page), "partial": partial}


def tuning_record(paths: WorkspacePaths, strategy_id: str, run_id: str) -> dict[str, Any]:
    root = _root(paths, strategy_id)
    _identifier(run_id)
    data: dict[str, Any] = {"ok": True, "strategy_id": strategy_id, "run_id": run_id}
    missing: list[str] = []
    for suffix, key in (("result", "record"), ("audit", "audit")):
        path = _artifact(root, f"tuning_{run_id}_{suffix}.json")
        if not path.is_file():
            missing.append(key)
            continue
        try:
            with path.open("rb") as stream:
                raw = stream.read(_MAX_FILE + 1)
            if len(raw) > _MAX_FILE:
                missing.append(key + ":oversized")
                continue
            value = json.loads(raw)
            if not isinstance(value, dict) or value.get("run_id") != run_id or value.get("strategy_id") != strategy_id:
                raise ValueError("history_record_identity_mismatch")
            data[key] = redact_display_dict(value)
        except (OSError, ValueError) as exc:
            missing.append(f"{key}:{type(exc).__name__}")
    if "record" not in data:
        records, limited = _records(paths, strategy_id)
        if run_id in records:
            data["record"] = redact_display_dict(records[run_id])
        if limited:
            missing.append("history:limited")
    if "record" not in data and "audit" not in data:
        return {"ok": False, "error": "tuning_run_not_found", "run_id": run_id}
    data["partial"] = bool(missing)
    data["missing"] = missing
    return data
