"""Instrument SDK submissions independently of a strategy's return value."""
from __future__ import annotations

import math
from collections import Counter
from functools import wraps
from typing import Any


def track_submission(method):
    @wraps(method)
    def tracked(self, **kwargs):
        legacy = method.__name__ == "submit_intent"
        if legacy and len(kwargs) == 1 and isinstance(next(iter(kwargs.values())), dict):
            kwargs = dict(next(iter(kwargs.values())))
        event = {"method": method.__name__, "market": str(kwargs.get("market") or ""),
                 "side": str(kwargs.get("side") or ""), "phase": "attempted",
                 "ts": self.clock.ts if self.clock else None}
        self.attempts.append(event)
        before = len(self.pending_orders)
        try:
            raw_confidence = kwargs.get("confidence", None if legacy else 0.0)
            # Legacy submit_intent checks the floor only when confidence was
            # supplied, matching StrategyTradingFacade. Typed methods default 0.
            confidence = None if legacy and raw_confidence is None else float(raw_confidence or 0)
            reason = ""
            if confidence is not None and (not math.isfinite(confidence) or not 0 <= confidence <= 1):
                reason = "invalid_confidence"
            elif self.policy is not None and not self.policy.allow_direct_order:
                reason = "direct_orders_disabled"
            elif self.policy is not None and confidence is not None and confidence < self.policy.min_confidence:
                reason = "confidence_below_minimum"
            if reason:
                event.update(phase="rejected", reject_reason=reason)
                return {"ok": False, "status": "rejected", "reason": reason,
                        "risk_decision": {"ok": False, "mode": "backtest", "reasons": [reason]}}
            result = method(self, **kwargs)
            queued = self.pending_orders[before:]
            event.update(phase="submitted" if queued else "rejected",
                         intent_id=result.get("intent_id"), queued=len(queued))
            for order in queued:
                order["signal_ts"] = event["ts"]
            return result
        except Exception as exc:
            event.update(phase="error", error_kind=type(exc).__name__, error=str(exc)[:500])
            raise
    return tracked


def action_counts(decision: Any) -> dict[str, int]:
    """Keep structured branch labels, never interpret free-form reasons as fills."""
    metadata = getattr(decision, "metadata", None)
    if metadata is None and isinstance(decision, dict):
        metadata = decision.get("metadata", decision)
    actions = metadata.get("actions", []) if isinstance(metadata, dict) else []
    counts: Counter[str] = Counter()
    if isinstance(actions, (list, tuple)):
        for action in actions:
            label = action[1] if isinstance(action, (list, tuple)) and len(action) > 1 else action.get("action") if isinstance(action, dict) else None
            if isinstance(label, str):
                counts[label[:120]] += 1
    return dict(counts)


def execution_evidence(result: Any) -> dict[str, Any]:
    phases = Counter(row.get("phase") for row in result.order_events)
    fills = [row for row in result.trades if row.get("intent_id") and row.get("intent_id") != "forced_close" and not row.get("protection_fill")]
    protective = [row for row in result.trades if row.get("protection_fill")]
    forced = [row for row in result.trades if not row.get("intent_id") or row.get("intent_id") == "forced_close"]
    preflight = [row for row in result.order_events if row.get("phase") == "rejected"]
    rejections = Counter(str(row.get("reject_reason") or "unknown")
                         for row in [*preflight, *result.rejected_signals])
    errors = phases["error"]
    submitted = sum(int(row.get("queued", 0)) for row in result.order_events)
    actions: Counter[str] = Counter()
    for row in result.decisions:
        actions.update(row.get("action_counts") or {})
    return {"orders_submitted": submitted, "orders_filled": len(fills),
            "orders_rejected": len(preflight) + len(result.rejected_signals),
            "sdk_errors": errors, "forced_closes": len(forced), "protective_closes": len(protective),
            "rejection_reasons": dict(rejections), "action_counts": dict(actions),
            "ok_without_orders": sum(row.get("status") == "ok" and not row.get("order_attempts") for row in result.decisions),
            "order_accounting_ok": (submitted == len(fills) + len(result.rejected_signals)
                and result.order_attempts == phases["submitted"] + phases["rejected"] + errors),
            "execution_evidence_version": 1}
