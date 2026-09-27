"""Durable phase receipts for replay. This is not an Agent turn state machine."""
from __future__ import annotations

import json
import os
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .....harness.cancellation import raise_if_cancelled


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".writing-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, allow_nan=False, default=str)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class RunTracker:
    def __init__(self, *, progress=None, cancel_token=None):
        self.root: Path | None = None
        self.callback = progress
        self.cancel_token = cancel_token
        self.started = time.monotonic()
        self.last_write = 0.0
        self.state: dict[str, Any] = {"version": 1, "status": "running", "phase": "resolving",
            "created_at": datetime.now(timezone.utc).isoformat()}

    def bind(self, root: Path, *, strategy_id: str, proposal_id: str | None) -> None:
        self.root = root
        self.state.update(strategy_id=strategy_id, proposal_id=proposal_id,
                          backtest_ts=root.name, run_path=str(root))
        self.update({"phase": "preflight"}, force=True)

    def check_cancel(self) -> None:
        raise_if_cancelled(self.cancel_token)

    def update(self, details: dict[str, Any], *, force: bool = False) -> None:
        self.state.update(details)
        now = time.monotonic()
        if not force and now - self.last_write < 0.5:
            return
        self.last_write = now
        self.state["elapsed_seconds"] = round(now - self.started, 3)
        self.state["updated_at"] = datetime.now(timezone.utc).isoformat()
        if self.root:
            atomic_json(self.root / "run.json", self.state)
        if self.callback:
            try:
                self.callback(dict(self.state))
            except Exception:
                # A presentation sink cannot invalidate or restart a replay.
                pass

    def phase(self, name: str, **details) -> None:
        self.check_cancel()
        self.update({"phase": name, "status": "running", **details}, force=True)

    def data_progress(self, receipt: dict[str, Any]) -> None:
        self.check_cancel()
        self.update({"phase": "preparing_data", "data_progress": {
            key: receipt.get(key) for key in ("market", "timeframe", "status", "rows", "expected_bars",
                "cached_rows", "downloaded_rows", "requests", "missing_bars", "job_id")}})

    def fail(self, exc: BaseException) -> None:
        status = "cancelled" if type(exc).__name__ in {"CancelledError", "KeyboardInterrupt"} else "failed"
        details = {"type": type(exc).__name__, "message": str(exc)[:2000],
                   "market": getattr(exc, "market", None), "bar_ts": getattr(exc, "bar_ts", None)}
        self.update({"status": status, "error": details}, force=True)
        if self.root:
            atomic_json(self.root / "failure.json", {**self.state, "details": getattr(exc, "receipt", None)})
        exc.replay_phase = self.state["phase"]
        exc.run_receipt = str(self.root / "run.json") if self.root else None
        exc.failure_path = str(self.root / "failure.json") if self.root else None

    def complete(self, **details) -> None:
        self.update({"status": "completed", "phase": "completed", **details}, force=True)
