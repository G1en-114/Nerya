"""Session todo tracking for the workspace-native agent loop.

Planning is model behaviour, not a second authorization system. Nerya exposes
``todo_write`` to keep multi-step work visible across compaction, while actual
side effects remain governed by :class:`PermissionEngine` and domain safety
gates such as trading risk/approval. The former enter/exit/status plan tools
only maintained an isolated flag and created approval polling loops, so they
were removed.
"""

from __future__ import annotations

import threading
import time
import json
from dataclasses import dataclass, field
from typing import Any, Mapping

from ..tool_errors import schema_validation_result
from ..types import (
    ContextModifier,
    ToolCall,
    ToolResult,
    ToolResultPart,
)


_VALID_STATUSES = {"pending", "in_progress", "completed", "cancelled"}


@dataclass
class TodoItem:
    id: str
    content: str
    activeForm: str = ""
    status: str = "pending"

    def asdict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "content": self.content,
            "activeForm": self.activeForm,
            "status": self.status,
        }


@dataclass
class TaskState:
    """Session-level todo state shared across tool calls and UI reads."""

    todos: list[TodoItem] = field(default_factory=list)
    _lock: threading.RLock = field(default_factory=threading.RLock)
    updated_at: float = field(default_factory=time.time)
    source: dict[str, Any] = field(default_factory=dict)

    def set_todos(self, todos: list[TodoItem], *, source: Mapping[str, Any] | None = None) -> None:
        with self._lock:
            self.todos = list(todos)
            self.updated_at = time.time()
            self.source = dict(source or {})

    def snapshot_todos(self) -> list[dict[str, Any]]:
        with self._lock:
            return [todo.asdict() for todo in self.todos]

    def snapshot_for_checkpoint(self) -> dict[str, Any]:
        with self._lock:
            return {
                "version": 1,
                "source": {"kind": "task_state", **self.source},
                "updated_at": self.updated_at,
                "todos": [todo.asdict() for todo in self.todos],
            }


def normalise_task_snapshot(raw: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """Accept typed planning data only; never infer goals/permissions from prose."""
    if not isinstance(raw, Mapping) or not isinstance(raw.get("todos"), list):
        return None
    source = raw.get("source")
    source = source if isinstance(source, Mapping) else {}
    todos = []
    for item in raw["todos"]:
        if (not isinstance(item, Mapping) or not isinstance(item.get("status"), str)
                or item["status"] not in _VALID_STATUSES):
            continue
        if not isinstance(item.get("content"), str):
            continue
        todos.append({key: str(item.get(key) or "") for key in ("id", "content", "activeForm", "status")})
    return {
        "version": 1,
        "source": {key: str(source[key])[:256] for key in ("kind", "session_id", "turn_id", "tool_use_id") if source.get(key)},
        "updated_at": raw.get("updated_at") if isinstance(raw.get("updated_at"), (float, int)) else None,
        "todos": todos,
    }


def render_task_snapshot(snapshot: Mapping[str, Any], *, max_chars: int = 8_000) -> str:
    """Bounded display; the checkpoint keeps the complete structured snapshot."""
    header = ("# Task Progress\nModel-authored planning snapshot, not authorization or proof of execution. "
              "Completed/cancelled items are historical; live operator instructions and safety gates take precedence.\n")
    todos = list(snapshot.get("todos") or [])
    # Show active work first, but keep terminal states in the structured checkpoint.
    ordered = sorted(todos, key=lambda item: item.get("status") not in {"pending", "in_progress"})
    visible: list[dict[str, Any]] = []
    payload = {"source": snapshot.get("source") or {}, "todos": visible, "omitted_count": len(todos)}
    if len(header) + len(json.dumps(payload, ensure_ascii=False)) > max_chars:
        payload["source"] = {"truncated": True}
    for item in ordered:
        shown: dict[str, Any] = {key: str(value)[:500] for key, value in item.items()}
        if any(len(str(value)) > 500 for value in item.values()):
            shown["text_truncated"] = True
        visible.append(shown)
        payload["omitted_count"] = len(todos) - len(visible)
        if len(header) + len(json.dumps(payload, ensure_ascii=False)) > max_chars:
            visible.pop()
            payload["omitted_count"] = len(todos) - len(visible)
            break
    return header + json.dumps(payload, ensure_ascii=False)


def preserve_task_context(
    transcript: list[dict[str, Any]],
    task_snapshot: Mapping[str, Any] | None,
) -> list[dict[str, Any]]:
    """Kernel compaction callback helper: replace, rather than stack, todo state."""
    snapshot = normalise_task_snapshot(task_snapshot)
    if snapshot is None:
        return transcript
    out = [message for message in transcript if message.get("kind") != "transcript.compact.todos"]
    out.append({
        "role": "user", "kind": "transcript.compact.todos", "pinned": True,
        "content": render_task_snapshot(snapshot), "meta": {"task_state": snapshot},
    })
    return out


def format_for_injection(task_state: TaskState) -> str:
    """Render unfinished todo state for prompt injection after compaction."""

    rows = [
        item
        for item in task_state.snapshot_todos()
        if item.get("status") in {"pending", "in_progress"}
    ]
    if not rows:
        return ""
    lines = ["# Task Progress", "Unfinished work from the current session:"]
    for item in rows:
        status = item.get("status") or "pending"
        content = item.get("activeForm") or item.get("content") or item.get("id")
        lines.append(f"- {status}: {content}")
    return "\n".join(lines)


def todo_write_handler(call: ToolCall, *, task_state: TaskState) -> ToolResult:
    args = call.arguments or {}
    raw = args.get("todos")
    if not isinstance(raw, list):
        return schema_validation_result(call, "todo_write requires 'todos' as a list")

    todos: list[TodoItem] = []
    in_progress = 0
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            return schema_validation_result(
                call,
                f"todo[{index}] must be an object",
            )
        item_id = str(item.get("id") or f"t{index + 1}")
        content = str(item.get("content") or "").strip()
        active_form = str(
            item.get("activeForm") or item.get("active_form") or ""
        ).strip()
        status = str(item.get("status") or "pending").lower()
        if not content:
            return schema_validation_result(
                call,
                f"todo[{index}] missing 'content'",
            )
        if not active_form:
            active_form = (
                content if content.endswith("ing") else f"Working on: {content}"
            )
        if status not in _VALID_STATUSES:
            return schema_validation_result(
                call,
                f"todo[{index}] invalid status {status!r}",
            )
        if status == "in_progress":
            in_progress += 1
        todos.append(
            TodoItem(
                id=item_id,
                content=content,
                activeForm=active_form,
                status=status,
            )
        )

    if in_progress > 1:
        return schema_validation_result(
            call,
            "only one todo may be in_progress at a time",
        )

    task_state.set_todos(todos, source={
        "kind": "todo_write", "tool_use_id": call.id, "turn_id": call.turn_id,
        "session_id": str(call.metadata.get("session_id") or ""),
    })
    markers = {
        "pending": "[ ]",
        "in_progress": "[~]",
        "completed": "[x]",
        "cancelled": "[/]",
    }
    summary_lines = ["# Todo list"]
    for todo in todos:
        marker = markers.get(todo.status, "[?]")
        summary_lines.append(
            f"- {marker} {todo.content} ({todo.activeForm})"
            if todo.status == "in_progress"
            else f"- {marker} {todo.content}"
        )
    return ToolResult(
        tool_use_id=call.id,
        name=call.name,
        content=[
            ToolResultPart.text_part("\n".join(summary_lines)),
            ToolResultPart.json_part(task_state.snapshot_for_checkpoint()),
        ],
        context_modifiers=[
            ContextModifier(kind="todo_update", payload={"count": len(todos)})
        ],
    )


__all__ = [
    "TaskState",
    "TodoItem",
    "format_for_injection",
    "normalise_task_snapshot",
    "render_task_snapshot",
    "preserve_task_context",
    "todo_write_handler",
]
