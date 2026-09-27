"""One scoped interface for Nerya memory reads, writes, and lifecycle."""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from typing import Iterable

from ..core.config import Config
from .activity import MemoryActivityEvent, MemoryActivityLog
from .content_scanner import scan_memory_content
from .context_fence import build_memory_context_block, sanitize_context
from .notebook import ENTRY_DELIMITER, VALID_TARGETS, load_notebook
from .projection import MemoryProjection
from .store import MemoryConflictError, MemoryRecord, MemoryScopeError, MemoryStore
from .write_rules import (
    NOTEBOOK_CATEGORIES,
    NOTEBOOK_TARGET_BY_CATEGORY,
    load_write_rules,
)


@dataclass(frozen=True)
class MemoryRememberResult:
    ok: bool
    skipped: bool = False
    skip_reason: str = ""
    record: MemoryRecord | None = None


@dataclass(frozen=True)
class MemoryContext:
    """Stable prompt prefix and query-dependent per-turn recall."""

    stable: str = ""
    dynamic: str = ""
    recalled: tuple[MemoryRecord, ...] = ()
    external_sources: tuple[str, ...] = ()
    metadata: dict = field(default_factory=dict)


class MemoryRuntime:
    """Memory service bound to one trusted actor/session/strategy scope.

    SQLite owns managed notebook identity/version; Markdown is its bounded
    text mirror. Legacy file-only entries remain readable and are adopted on
    explicit curation. All API/provider/runtime writes take the actor service
    lock; divergent external edits fail closed instead of guessing an owner.
    """

    def __init__(
        self,
        config: Config,
        *,
        actor_id: str = "default",
        session_id: str = "",
        strategy_id: str = "",
        workflow_id: str = "",
    ) -> None:
        self.config = config
        from .scope import memory_actor
        self.actor_id = self._required_actor_id(memory_actor(actor_id))
        self.session_id = self._clean_id(session_id, "session_id")
        self.strategy_id = self._clean_id(strategy_id, "strategy_id")
        self.workflow_id = self._clean_id(workflow_id, "workflow_id")
        self.activity = MemoryActivityLog(config=config)
        self.store = MemoryStore(config.paths.db)
        self._projection = MemoryProjection(config, self.store)
        self._notebook_error = ""
        self._notebook = None
        self._notebook_snapshot = []
        try:
            self._notebook = load_notebook(config, actor_id=self.actor_id)
            with self._notebook.service_lock():
                for target in VALID_TARGETS:
                    self._notebook_snapshot.extend(self._notebook_state(target)["records"])
        except (OSError, UnicodeError):
            self._notebook_error = "notebook_unreadable"

    @property
    def use_enabled(self) -> bool:
        return bool(self.config.get("memory.use_enabled", True))

    @property
    def auto_save_enabled(self) -> bool:
        return bool(self.config.get("memory.auto_save_enabled", self.config.get("agent.native.memory_write_on_turn", False)))

    def policy(self) -> dict:
        return {"use_enabled": self.use_enabled, "auto_save_enabled": self.auto_save_enabled,
                "effective": "next_recall_or_context", "notebook_snapshot": "runtime_creation"}

    def remember(self, **kwargs) -> MemoryRememberResult:
        if str(kwargs.get("category") or "").strip() in NOTEBOOK_CATEGORIES:
            if self._notebook is None:
                raise OSError("notebook_unreadable")
            with self._notebook.service_lock():
                return self._remember(**kwargs)
        return self._remember(**kwargs)

    def _remember(
        self,
        *,
        category: str,
        content: str,
        scope: str = "auto",
        key: str = "",
        title: str = "",
        tags: Iterable[str] | None = None,
        source: str = "",
        source_turn_id: str = "",
        evidence_refs: Iterable[str] | None = None,
        writer_id: str = "runtime",
        confidence: float = 1.0,
        importance: float = 0.5,
        expected_memory_id: str | None = None,
        automatic: bool = False,
    ) -> MemoryRememberResult:
        if automatic and not self.auto_save_enabled:
            return MemoryRememberResult(ok=False, skipped=True, skip_reason="auto_save_disabled")
        scope = self.write_scope(scope)
        body = str(content or "").strip()
        category_name = str(category or "").strip()
        key_name = str(key or "").strip()
        title_text = str(title or "").strip()
        source_ref = str(source or "").strip()
        source_turn = str(source_turn_id or "").strip()
        writer_name = str(writer_id or "runtime").strip() or "runtime"
        tag_values = tuple(str(tag or "").strip() for tag in (tags or ()))
        evidence_values = tuple(
            str(reference or "").strip() for reference in (evidence_refs or ())
        )
        scanned_fields = (
            ("category", category_name),
            ("content", body),
            ("key", key_name),
            ("title", title_text),
            ("source", source_ref),
            ("source_turn_id", source_turn),
            ("writer_id", writer_name),
            *(("tag", value) for value in tag_values),
            *(("evidence_ref", value) for value in evidence_values),
        )
        unsafe = next(
            (
                (field, error)
                for field, value in scanned_fields
                if value and (error := scan_memory_content(value))
            ),
            None,
        )
        if unsafe is not None:
            unsafe_field, scan_error = unsafe
            return self._skipped(
                "",
                "unsafe_content",
                "",
                "",
                "[blocked unsafe memory content]",
                "",
                extra={
                    "scanner_error": scan_error,
                    "scanner_field": unsafe_field,
                },
            )
        if not body:
            return self._skipped(
                category_name,
                "empty_content",
                key_name,
                title_text,
                body,
                source_ref,
            )
        rule = load_write_rules(self.config).get(category_name)
        if rule is None:
            return self._skipped(
                category_name,
                "unknown_category",
                key_name,
                title_text,
                body,
                source_ref,
            )
        if not rule.enabled:
            return self._skipped(
                category_name,
                "disabled",
                key_name,
                title_text,
                body,
                source_ref,
            )
        if rule.category in NOTEBOOK_CATEGORIES:
            if str(scope or "").strip().lower() != "global":
                raise MemoryScopeError("notebook memory only supports global scope")
            target = NOTEBOOK_TARGET_BY_CATEGORY[rule.category]
            self._unit_interval(confidence, "confidence")
            self._unit_interval(importance, "importance")
            self._notebook.revision(target)
            records = self._notebook_records(target)
            if ENTRY_DELIMITER in body:
                return self._skipped(category_name, "notebook_entry_delimiter", key_name, title_text, body, source_ref)
            if any(r.content not in self._notebook.entries(target) for r in records):
                raise MemoryConflictError("notebook file and record differ; reconcile before updating")
            if not key_name:
                duplicate = next((r for r in records if r.content == body), None)
                key_name = duplicate.stable_key if duplicate else "notebook." + target + "." + hashlib.sha256(body.encode()).hexdigest()
            existing = self.store.active_by_key(
                actor_id=self.actor_id,
                scope="global",
                scope_id="",
                stable_key=key_name,
            )
            if existing is not None and existing.category != rule.category:
                raise MemoryConflictError("a stable fact key cannot change category")
            if expected_memory_id is not None and (existing.memory_id if existing else "") != expected_memory_id:
                raise MemoryConflictError("memory changed; recall before updating")
            if existing is not None and existing.content not in self._notebook.entries(target):
                raise MemoryConflictError("notebook file and record differ; reconcile before updating")
            if any(r.content == body and r.memory_id != (existing.memory_id if existing else "") for r in records):
                raise MemoryConflictError("notebook content already belongs to another record")
            if existing is not None and existing.content == body:
                self._write_ok(
                    category_name,
                    key_name,
                    title_text,
                    body,
                    source_ref,
                    extra={"notebook_target": target, "duplicate": True},
                )
                return MemoryRememberResult(ok=True, record=existing)
            file_already_contained_body = body in self._notebook.entries(target)
            result = (
                self._notebook.replace(target, existing.content, body)
                if existing is not None
                else self._notebook.add(target, body)
            )
            if not result.ok:
                return self._skipped(
                    category_name,
                    "notebook_rejected",
                    key_name,
                    title_text,
                    body,
                    source_ref,
                    extra={"notebook_error": result.error},
                )
            try:
                stored = self.store.remember(
                    actor_id=self.actor_id,
                    writer_id=writer_name,
                    scope="global",
                    scope_id="",
                    strategy_id="",
                    session_id="",
                    category=rule.category,
                    content=body,
                    stable_key=key_name,
                    title=title_text,
                    tags=tag_values,
                    source_ref=source_ref,
                    source_turn_id=source_turn,
                    evidence_refs=evidence_values,
                    confidence=self._unit_interval(confidence, "confidence"),
                    importance=self._unit_interval(importance, "importance"),
                    retention_days=0,
                    max_entries=0,
                    dedupe=rule.dedupe,
                    target_files=(),
                    expected_memory_id=expected_memory_id,
                )
            except BaseException:
                if existing is not None:
                    self._notebook.replace(target, body, existing.content)
                elif not file_already_contained_body:
                    self._notebook.remove(target, body)
                raise
            self._write_ok(
                category_name,
                key_name,
                title_text,
                body,
                source_ref,
                extra={
                    "notebook_target": target,
                    "memory_id": stored.record.memory_id,
                },
            )
            return MemoryRememberResult(ok=True, record=stored.record)
        scope_name, scope_id, strategy_id, session_id = self._resolve_scope(scope)
        if scope_name == "strategy":
            target_files = [f"strategies/{strategy_id}/learnings.md"]
        elif scope_name in {"session", "workflow"}:
            target_files = []
        else:
            target_files = rule.target_files
        stored = self.store.remember(
            actor_id=self.actor_id,
            writer_id=writer_name,
            scope=scope_name,
            scope_id=scope_id,
            strategy_id=strategy_id,
            session_id=session_id,
            workflow_id=self.workflow_id if scope_name in {"workflow", "session"} else "",
            expected_memory_id=expected_memory_id,
            category=rule.category,
            content=body,
            stable_key=key_name,
            title=title_text,
            tags=tag_values,
            source_ref=source_ref,
            source_turn_id=source_turn,
            evidence_refs=evidence_values,
            confidence=self._unit_interval(confidence, "confidence"),
            importance=self._unit_interval(importance, "importance"),
            retention_days=rule.retention_days,
            max_entries=rule.max_entries,
            dedupe=rule.dedupe,
            target_files=target_files,
        )
        if stored.created:
            projection_synced = self._sync_projection(source="runtime:remember")
            self._write_ok(
                category_name,
                key_name,
                title_text,
                body,
                source_ref,
                extra={
                    "memory_id": stored.record.memory_id,
                    "scope": scope_name,
                    "scope_id": scope_id,
                    "workflow_id": self.workflow_id,
                    "strategy_id": strategy_id,
                    "session_id": session_id,
                    "projection_synced": projection_synced,
                },
            )
        else:
            return self._skipped(
                category_name,
                stored.skip_reason,
                key_name,
                title_text,
                body,
                source_ref,
                record=stored.record,
            )
        return MemoryRememberResult(
            ok=True,
            record=stored.record,
        )

    def recall(
        self,
        query: str,
        *,
        scope: str = "visible",
        limit: int = 10,
        management: bool = False,
        recent: bool = False,
    ) -> list[MemoryRecord]:
        scope_name = str(scope or "visible").strip().lower()
        if scope_name != "visible":
            scope_name = self._resolve_scope(scope_name)[0]
        if not management and not self.use_enabled:
            return []
        started = time.monotonic()
        query_text = str(query or "").strip()
        recalled = self.store.recall(
            actor_id=self.actor_id,
            query=query_text,
            strategy_id=self.strategy_id,
            session_id=self.session_id,
            workflow_id=self.workflow_id,
            scope=scope_name,
            limit=limit,
            recent=recent,
        )
        records = list(recalled.records)
        if recalled.expired_count:
            self._sync_projection(source="runtime:recall_expiry")
        self._emit(
            MemoryActivityEvent.search(
                query=query_text,
                result_count=len(records),
                latency_ms=int((time.monotonic() - started) * 1000),
                source="runtime:recall",
                actor_id=self.actor_id,
                extra={
                    "scope": scope_name,
                    "strategy_id": self.strategy_id,
                    "session_id": self.session_id,
                    "expired": recalled.expired_count,
                    "query_hash": hashlib.sha256(
                        query_text.encode("utf-8")
                    ).hexdigest(),
                },
            )
        )
        return records

    def context(self, query: str, *, max_chars: int = 6000, limit: int = 10) -> MemoryContext:
        """Return exact versions and complete-entry budget decisions."""
        budget = max(0, int(max_chars))
        metadata = {"budget_chars": budget, "used_chars": 0, "included": [], "omitted": [],
                    "policy": self.policy(), "session_id": self.session_id,
                    "strategy_id": self.strategy_id, "workflow_id": self.workflow_id}
        if not self.use_enabled:
            metadata["reason"] = "use_disabled"
            return MemoryContext(metadata=metadata)
        if self._notebook_error:
            metadata["omitted"].append({"kind": "notebook", "reason": self._notebook_error})
        parts = []
        for entry in self._notebook_snapshot:
            raw = f"[{entry['category']}; id={entry['memory_id']}]\n{entry['content']}"
            candidate = build_memory_context_block("\n\n".join([*parts, raw]))
            detail = {k: v for k, v in entry.items() if k != "content"}
            if entry.get("sync_error"):
                metadata["omitted"].append({**detail, "reason": "notebook_sync_conflict"})
            elif len(candidate) <= budget:
                parts.append(raw)
                metadata["included"].append({**detail, "kind": "notebook", "truncated": False})
            else:
                metadata["omitted"].append({**detail, "kind": "notebook", "reason": "budget"})
        stable = build_memory_context_block("\n\n".join(parts))
        remaining = budget - len(stable)
        hits = tuple(self.recall(query, limit=limit)) if budget else ()
        selected, parts = [], []
        for record in hits:
            raw = self._render_hits((record,))
            if len(build_memory_context_block("\n\n".join([*parts, raw]))) <= remaining:
                parts.append(raw)
                selected.append(record)
        dynamic = build_memory_context_block("\n\n".join(parts))
        partial = None
        if not dynamic and hits:
            dynamic = self._fenced_with_budget(self._render_hits(hits[:1]), remaining)
            if dynamic:
                selected.append(hits[0])
                partial = hits[0].memory_id
        for record in hits:
            detail = self._record_metadata(record)
            if record in selected:
                metadata["included"].append({**detail, "kind": "record", "truncated": record.memory_id == partial})
            else:
                metadata["omitted"].append({**detail, "kind": "record", "reason": "budget"})
        metadata["used_chars"] = len(stable) + len(dynamic)
        return MemoryContext(stable=stable, dynamic=dynamic, recalled=tuple(selected), metadata=metadata)

    @staticmethod
    def _record_metadata(record: MemoryRecord) -> dict:
        return {"memory_id": record.memory_id, "version": record.memory_id,
                "stable_key": record.stable_key, "category": record.category,
                "scope": record.scope, "source_ref": record.source_ref,
                "source_turn_id": record.source_turn_id, "evidence_refs": list(record.evidence_refs)}

    def record_injection(self, context: MemoryContext, *, turn_id: str) -> None:
        """Call only after the returned blocks were attached to this turn's prompt."""
        self._emit(MemoryActivityEvent(kind="inject", actor_id=self.actor_id,
                   source="runtime:context", extra={**context.metadata, "turn_id": turn_id}))

    def _notebook_records(self, target: str) -> list[MemoryRecord]:
        return [r for r in self.store.projection_records(actor_id=self.actor_id)
                if r.status == "active" and r.category == "notebook_" + target]

    def _notebook_state(self, target: str) -> dict:
        nb = self._notebook
        revision = nb.revision(target)
        active = self._notebook_records(target)
        revision = hashlib.sha256((revision + ":" + ":".join(sorted(r.memory_id for r in active))).encode()).hexdigest()
        records = []
        for entry in nb.entries(target):
            match = next((r for r in active if r.content == entry), None)
            detail = self._record_metadata(match) if match else {
                "memory_id": "file:" + hashlib.sha256((target + "::" + entry).encode()).hexdigest(),
                "version": revision, "stable_key": "", "category": "notebook_" + target,
                "scope": "global", "source_ref": "notebook:" + target, "source_turn_id": "", "evidence_refs": []}
            records.append({**detail, "content": entry})
        missing = [r for r in active if r.content not in nb.entries(target)]
        if missing:
            for detail in records:
                detail["sync_error"] = True
        records.extend({**self._record_metadata(r), "content": r.content, "sync_error": True} for r in missing)
        return {"entries": list(nb.entries(target)), "records": records, "revision": revision,
                "sync_error": bool(missing), "used_chars": nb.used_chars(target), "char_limit": nb.char_limit(target),
                "snapshot": nb.snapshot_block(target)}

    def notebook_state(self) -> dict:
        if self._notebook is None or self._notebook_error:
            return {"ok": False, "error": "notebook_unreadable"}
        with self._notebook.service_lock():
            return {"ok": True, "targets": list(VALID_TARGETS),
                    **{target: self._notebook_state(target) for target in VALID_TARGETS}}

    def notebook_mutate(self, *, target: str, action: str, expected_revision: str | None,
                        content: str = "", old_text: str = "") -> dict:
        self.write_scope("global")
        if target not in VALID_TARGETS or action not in {"add", "replace", "remove"}:
            raise ValueError("invalid_notebook_action")
        if self._notebook is None:
            raise OSError("notebook_unreadable")
        with self._notebook.service_lock():
            state = self._notebook_state(target)
            if expected_revision is None or expected_revision != state["revision"]:
                raise MemoryConflictError("update_conflict")
            if state["sync_error"]:
                raise MemoryConflictError("notebook_sync_conflict")
            existing = next((r for r in self._notebook_records(target) if r.content == old_text), None)
            if action != "add" and old_text not in state["entries"]:
                raise MemoryConflictError("update_conflict")
            # File-only entries are adopted only on an explicit operator mutation.
            if action != "add" and existing is None:
                adopted = self._remember(category="notebook_" + target, content=old_text,
                                         scope="global", source="api:notebook", writer_id="memory_api")
                if not adopted.ok:
                    return {"ok": False, "error": adopted.skip_reason}
                existing = adopted.record
            if existing is not None and not existing.stable_key:
                existing = self.store.key_notebook_entry(actor_id=self.actor_id, memory_id=existing.memory_id)
            if action == "remove":
                self._forget(key=existing.stable_key, scope="global")
            else:
                result = self._remember(category="notebook_" + target, content=content,
                    key=existing.stable_key if existing else "", scope="global", source="api:notebook",
                    writer_id="memory_api", expected_memory_id=existing.memory_id if existing else None)
                if not result.ok:
                    return {"ok": False, "error": result.skip_reason}
            return {"ok": True, "target": target, **self._notebook_state(target)}

    def forget(self, **kwargs) -> int:
        if self._notebook is None:
            return self._forget(**kwargs)
        with self._notebook.service_lock():
            return self._forget(**kwargs)

    def _forget(
        self,
        *,
        key: str = "",
        memory_id: str = "",
        scope: str = "auto",
    ) -> int:
        """Forget a memory id or every historical version of a scoped key."""

        scope_name, scope_id, _, _ = self._resolve_scope(self.write_scope(scope))
        key_name = str(key or "").strip()
        memory_id_name = str(memory_id or "").strip()
        candidates = self.store.forget_candidates(
            actor_id=self.actor_id,
            scope=scope_name,
            scope_id=scope_id,
            stable_key=key_name,
            memory_id=memory_id_name,
        )
        removed_notebook: list[tuple[str, str]] = []
        for record in candidates:
            if record.status != "active" or record.category not in NOTEBOOK_CATEGORIES:
                continue
            target = NOTEBOOK_TARGET_BY_CATEGORY[record.category]
            if self._notebook is None:
                raise OSError("notebook_unreadable")
            self._notebook.revision(target)
            if record.content not in self._notebook.entries(target):
                raise MemoryConflictError("notebook file and record differ; reconcile before deleting")
            removed = self._notebook.remove(target, record.content)
            if not removed.ok:
                raise OSError("failed to remove canonical notebook memory")
            removed_notebook.append((target, record.content))
        hashes = {
            self._activity_hash(record.category, record.stable_key, record.content)
            for record in candidates
        }
        try:
            self.activity.scrub(
                actor_id=self.actor_id,
                key=key_name,
                hashes=hashes,
                scope=scope_name,
                scope_id=scope_id,
            )
            forgotten = self.store.forget(
                actor_id=self.actor_id,
                scope=scope_name,
                scope_id=scope_id,
                stable_key=key_name,
                memory_id=memory_id_name,
            )
        except BaseException:
            for target, content in removed_notebook:
                self._notebook.add(target, content)
            raise
        if forgotten.count:
            self._sync_projection(source="runtime:forget")
            self._emit(
                MemoryActivityEvent(
                    kind="forget",
                    key=str(key or "").strip(),
                    actor_id=self.actor_id,
                    source="runtime:forget",
                    extra={
                        "scope": scope_name,
                        "memory_id": memory_id_name,
                        "count": forgotten.count,
                    },
                )
            )
        return forgotten.count

    def maintain(self) -> int:
        """Apply retention policy and refresh derived projections."""

        expired = self.store.maintain(actor_id=self.actor_id)
        if expired:
            self._sync_projection(source="runtime:maintain")
        return expired

    def _sync_projection(self, *, source: str) -> bool:
        try:
            return self._projection.sync(actor_id=self.actor_id)
        except Exception as exc:
            self._emit(
                MemoryActivityEvent(
                    kind="projection_error",
                    source=source,
                    actor_id=self.actor_id,
                    extra={"error_type": type(exc).__name__},
                )
            )
            return False

    def end_session(self, *, summary: str = "") -> MemoryRememberResult | None:
        """Capture an optional summary and run retention maintenance."""

        result = None
        if str(summary or "").strip():
            scope = (
                "session"
                if self.session_id
                else self.default_scope
            )
            result = self.remember(
                category="session_summary",
                content=summary,
                scope=scope,
                key=f"session.summary.{self.session_id}" if self.session_id else "",
                source="runtime:end_session",
                writer_id="session_lifecycle",
                automatic=True,
            )
        self.maintain()
        return result

    def _skipped(
        self,
        category: str,
        reason: str,
        key: str,
        title: str,
        body: str,
        source: str,
        *,
        extra: dict | None = None,
        record: MemoryRecord | None = None,
    ) -> MemoryRememberResult:
        self._emit(
            MemoryActivityEvent.write_skipped(
                category=category,
                skip_reason=reason,
                title=title,
                preview=body,
                hash=self._activity_hash(category, key, body),
                source=source,
                actor_id=self.actor_id,
                extra={"key": key, **dict(extra or {})},
            )
        )
        return MemoryRememberResult(
            ok=False,
            skipped=True,
            skip_reason=reason,
            record=record,
        )

    def _write_ok(
        self,
        category: str,
        key: str,
        title: str,
        body: str,
        source: str,
        *,
        extra: dict | None = None,
    ) -> None:
        self._emit(
            MemoryActivityEvent.write_ok(
                category=category,
                key=key,
                title=title,
                preview=body,
                hash=self._activity_hash(category, key, body),
                source=source,
                actor_id=self.actor_id,
                extra=dict(extra or {}),
            )
        )

    def _emit(self, event: MemoryActivityEvent) -> None:
        event.extra.setdefault("strategy_id", self.strategy_id)
        event.extra.setdefault("workflow_id", self.workflow_id)
        event.extra.setdefault("session_id", self.session_id)
        if "scope" not in event.extra:
            event.extra["scope"] = self.default_scope
        if "scope_id" not in event.extra and event.extra["scope"] != "visible":
            event.extra["scope_id"] = self._resolve_scope(event.extra["scope"])[1]
        try:
            self.activity.append(event)
        except OSError:
            pass

    @staticmethod
    def _activity_hash(category: str, key: str, body: str) -> str:
        raw = f"{category}::{key}::{body}".encode("utf-8")
        return hashlib.sha256(raw).hexdigest()

    @staticmethod
    def _render_hits(hits: Iterable[MemoryRecord]) -> str:
        parts: list[str] = []
        for hit in hits:
            identity = hit.stable_key or hit.memory_id
            source = f"; source={hit.source_ref}" if hit.source_ref else ""
            parts.append(
                f"[{hit.category}; scope={hit.scope}; id={identity}{source}]\n"
                f"{hit.content}"
            )
        return "\n\n".join(parts)

    @staticmethod
    def _fenced_with_budget(raw: str, budget: int) -> str:
        clean = sanitize_context(str(raw or "")).strip()
        if not clean or budget <= 0:
            return ""
        overhead = len(build_memory_context_block("x")) - 1
        if budget <= overhead:
            return ""
        content_budget = budget - overhead
        if len(clean) > content_budget:
            if content_budget <= 3:
                return ""
            clean = clean[: content_budget - 3].rstrip() + "..."
        block = build_memory_context_block(clean)
        return block if len(block) <= budget else ""

    @property
    def default_scope(self) -> str:
        if self.workflow_id:
            return "workflow"
        if self.strategy_id:
            return "strategy"
        return "session" if self.session_id else "global"

    def write_scope(self, scope: str = "auto") -> str:
        """Derived knowledge never flows upward into other execution domains."""
        value = str(scope or "auto").strip().lower()
        if value == "auto":
            value = self.default_scope
        if value == "global" and (self.strategy_id or self.workflow_id):
            raise MemoryScopeError("scoped execution cannot write global memory")
        if value == "strategy" and self.workflow_id:
            raise MemoryScopeError("workflow execution cannot write parent strategy memory")
        self._resolve_scope(value)
        return value

    def _resolve_scope(self, scope: str) -> tuple[str, str, str, str]:
        value = str(scope or "").strip().lower()
        if value == "global":
            return "global", "", "", ""
        if value == "strategy":
            if not self.strategy_id:
                raise MemoryScopeError("strategy memory requires an active strategy")
            return "strategy", self.strategy_id, self.strategy_id, self.session_id
        if value == "workflow":
            if not self.workflow_id:
                raise MemoryScopeError("workflow memory requires an active workflow")
            namespace = json.dumps([self.strategy_id, self.workflow_id], separators=(",", ":"), ensure_ascii=False)
            return "workflow", namespace, self.strategy_id, ""
        if value == "session":
            if not self.session_id:
                raise MemoryScopeError("session memory requires an active session")
            namespace = json.dumps([self.strategy_id, self.workflow_id, self.session_id], separators=(",", ":"), ensure_ascii=False)
            return "session", namespace, self.strategy_id, self.session_id
        raise MemoryScopeError(f"unknown memory scope: {scope!r}")

    @staticmethod
    def _required_id(value: str, name: str) -> str:
        clean = MemoryRuntime._clean_id(value, name)
        if not clean:
            raise MemoryScopeError(f"{name} must be non-empty")
        return clean

    @staticmethod
    def _required_actor_id(value: str) -> str:
        clean = str(value or "").strip()
        if not clean:
            raise MemoryScopeError("actor_id must be non-empty")
        if len(clean) > 256 or any(ord(char) < 32 for char in clean):
            raise MemoryScopeError("invalid actor_id")
        return clean

    @staticmethod
    def _clean_id(value: str, name: str) -> str:
        clean = str(value or "").strip()
        if len(clean) > 256 or any(ord(c) < 32 for c in clean) or any(part in clean for part in ("/", "\\", "..", "\x00")):
            raise MemoryScopeError(f"invalid {name}")
        return clean

    @staticmethod
    def _unit_interval(value: float, name: str) -> float:
        number = float(value)
        if not 0.0 <= number <= 1.0:
            raise ValueError(f"{name} must be between 0 and 1")
        return number


__all__ = [
    "MemoryContext",
    "MemoryRememberResult",
    "MemoryRuntime",
    "MemoryScopeError",
]
