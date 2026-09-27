"""Compatibility adapter over the built-in notebook and scoped SQLite memory.

The native agent uses MemoryRuntime directly. This adapter keeps the historical
provider API available without external recall or a second index.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from ..core.config import Config
from .notebook import MemoryNotebook, VALID_TARGETS, load_notebook
from .provider import (
    MemoryProvider,
    MemoryProviderInfo,
    MemoryRecallChunk,
    MemoryToolDef,
    MemoryToolResult,
)
from .runtime import MemoryRuntime


__all__ = ["BuiltinMemoryProvider"]

_log = logging.getLogger("nerya.memory.builtin")


_BUILTIN_INFO = MemoryProviderInfo(
    id="builtin",
    name="Built-in memory",
    family="builtin",
    description=(
        "Curated AGENT.md / OPERATOR.md notebook injected verbatim into "
        "the system prompt, plus canonical scoped SQLite recall "
        "over versioned facts. Always available — no remote calls."
    ),
    requires_api_key=False,
    env_key=None,
    cost_hint="free (local storage)",
)


@dataclass
class BuiltinMemoryProvider(MemoryProvider):
    """Always-on compatibility provider backed by built-in memory."""

    config: Config
    info: MemoryProviderInfo = field(default=_BUILTIN_INFO, init=False)
    _notebook: MemoryNotebook | None = field(default=None, init=False, repr=False)
    _memory: MemoryRuntime | None = field(default=None, init=False, repr=False)
    _system_prompt_snapshot: str = field(default="", init=False, repr=False)

    # ------------------------------------------------------------- lifecycle

    def is_available(self) -> bool:
        # Always available: the notebook is on-disk only and the
        # runtime requires no external service.
        return True

    def initialize(self) -> None:
        """Lazy-load the notebook + take the system-prompt snapshot.

        The system-prompt block is captured once here so the LLM prefix
        cache stays byte-stable for the whole session even if the agent
        uses the memory tool mid-turn.
        """

        nb = load_notebook(self.config)
        self._notebook = nb
        snap = nb.snapshot_blocks()
        joined = "\n\n".join(part for part in snap.values() if part)
        self._system_prompt_snapshot = joined.strip()
        self._memory = MemoryRuntime(self.config)

    def shutdown(self) -> None:
        # Nothing to release; the notebook flushes on every write.
        return None

    # ----------------------------------------------------- system prompt

    def system_prompt_block(self) -> str:
        return self._system_prompt_snapshot if self._memory and self._memory.use_enabled else ""

    # -------------------------------------------------------------- recall

    def prefetch(self, query: str, *, limit: int = 5) -> list[MemoryRecallChunk]:
        """Compatibility provider uses canonical global recall, never a file index."""
        memory = self._memory or MemoryRuntime(self.config)
        return [MemoryRecallChunk(text=hit.content, score=hit.score, source=hit.source_ref,
                                  metadata={"memory_id": hit.memory_id, "scope": hit.scope})
                for hit in memory.recall(query, limit=limit)]

    # --------------------------------------------------------------- tools

    def get_tool_schemas(self) -> list[MemoryToolDef]:
        """Expose one action-based ``memory`` tool surface."""

        return [
            MemoryToolDef(
                name="memory",
                description=(
                    "Curate the agent / operator notebook. "
                    "Entries land verbatim in the system prompt at the "
                    "next session start. Use sparingly: this is "
                    "long-term memory, not scratch space."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["add", "replace", "remove", "read"],
                        },
                        "target": {
                            "type": "string",
                            "enum": list(VALID_TARGETS),
                            "description": "agent = AGENT.md, operator = OPERATOR.md",
                        },
                        "content": {
                            "type": "string",
                            "description": "New entry (for add) or replacement text (for replace).",
                        },
                        "expected_revision": {"type": "string", "description": "Revision from read, required for replace/remove."},
                        "old_text": {
                            "type": "string",
                            "description": "Substring identifying the entry to replace / remove.",
                        },
                    },
                    "required": ["action", "target"],
                },
            ),
        ]

    def handle_tool_call(
        self, name: str, arguments: dict[str, Any]
    ) -> MemoryToolResult:
        if name != "memory":
            return MemoryToolResult(
                ok=False,
                error=f"builtin: unknown tool {name!r}",
            )
        nb = self._notebook
        if nb is None:
            return MemoryToolResult(
                ok=False,
                error="builtin: notebook not initialised",
            )
        action = str(arguments.get("action") or "").strip().lower()
        target = str(arguments.get("target") or "").strip().lower()
        if target not in VALID_TARGETS:
            return MemoryToolResult(
                ok=False,
                error=f"builtin: invalid target {target!r}; want one of {list(VALID_TARGETS)}",
            )
        runtime = self._memory
        state = runtime.notebook_state()
        if not state.get("ok"):
            return MemoryToolResult(ok=False, error=state.get("error", "notebook_unreadable"))
        if action == "read":
            if not runtime.use_enabled:
                return MemoryToolResult(ok=False, error="use_disabled")
            return MemoryToolResult(ok=True, content="\n§\n".join(state[target]["entries"]), extra=state[target])
        try:
            result = runtime.notebook_mutate(target=target, action=action,
                content=str(arguments.get("content") or ""), old_text=str(arguments.get("old_text") or ""),
                expected_revision=arguments.get("expected_revision", state[target]["revision"] if action == "add" else None))
        except (ValueError, OSError) as exc:
            return MemoryToolResult(ok=False, error=str(exc))
        error = result.get("error", "")
        if error == "unsafe_content":
            from .content_scanner import scan_memory_content
            error = scan_memory_content(str(arguments.get("content") or "")) or error
        return MemoryToolResult(ok=result["ok"], error=error, extra=result)

    # ----------------------------------------------------- session hooks

    def on_session_end(self, *, summary: str = "") -> None:
        # The notebook is already persisted on every write; nothing to flush.
        # When ``summary`` is non-empty, route it through the standard writer
        # rules so operators can disable or retarget that capture from
        # /memory/write_rules.
        if not summary:
            return
        if self._memory is None:
            return
        try:
            self._memory.remember(
                category="session_summary",
                content=summary,
                title="session summary",
                source="builtin:on_session_end",
                automatic=True,
            )
        except Exception:  # noqa: BLE001 — best-effort
            _log.exception("builtin memory: session_summary capture failed")
