"""Thin native tool: the factor Skill owns methodology and execution."""
from __future__ import annotations

from ..registry import make_native_descriptor
from ..types import PermissionScope, RiskLevel, ToolCall, ToolResult
from ...research.factors import FactorDefinition
from ...skills.builtin.factor_library.scripts.evaluate import EvaluationRequest
from ...skills.builtin.factor_library.scripts.library import operation
from .historical_data import call_cancellation

SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        **EvaluationRequest.model_json_schema()["properties"],
        "action": {"type": "string", "enum": ["list", "get", "save", "evaluate", "export", "data", "backtest", "extract"]},
        "query": {"type": "string"},
        "definition": FactorDefinition.model_json_schema(),
        "expected_version": {"type": "integer", "minimum": 0, "description": "0 for new; exact latest version for edits."},
        "reason": {"type": "string"},
        "source_backtest": {"type": "object", "properties": {"strategy_id": {"type": "string"}, "ts": {"type": "string"}, "proposal_id": {"type": ["string", "null"]}}, "required": ["strategy_id", "ts"], "additionalProperties": False},
        "strategy_id": {"type": "string"}, "ts": {"type": "string"}, "proposal_id": {"type": "string"},
    }, "required": ["action"],
}


def handler(call: ToolCall, *, config) -> ToolResult:
    try:
        result = operation(config, call.arguments or {}, check_cancel=call_cancellation(call))
    except Exception as exc:
        result = {"ok": False, "error": type(exc).__name__, "message": str(exc)}
    result.setdefault("result_type", "factor_library")
    return ToolResult.from_json(tool_use_id=call.id, name=call.name, data=result, semantic_success=result.get("ok") is True)


def factor_library_descriptors(config):
    return [make_native_descriptor(
        name="factor_library", description="Search, extract, save, evaluate or export reusable versioned factors. "
        "Load Skill factor_library for methodology. extract reads the frozen backtest source by strategy_id/ts; "
        "save persists a candidate directly, not a proposal. evaluate requires exact version, market/timeframe/start/end, "
        "instrument_type and fee_bps/slippage_bps; it only reads verified local history, never downloads or trades. "
        "Diagnostics never promote a factor or claim portfolio returns. export pins a version for strategy reuse.",
        input_schema=SCHEMA, handler=lambda call: handler(call, config=config),
        risk=RiskLevel.WRITE, permission_scope=PermissionScope.WORKSPACE,
        risk_classifier=lambda args: RiskLevel.WRITE if args.get("action") in {"save", "evaluate"} else RiskLevel.READ,
        read_only=False, is_concurrency_safe=False, mutates_paths=True,
        tags=("factor", "research", "backtest"), result_kind="json", auto_approve=True)]
