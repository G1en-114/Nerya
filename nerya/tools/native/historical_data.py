"""Thin native-tool adapters to the backtest Skill's data preparation script."""
from __future__ import annotations

import time
from typing import Any

from ..types import ToolCall, ToolError, ToolErrorKind, ToolResult, RiskLevel, PermissionScope
from ..registry import make_native_descriptor
from ...harness.cancellation import raise_if_cancelled
from ...skills.builtin.backtest.scripts.history_data import history_operation


HISTORICAL_DATA_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "action": {"type": "string", "enum": ["list", "inspect", "download", "status"]},
        "markets": {"type": "array", "items": {"type": "string"}},
        "timeframes": {"type": "array", "items": {"type": "string"}},
        "start": {"type": "string", "description": "Inclusive UTC date/ISO timestamp, e.g. 2025-01-01."},
        "end": {"type": "string", "description": "Exclusive UTC date/ISO timestamp, e.g. 2026-01-01."},
        "days": {"type": "integer", "minimum": 1},
        "data_dir": {"type": "string", "description": "Optional workspace-relative local data directory."},
        "job_id": {"type": "string"},
        "max_requests": {"type": "integer", "minimum": 1, "maximum": 10000},
        "timeout_seconds": {"type": "number", "minimum": 1, "maximum": 3600},
    }, "required": ["action"],
}


def tool_progress(call: ToolCall):
    last = 0.0
    last_phase = ""
    def publish(details):
        nonlocal last, last_phase
        session_id = str(call.metadata.get("session_id") or "")
        if not session_id:
            return
        phase = str(details.get("phase") or details.get("status") or "")
        now = time.monotonic()
        if now - last < 0.5 and phase == last_phase:
            return
        last, last_phase = now, phase
        data = details.get("data_progress") or details
        labels = {"preflight": "Checking strategy and configuration", "preparing_data": "Preparing local history",
            "downloading": "Downloading missing history", "validating_data": "Checking data coverage",
            "replaying": "Replaying historical candles", "reporting": "Writing report and charts",
            "completed": "Completed", "ready": "Local history ready", "incomplete": "Historical data incomplete"}
        message = labels.get(phase, phase)
        completed = data.get("rows") if data.get("expected_bars") is not None else details.get("bars_processed")
        total = data.get("expected_bars") or details.get("bars_total")
        if data.get("market"):
            message += f" · {data['market']} {data.get('timeframe', '')}"
        if completed is not None and total:
            message += f" · {completed}/{total} candles"
        if data.get("cached_rows") is not None:
            message += f" · reused {data['cached_rows']}, downloaded {data.get('downloaded_rows', 0)}"
        from ...agent.streaming import get_default_bus
        get_default_bus().publish("tool.progress", session_id=session_id, turn_id=call.turn_id,
            tool_call_id=call.id, call_id=call.id, action=call.name,
            phase=phase, status=details.get("status", "running"), message=message,
            progress=min(1.0, completed / total) if isinstance(completed, (int, float)) and total else None,
            details=details)
    return publish


def call_cancellation(call: ToolCall):
    return lambda: raise_if_cancelled(call.metadata.get("cancel_token"), call.metadata.get("turn_deadline_epoch"))


def historical_data_handler(call: ToolCall, *, config) -> ToolResult:
    try:
        result = history_operation(config, call.arguments or {},
            progress=tool_progress(call), check_cancel=call_cancellation(call))
        return ToolResult.from_json(tool_use_id=call.id, name=call.name,
                                   data=result, semantic_success=result.get("ok") is True)
    except Exception as exc:
        result = ToolResult.from_json(tool_use_id=call.id, name=call.name, semantic_success=False,
            data={"ok": False, "result_type": "historical_data", "status": "cancelled" if type(exc).__name__ == "CancelledError" else "failed",
                  "error": type(exc).__name__, "message": str(exc),
                  "resumable": True, "message_hint": "Completed historical segments remain local. Fix the error, then resume the same requested data window."})
        result.is_error = True
        result.error = ToolError(kind=ToolErrorKind.EXECUTION_ERROR, message=str(exc))
        return result


def historical_data_descriptors(config):
    return [make_native_descriptor(name="historical_data",
        description="List, inspect or incrementally download reusable local historical candles without running a strategy. "
            "Use action=download with explicit markets/timeframes/start/end BEFORE a long backtest. "
            "Start is inclusive and end exclusive in UTC. Only missing ranges are fetched; repeated/overlapping requests reuse stored rows. "
            "action=inspect/list never use network. An incomplete receipt is resumable, not proof the source lacks history. "
            "After preparation run strategy_backtest with data_mode=local and the matching config. "
            "Does not activate strategies, place account orders or change global configuration.",
        input_schema=HISTORICAL_DATA_SCHEMA,
        handler=lambda call: historical_data_handler(call, config=config),
        risk=RiskLevel.WRITE, permission_scope=PermissionScope.WORKSPACE,
        risk_classifier=lambda args: RiskLevel.WRITE if args.get("action") == "download" else RiskLevel.READ,
        read_only=False, is_concurrency_safe=False, mutates_paths=True,
        tags=("data", "history", "backtest"), result_kind="json", auto_approve=True)]
