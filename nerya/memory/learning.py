"""Close an evidence review into the same scoped, versioned memory store."""
from __future__ import annotations

from typing import Any

from ..evolution.quality import evaluate_learning_candidate
from .runtime import MemoryRuntime
from .store import MemoryConflictError


def remember_review(memory: MemoryRuntime, packet: dict[str, Any], review: dict[str, Any]) -> dict[str, Any]:
    if not packet.get("ok") or not packet.get("has_evidence"):
        return {"ok": False, "error": "review_requires_evidence"}
    owners = set(packet.get("strategies") or {})
    if owners and owners != {memory.strategy_id}:
        return {"ok": False, "error": "cross_strategy_review_forbidden"}
    digest = str(packet.get("evidence_sha256") or "")
    if not digest or review.get("evidence_sha256") != digest:
        return {"ok": False, "error": "evidence_changed_review_again"}
    key = str(review.get("key") or "").strip()
    if not key:
        return {"ok": False, "error": "stable_key_required"}
    conclusion = str(review.get("conclusion") or "").strip()
    refs = [str(packet["snapshot_ref"])]
    quality = evaluate_learning_candidate(conclusion, evidence_refs=refs)
    if not quality.ok:
        return {"ok": False, "error": "low_quality_conclusion", "reasons": quality.reasons}
    try:
        result = memory.remember(
            category="learning", content=conclusion, key=key,
            source="evolution:review", evidence_refs=refs,
            writer_id="reflection", confidence=quality.score,
            expected_memory_id=review.get("expected_memory_id"),
        )
    except MemoryConflictError:
        return {"ok": False, "error": "update_conflict"}
    return {"ok": result.ok or result.skip_reason == "unchanged",
            "skip_reason": result.skip_reason, "scope": memory.default_scope,
            "memory_id": result.record.memory_id if result.record else "",
            "evidence_sha256": digest}
