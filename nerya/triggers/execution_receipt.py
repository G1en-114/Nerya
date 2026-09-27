"""Receipt status from observed turn evidence, never from a requested stop."""
from __future__ import annotations


def turn_execution_status(stopped_reason: str | None) -> str:
    reason = str(stopped_reason or "").lower()
    if "approval" in reason:
        return "needs_approval"
    if "cancel" in reason:
        return "cancelled"
    if "error" in reason or "failed" in reason:
        return "failed"
    if reason in {"done", "completed", "final", "final_answer", "end_turn", "stop"}:
        return "completed"
    # Budget, interaction and unknown stop reasons are not proof of completion.
    return "returned"
