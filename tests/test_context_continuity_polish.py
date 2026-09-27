"""Context continuity and live task polling; no providers or external effects."""
from __future__ import annotations

import json
from functools import partial
from types import SimpleNamespace

import pytest

from nerya.agent.loop import LoopConfig, WorkspaceNativeAgentLoop
from nerya.agent.loop_state import LoopRunState, TurnCheckpoint
from nerya.agent.session_compaction import SessionCompactionPolicy, compact_session_history
from nerya.agent.tool_phase import ToolBatchPhase, ToolBatchPolicy
from nerya.agent.transcript_compact import compact_transcript, validate_transcript
from nerya.core.errors import LLMError
from nerya.core.paths import WorkspacePaths
from nerya.llm.messages import MessagesResponse
from nerya.subagents.tasks import TaskStore
from nerya.tools.native.task import TaskState, preserve_task_context, render_task_snapshot, todo_write_handler
from nerya.tools.native.tasks import task_get_handler, task_output_handler
from nerya.tools.orchestrator import BatchResult
from nerya.tools.registry import ToolRegistry
from nerya.tools.result_contracts import tool_json_data
from nerya.tools.types import RiskLevel, ToolCall, ToolDescriptor, ToolErrorKind, ToolResult

pytestmark = pytest.mark.smoke


@pytest.fixture(autouse=True)
def _isolated_tool_outputs(monkeypatch, tmp_path):
    from nerya.llm.tool_raw_store import RawResultStore
    monkeypatch.setattr("nerya.llm.tool_raw_store.open_store", lambda *args, **kwargs: RawResultStore(tmp_path))


def _write_todos(state, todos, call_id):
    result = todo_write_handler(ToolCall(
        name="todo_write", id=call_id, turn_id="turn-b",
        metadata={"session_id": "session-1"},
        arguments={"todos": [dict(id=ident, content=ident, status=status) for ident, status in todos]},
    ), task_state=state)
    assert not result.is_error
    return tool_json_data(result)


def _rows(n):
    return [dict(message_id=f"m{i}", message_seq=i + 1, turn_id=f"t{i // 2}",
                 role="user" if i % 2 == 0 else "assistant",
                 content="Goal A" if i == 0 else f"historical {i}") for i in range(n)]


def test_todo_sources_and_cancelled_state_survive_two_compactions_and_restore():
    state = TaskState()
    original = _write_todos(state, [("A", "in_progress")], "todo-a")
    policy = SessionCompactionPolicy(keep_recent_pairs=1, trigger_pairs=1)
    first = compact_session_history(_rows(6), policy=policy, task_snapshot=original)
    revised = _write_todos(state, [("A", "cancelled"), ("B", "in_progress"), ("C", "pending")], "todo-b")
    second = compact_session_history(
        _rows(10), existing_checkpoint=first.checkpoint, policy=policy, task_snapshot=revised,
    )
    restored = compact_session_history([], existing_checkpoint=json.loads(json.dumps(second.checkpoint)))
    snapshot = restored.checkpoint["task_state"]
    assert snapshot["source"] == {"kind": "todo_write", "session_id": "session-1",
                                   "turn_id": "turn-b", "tool_use_id": "todo-b"}
    assert [(item["id"], item["status"]) for item in snapshot["todos"]] == [
        ("A", "cancelled"), ("B", "in_progress"), ("C", "pending"),
    ]
    assert '"status": "cancelled"' in restored.messages[0]["content"]
    assert "not authorization" in restored.messages[0]["content"]
    assert "Historical Session Intent (may be superseded)" in restored.messages[0]["content"]
    cleared = compact_session_history([], existing_checkpoint=restored.checkpoint, task_snapshot={"todos": []})
    assert cleared.checkpoint["task_state"]["todos"] == []


def test_preservation_replaces_snapshot_and_turn_checkpoint_keeps_source():
    state = TaskState()
    _write_todos(state, [("A", "pending")], "todo-a")
    transcript = preserve_task_context([{"role": "user", "content": "Work on B"}], state.snapshot_for_checkpoint())
    _write_todos(state, [("A", "cancelled"), ("B", "in_progress"), ("C", "pending")], "todo-b")
    for _ in range(2):
        transcript.extend({"role": "assistant", "content": str(i)} for i in range(10))
        transcript, _ = compact_transcript(transcript, keep_tail_messages=2, max_messages=3)
        transcript = preserve_task_context(transcript, state.snapshot_for_checkpoint())
    restored = LoopRunState.from_checkpoint(TurnCheckpoint.from_dict(
        LoopRunState(turn_id="t", message_id="m", transcript=transcript).to_checkpoint(resumable=True).asdict()
    ))
    retained = [message for message in restored.transcript if message.get("kind") == "transcript.compact.todos"]
    assert len(retained) == 1
    assert retained[0]["role"] == "user"
    snapshot = retained[0]["meta"]["task_state"]
    assert snapshot["source"]["tool_use_id"] == "todo-b"
    assert [item["id"] for item in snapshot["todos"] if item["status"] in {"pending", "in_progress"}] == ["B", "C"]
    assert not validate_transcript(restored.transcript)
    assert preserve_task_context(transcript, state.snapshot_for_checkpoint()) == transcript


def test_latest_operator_change_is_preserved_verbatim_outside_tail():
    latest = {"role": "user", "content": "Cancel A; work on B and then C. Do not deploy."}
    transcript = [{"role": "user", "content": "Goal A"}, latest]
    transcript.extend({"role": "assistant", "content": str(i)} for i in range(10))
    compacted, _ = compact_transcript(transcript, keep_tail_messages=2, max_messages=3)
    assert latest in compacted


def test_large_todo_display_is_bounded_without_truncating_checkpoint():
    state = TaskState()
    snapshot = _write_todos(state, [("x" * 900, "pending")] * 30, "long" * 200)
    text = render_task_snapshot(snapshot, max_chars=600)
    assert len(text) <= 600
    payload = json.loads(text.split("\n", 2)[2])
    assert payload["omitted_count"] > 0
    assert len(snapshot["todos"]) == 30
    assert snapshot["todos"][0]["content"] == "x" * 900


def _phase(name, dispatch, *, read_only=True, namespace="native"):
    registry = ToolRegistry()
    registry.register(ToolDescriptor(
        name=name, description=name, input_schema={"type": "object"},
        handler=lambda call: None, read_only=read_only, namespace=namespace,
        risk=RiskLevel.READ if read_only else RiskLevel.WRITE,
    ))
    phase = ToolBatchPhase(registry=registry, orchestrator=SimpleNamespace(run_batch=dispatch))
    return partial(phase.run, policy=ToolBatchPolicy({name}, {name}))


@pytest.mark.parametrize("name,handler", [("task_get", task_get_handler), ("task_output", task_output_handler)])
def test_task_poll_reads_changed_record_on_third_call_and_after_checkpoint(tmp_path, name, handler):
    store = TaskStore(WorkspacePaths(root=tmp_path))
    task = store.create(name="fixture", payload={})
    store.update_state(task.task_id, "running")
    executed = []

    def dispatch(calls):
        executed.extend(calls)
        return BatchResult(results=[handler(call, store=store) for call in calls])

    phase = _phase(name, dispatch)
    state = LoopRunState(turn_id="t", message_id="m")
    for i in range(2):
        result = phase([ToolCall(name=name, id=str(i), arguments={"task_id": task.task_id})], state=state)
        assert tool_json_data(result.batch.results[0])["state"] == "running"
    state = LoopRunState.from_checkpoint(state.to_checkpoint(resumable=True))
    store.finish(task.task_id, output={"answer": "new output"})
    result = phase([ToolCall(name=name, id="third", arguments={"task_id": task.task_id})], state=state)
    assert len(executed) == 3
    assert not result.repeated_loop_abort
    assert tool_json_data(result.batch.results[0])["state"] == "succeeded"
    assert tool_json_data(result.batch.results[0])["output"] == {"answer": "new output"}
    assert result.batch.results[0].metadata["poll_unchanged_count"] == 0


def test_polling_no_progress_stops_with_fresh_observation():
    executed = []

    def dispatch(calls):
        executed.extend(calls)
        return BatchResult(results=[ToolResult.from_json(tool_use_id=call.id, name=call.name, data={"state": "running"}) for call in calls])

    phase = _phase("task_get", dispatch)
    state = LoopRunState(turn_id="t", message_id="m")
    for i in range(5):
        result = phase([ToolCall(name="task_get", id=str(i))], state=state)
        assert not result.batch.results[0].is_error
        assert result.repeated_loop_abort == (i == 4)
    assert len(executed) == 5
    assert result.batch.results[0].metadata["poll_stop_reason"] == "task_poll_no_progress"


def test_unadvertised_poll_is_not_labelled_as_a_fresh_observation():
    executed = []
    registry = ToolRegistry()
    registry.register(ToolDescriptor(name="task_get", description="fixture", input_schema={}, handler=lambda call: None))
    phase = ToolBatchPhase(registry=registry, orchestrator=SimpleNamespace(run_batch=lambda calls: executed.extend(calls)))
    result = phase.run([ToolCall(name="task_get", id="blocked")],
        state=LoopRunState(turn_id="t", message_id="m"), policy=ToolBatchPolicy(set(), set()))
    assert not executed
    assert result.batch.results[0].error.kind == ToolErrorKind.PERMISSION_DENIED
    assert "fresh_status_poll" not in result.batch.results[0].metadata


@pytest.mark.parametrize("name,namespace", [("read_file", "native"), ("task_get", "mcp")])
def test_poll_exception_does_not_relax_other_reads(name, namespace):
    executed = []

    def dispatch(calls):
        executed.extend(calls)
        return BatchResult(results=[ToolResult.from_text(tool_use_id=c.id, name=c.name, text="ok") for c in calls])

    phase = _phase(name, dispatch, namespace=namespace)
    state = LoopRunState(turn_id="t", message_id="m")
    for i in range(3):
        result = phase([ToolCall(name=name, id=str(i))], state=state)
    assert len(executed) == 2
    assert result.batch.results[0].error.kind == ToolErrorKind.DEDUPED


@pytest.mark.parametrize("unknown", [False, True])
def test_confirmed_or_unknown_write_is_not_replayed(unknown):
    executed = []

    def dispatch(calls):
        executed.extend(calls)
        if unknown:
            raise RuntimeError("lost response")
        return BatchResult(results=[ToolResult.from_json(tool_use_id=c.id, name=c.name, data={"ok": True}) for c in calls])

    phase = _phase("task_get", dispatch, read_only=False)
    state = LoopRunState(turn_id="t", message_id="m")
    phase([ToolCall(name="task_get", id="first")], state=state)
    result = phase([ToolCall(name="task_get", id="second")], state=state)
    assert len(executed) == 1
    assert result.batch.results[0].error.kind == ToolErrorKind.DEDUPED
    assert result.batch.results[0].error.retryable is False


def _fake_loop(gateway, *, config, name="task_get", handler=None):
    registry = ToolRegistry()
    registry.register(ToolDescriptor(name=name, description=name, input_schema={"type": "object"}, handler=handler or (lambda call: None)))
    orchestrator = SimpleNamespace(run_batch=lambda calls: BatchResult(results=[handler(call) for call in calls]))
    return WorkspaceNativeAgentLoop(gateway=gateway, registry=registry, orchestrator=orchestrator, config=config)


def test_fake_loop_polls_until_live_completion_and_persists_compaction_events(tmp_path):
    store = TaskStore(WorkspacePaths(root=tmp_path))
    task = store.create(name="fixture", payload={})
    store.update_state(task.task_id, "running")
    seen = []

    def call_messages(**kwargs):
        seen.append(kwargs["messages"])
        if len(seen) == 3:
            store.finish(task.task_id, output={"answer": "done"})
        if len(seen) <= 3:
            return MessagesResponse(content=[{"type": "tool_use", "id": f"call-{len(seen)}", "name": "task_get", "input": {"task_id": task.task_id}}], stop_reason="tool_use")
        observations = [entry for message in kwargs["messages"] if isinstance(message.get("content"), list) for entry in message["content"] if entry.get("type") == "tool_result"]
        assert "succeeded" in json.dumps(observations[-1])
        return MessagesResponse(content=[{"type": "text", "text": "Completed from fresh evidence"}], stop_reason="end_turn")

    todos = TaskState()
    _write_todos(todos, [("B", "in_progress"), ("C", "pending")], "todo-b")
    loop = _fake_loop(SimpleNamespace(call_messages=call_messages),
        config=LoopConfig(max_iterations=5, compact_threshold=4, keep_tail_messages=2,
            compact_preservation_cb=lambda transcript: preserve_task_context(transcript, todos.snapshot_for_checkpoint())),
        handler=partial(task_get_handler, store=store))
    outcome = loop.run(system="fixture", user_message="Poll the task and summarize")
    assert outcome.final_text == "Completed from fresh evidence"
    assert not outcome.aborted
    events = [block.block for block in outcome.blocks if block.block.get("kind_detail") == "compact.complete"]
    assert events and all(e["cause"] == "message_count" for e in events)
    assert all(e["status"] == "applied" and e["preservation_status"] == "applied" for e in events)
    for event in events:
        for field in ("before_message_count", "after_message_count", "before_chars", "after_chars"):
            assert isinstance(event[field], int)
        assert not any("token" in key for key in event)
    assert any(message.get("kind") == "transcript.compact.todos" for message in seen[-1])
    saved = json.loads(json.dumps(outcome.checkpoint.asdict()))
    assert any(block["block"].get("kind_detail") == "compact.complete" for block in saved["blocks"])


def test_reactive_event_reports_only_adopted_compaction():
    calls = 0

    def call_messages(**kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return MessagesResponse(content=[{"type": "tool_use", "id": "big-read", "name": "read_file", "input": {}}], stop_reason="tool_use")
        if calls == 2:
            raise LLMError("context_length_exceeded")
        return MessagesResponse(content=[{"type": "text", "text": "Recovered"}], stop_reason="end_turn")

    loop = _fake_loop(SimpleNamespace(call_messages=call_messages), name="read_file",
        config=LoopConfig(max_iterations=4, enable_microcompact=False),
        handler=lambda call: ToolResult.from_text(tool_use_id=call.id, name=call.name, text="x" * 50_000))
    outcome = loop.run(system="fixture", user_message="Read the fixture")
    events = [block.block for block in outcome.blocks if block.block.get("kind_detail") == "compact.complete"]
    assert events[-1]["status"] == "applied"
    assert all(event["status"] == "unchanged" for event in events[:-1])
    assert events[-1]["cause"] == "context_overflow"
    assert events[-1]["after_chars"] < events[-1]["before_chars"]
    assert not outcome.aborted


def test_failed_preservation_callback_is_visible_as_context_degraded():
    def broken(_):
        raise ValueError("fixture preservation failure")

    loop = _fake_loop(None, config=LoopConfig(compact_threshold=3, keep_tail_messages=2, compact_preservation_cb=broken))
    events = []
    messages = [{"role": "user", "content": "Goal B"}] + [{"role": "assistant", "content": str(i)} for i in range(8)]
    loop._maybe_compact(messages, emit=lambda role, payload: events.append(payload))
    assert events[-1]["status"] == "context_degraded"
    assert events[-1]["preservation_status"] == "failed"
