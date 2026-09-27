"""Streaming event bus for dashboard / gateway / TUI delivery.

The kernel emits structured events as a turn progresses; subscribers
(Dashboard SSE, Gateway WebSocket, CLI TUI) receive them in order
without polling the journal. Without this layer every UI either had
to tail the JSONL files or wait for the turn to complete, which made
long runtime coding loops feel laggy.

wired the basic in-memory bus. (Context,
Streaming, And State Architecture) raises the bar with a *resume
contract*:

- every event carries a monotonic ``seq`` and a stable ``event_id``;
- subscribers can ask for "everything I missed" via
  :meth:`StreamingEventBus.recent` /
  ``GET /agent/stream/events?after_seq=N``;
- the in-memory ring is large enough (default 2,000 events) to cover
  routine reconnects, dropped websockets, and dashboard reloads.

Wire:

- ``StreamingEventBus.publish(kind, **payload)`` is called from
  :class:`nerya.agent.kernel.AgentKernel` and the tool runner whenever
  a notable event happens.
- Subscribers register a callback (``subscribe(callback)``) and get
  every subsequent event. They can drop the callback by calling the
  returned ``unsubscribe`` function.
- The bus is thread-safe (Lock-guarded) so HTTP request handlers can
  safely stream from a background turn.

Events are intentionally generic dicts with a ``kind`` discriminator
so the schema can grow without churning every subscriber. The kernel
publishes:

- ``message.delta`` — partial assistant content
- ``tool.start`` — tool/skill call started (mirrors skill.call.start)
- ``tool.progress`` — per-tool progress bump (e.g. "12/100 rows")
- ``tool.complete`` — tool finished, success or failure
- ``approval.request`` — operator approval requested
- ``turn.step`` — one :class:`~nerya.agent.transcript_blocks.BlockEnvelope`
  emitted by the workspace-native loop (text / thinking / tool_use /
  tool_result)
- ``turn.complete`` — turn finished

Streaming contract.
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable


_EventCb = Callable[[dict[str, Any]], None]


def thinking_event_fields(block: dict[str, Any]) -> dict[str, Any]:
    """Keep reasoning delta/snapshot identity across the durable event boundary."""
    kind = block.get("kind")
    snapshot = kind == "thinking" and bool(block.get("stream_id"))
    return {
        "stream_id": block.get("stream_id"),
        "stream_mode": block.get("stream_mode"),
        "completed": snapshot,
        "mode": "replace" if snapshot else "append" if kind == "thinking_delta" else "legacy",
        "step": {
            "kind": "thinking",
            "status": "ok" if kind == "thinking" else "running",
            "wall_ms": block.get("elapsed_ms", 0),
            "detail": {
                "text": str(block.get("text") or ""),
                "summary": str(block.get("summary") or ""),
                **({"retry": block["retry"]} if isinstance(block.get("retry"), dict) else {}),
            },
        },
    }


@dataclass
class StreamingEventBus:
    """Process-local pub/sub.

    ``_max_replay`` controls the in-memory ring buffer the bus retains
    so that late subscribers and reconnecting clients can replay
    missed events. The default is intentionally generous (2,000): a
    typical turn emits a few dozen events, so the ring covers a few
    consecutive turns even under pressure. Tests build their own bus
    with smaller rings to keep assertions tight.
    """

    _subscribers: dict[str, _EventCb] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _last_events: list[dict[str, Any]] = field(default_factory=list)
    _seq: int = 0
    _max_replay: int = 2000
    _epoch: str = field(default_factory=lambda: uuid.uuid4().hex)

    def subscribe(self, callback: _EventCb) -> Callable[[], None]:
        """Register ``callback``. Returns an unsubscribe function."""

        sid = uuid.uuid4().hex
        with self._lock:
            self._subscribers[sid] = callback
            replay = list(self._last_events)
        for ev in replay:
            try:
                callback(ev)
            except Exception:
                pass

        def _drop() -> None:
            with self._lock:
                self._subscribers.pop(sid, None)

        return _drop

    def publish(self, kind: str, **payload: Any) -> dict[str, Any]:
        """Send ``kind`` to every subscriber. Returns the published event.

        The returned event is the same dict every subscriber receives
        and that ``recent()`` will return — including the freshly
        assigned ``seq`` and ``event_id``. Callers that journal the
        event to disk should use the returned value so the persisted
        copy carries the same identifiers.
        """

        # Allocation and insertion share one lock: concurrent publishers must
        # not append seq=12 before seq=11. Caller metadata cannot override IDs.
        with self._lock:
            self._seq += 1
            event: dict[str, Any] = {
                **payload,
                "kind": kind,
                "seq": self._seq,
                "epoch": self._epoch,
                "event_id": payload.get("event_id") or uuid.uuid4().hex,
                "ts": payload.get("ts") or time.time(),
            }
            self._last_events.append(event)
            if len(self._last_events) > self._max_replay:
                self._last_events = self._last_events[-self._max_replay:]
            subs = list(self._subscribers.values())
        for cb in subs:
            try:
                cb(event)
            except Exception:
                # never let one bad subscriber break the others
                pass
        return event

    # ---- replay / cursor API -----------------------------------------

    def recent(self, *, after_seq: int | None = None) -> list[dict[str, Any]]:
        """Return events newer than ``after_seq`` (or the whole ring).

        / streaming contract: a polling client
        sends the highest ``seq`` it already saw and gets back only
        the strictly newer events. ``after_seq=None`` (the default)
        returns the entire ring, preserving the original behaviour.
        """

        with self._lock:
            buf = list(self._last_events)
        if after_seq is None:
            return buf
        return [ev for ev in buf if int(ev.get("seq") or 0) > int(after_seq)]

    def page(self, *, after_seq: int | None = None, epoch: str | None = None,
             session_id: str | None = None, limit: int = 500) -> dict[str, Any]:
        """Atomic replay page; session filtering is not a sequence gap.

        Expired bases require a snapshot. Never silently skip unread events.
        """
        limit = max(1, min(2000, int(limit)))
        with self._lock:
            head, generation = self._seq, self._epoch
            oldest = int(self._last_events[0]["seq"]) if self._last_events else head + 1
            reset = bool((epoch and epoch != generation) or (after_seq is not None
                         and (after_seq < oldest - 1 or after_seq > head)))
            base = oldest - 1 if reset or after_seq is None else after_seq
            rows = [dict(event) for event in self._last_events
                    if int(event["seq"]) > base
                    and (not session_id or event.get("session_id") == session_id)]
            more = len(rows) > limit
            rows = rows[:limit]
            cursor = int(rows[-1]["seq"]) if more else head
        return {"events": rows, "count": len(rows), "cursor": cursor,
                "next_cursor": cursor, "latest_seq": head, "has_more": more,
                "epoch": generation, "reset_required": reset, "oldest_seq": oldest}

    def latest_seq(self) -> int:
        """Return the highest ``seq`` ever assigned by this bus.

        Clients can call this to obtain a cursor before subscribing,
        so that the first ``after_seq`` poll returns only events that
        arrived *after* the subscription started.
        """

        with self._lock:
            return self._seq

    def cursor_after(self, events: Iterable[dict[str, Any]]) -> int:
        """Return the largest ``seq`` in ``events`` (or ``latest_seq``).

        Convenience for callers that want to advance their cursor
        based on the events they just received without re-walking
        the ring.
        """

        max_seq = 0
        for ev in events:
            try:
                s = int(ev.get("seq") or 0)
            except (TypeError, ValueError):
                continue
            if s > max_seq:
                max_seq = s
        if max_seq == 0:
            return self.latest_seq()
        return max_seq

    def clear(self) -> None:
        """Drop every subscriber and reset the buffer/seq.

        Tests rely on this to start from a clean slate. The seq
        counter resets to zero so deterministic assertions work.
        """

        with self._lock:
            self._subscribers.clear()
            self._last_events.clear()
            self._seq = 0
            self._epoch = uuid.uuid4().hex


_default_bus = StreamingEventBus()


def get_default_bus() -> StreamingEventBus:
    """Return the process-wide bus used by the kernel + HTTP handlers."""

    return _default_bus


__all__ = ["StreamingEventBus", "get_default_bus"]
