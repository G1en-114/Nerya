"""Manifest consistency checks shared by save validation and replay preflight."""
from __future__ import annotations
import math


def configuration_issues(manifest):
    issues = []
    extras = manifest.extras
    params = extras.get("params") or {}
    if not isinstance(params, dict):
        return [("invalid_strategy_params", "params must be a mapping")]
    sizing = params.get("sizing") or {}
    if isinstance(sizing, dict) and sizing.get("method") == "fixed_usd":
        amount = sizing.get("fixed_usd")
        if isinstance(amount, bool) or not isinstance(amount, (int, float)) or not math.isfinite(amount) or amount <= 0:
            issues.append(("invalid_strategy_sizing", "params.sizing.fixed_usd must be finite and positive"))
        elif manifest.policy.max_single_order_usd > 0 and amount > manifest.policy.max_single_order_usd:
            issues.append(("strategy_sizing_policy_conflict",
                f"params.sizing.fixed_usd={amount} exceeds policy.max_single_order_usd={manifest.policy.max_single_order_usd}. "
                "Preserve the operator's requested size and risk limits; correct conflicting template defaults before replay, never silently downsize."))
    if "schedule_enabled" in extras:
        issues.append(("invalid_schedule_field", "schedule_enabled is not a runtime switch; use schedule.enabled: false to disable the schedule."))
    return issues
