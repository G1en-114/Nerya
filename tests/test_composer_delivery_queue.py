"""Composer follow-ups exercise the real store in temporary SQLite workspaces."""
from copy import deepcopy

import pytest

from nerya.agent.command_runtime import CommandRuntime
from nerya.agent.command_store import CommandError
from nerya.agent.interactions import create_interaction, respond
from nerya.core.config import Config, DEFAULT_CONFIG
from nerya.core.paths import WorkspacePaths
from nerya.db.repositories import AgentSessionRepository

SID = "composer-followup"


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    def never_execute(*_):
        raise AssertionError("This fixture must not execute a model or tool")

    rt = CommandRuntime(Config(paths=WorkspacePaths(root=tmp_path), data=deepcopy(DEFAULT_CONFIG)),
                        never_execute, epoch="composer-fixture")
    monkeypatch.setattr(rt, "kick", lambda _: None)
    return rt


def send(rt, cid="command-original", **request):
    return rt.submit({"command_id": cid, "session_id": SID, "_auth_actor_id": "operator",
                      "request": {"payload": {"text": cid}, **request}}, start=False)["command"]


def pause(rt):
    queue = rt.store.snapshot(SID)["queue"]
    rt.store.control(SID, "pause", revision=queue["revision"])


def continuation(rt, kind, *, held=False, operator_pause=None):
    send(rt)
    original = rt.store.claim(SID, "owner")
    if held:
        send(rt, "command-held")
    if operator_pause == "before_wait":
        pause(rt)
    if kind != "approval":
        interaction = create_interaction(rt.config, sid=SID, tid=original["turn_id"],
            call_id="fixture-decision", kind=kind, payload={"title": "Read evidence?", "steps": ["Read"]})
        if kind == "question":
            with rt.store.transaction() as con:
                AgentSessionRepository(con).save_turn_checkpoint(session_id=SID,
                    turn_id=original["turn_id"], checkpoint={"resumable": True})
    state = "awaiting_approval" if kind == "approval" else "awaiting_input"
    rt.store.finish(original["command_id"], SID, "owner", state)
    if operator_pause == "after_wait":
        pause(rt)
    if kind == "approval":
        receipt = rt.resolve_approval({"approval_id": "fixture-approval", "state": "approved",
            "kind": "tool_permission_batch", "session_id": SID, "turn_id": original["turn_id"],
            "requester_actor_id": "operator"}, start=False)
    else:
        receipt = respond(rt, {"session_id": SID, "interaction_id": interaction["interaction_id"],
            "response_id": "fixture-response", "expected_revision": interaction["revision"],
            "_auth_actor_id": "operator", "action": "answer" if kind == "question" else "accept",
            "text": "Read the evidence"})
    resumed = rt.store.claim(SID, "owner")
    assert resumed["command_id"] == receipt["command"]["command_id"]
    if operator_pause == "during_continuation":
        pause(rt)
    rt.store.finish(resumed["command_id"], SID, "owner", "succeeded")
    return resumed


@pytest.mark.parametrize("kind", ["question", "plan", "approval"])
def test_successful_continuation_allows_next_ordinary_send(runtime, kind):
    resumed = continuation(runtime, kind)
    before = runtime.store.snapshot(SID)
    assert all(row["state"] != "queued" for row in before["commands"])
    assert runtime.store.snapshot(SID, resumed["command_id"])["command"]["state"] == "succeeded"
    send(runtime, "command-followup")
    claimed = runtime.store.claim(SID, "followup-owner")
    assert claimed is not None, before["queue"]
    assert claimed["command_id"] == "command-followup"


@pytest.mark.parametrize("kind", ["question", "plan", "approval"])
def test_successful_continuation_preserves_held_queue(runtime, kind):
    continuation(runtime, kind, held=True)
    send(runtime, "command-followup")
    assert runtime.store.claim(SID, "next-owner") is None
    assert runtime.store.snapshot(SID)["queue"]["paused"]
    assert runtime.store.snapshot(SID, "command-held")["command"]["state"] == "queued"


@pytest.mark.parametrize("kind", ["question", "plan", "approval"])
@pytest.mark.parametrize("when", ["before_wait", "after_wait", "during_continuation"])
def test_operator_pause_survives_continuation(runtime, kind, when):
    continuation(runtime, kind, operator_pause=when)
    send(runtime, "command-followup")
    assert runtime.store.claim(SID, "next-owner") is None
    queue = runtime.store.snapshot(SID)["queue"]
    assert queue["paused"] and queue["pause_reason"] == "operator"


@pytest.mark.parametrize("reason", ["operator", "restarted", "unconfirmed", "unknown", "failed", "interrupted", "blocked"])
def test_empty_protected_pause_is_not_automatically_released(runtime, reason):
    send(runtime)
    runtime.store.claim(SID, "owner")
    runtime.store.finish("command-original", SID, "owner", "succeeded")
    with runtime.store.transaction() as con:
        con.execute("UPDATE agent_command_queues SET paused=1,pause_reason=? WHERE session_id=?", (reason, SID))
    send(runtime, "command-followup")
    assert runtime.store.claim(SID, "next-owner") is None


@pytest.mark.parametrize("held", [False, True])
def test_explicit_run_only_keeps_operator_pause_and_older_queue(runtime, held):
    pause(runtime)
    if held:
        send(runtime, "command-held")
    send(runtime, "command-explicit", run_only=True)
    assert runtime.store.claim(SID, "owner")["command_id"] == "command-explicit"
    runtime.store.finish("command-explicit", SID, "owner", "succeeded")
    assert runtime.store.claim(SID, "next-owner") is None
    assert runtime.store.snapshot(SID)["queue"]["pause_reason"] == "operator"


@pytest.mark.parametrize("reason", ["operator", "unknown", "restarted", "unconfirmed"])
def test_success_cannot_release_a_safety_hold(runtime, reason):
    send(runtime)
    runtime.store.claim(SID, "owner")
    with runtime.store.transaction() as con:
        con.execute("UPDATE agent_command_queues SET paused=1,pause_reason=? WHERE session_id=?", (reason, SID))
    runtime.store.finish("command-original", SID, "owner", "succeeded")
    send(runtime, "command-followup")
    assert runtime.store.claim(SID, "next-owner") is None
    assert runtime.store.snapshot(SID)["queue"]["pause_reason"] == reason


@pytest.mark.parametrize("reason", ["operator", "unknown", "approval_continued"])
def test_restart_does_not_clear_an_empty_pause(runtime, reason):
    pause(runtime)
    with runtime.store.transaction() as con:
        con.execute("UPDATE agent_command_queues SET pause_reason=? WHERE session_id=?", (reason, SID))
    restarted = CommandRuntime(runtime.config, runtime.execute, epoch="after-restart")
    assert restarted.store.snapshot(SID)["queue"]["paused"]
    send(restarted, "command-followup")
    assert restarted.store.claim(SID, "next-owner") is None


@pytest.mark.parametrize("interaction_state", ["pending", "deferred", "answered"])
def test_success_with_unresolved_interaction_keeps_system_pause(runtime, interaction_state):
    send(runtime)
    original = runtime.store.claim(SID, "owner")
    item = create_interaction(runtime.config, sid=SID, tid=original["turn_id"],
        call_id="still-waiting", kind="question", payload={"title": "Choose"})
    with runtime.store.transaction() as con:
        con.execute("UPDATE agent_interactions SET state=? WHERE interaction_id=?", (interaction_state, item["interaction_id"]))
        con.execute("UPDATE agent_command_queues SET paused=1,pause_reason='awaiting_input' WHERE session_id=?", (SID,))
    runtime.store.finish("command-original", SID, "owner", "succeeded")
    assert runtime.store.snapshot(SID)["queue"]["paused"]
    with pytest.raises(CommandError, match="interaction_response_required"):
        send(runtime, "command-followup", run_only=True)


def test_pending_approval_blocks_ordinary_send_and_run_only(runtime):
    send(runtime)
    runtime.store.claim(SID, "owner")
    runtime.store.finish("command-original", SID, "owner", "awaiting_approval")
    send(runtime, "command-followup")
    assert runtime.store.claim(SID, "next-owner") is None
    with pytest.raises(CommandError, match="decision_pending"):
        send(runtime, "command-explicit", run_only=True)


def test_unconfirmed_execution_blocks_ordinary_send_and_run_only(runtime):
    send(runtime)
    runtime.store.claim(SID, "owner")
    with runtime.store.transaction() as con:
        con.execute("UPDATE agent_command_queues SET lease_until=0 WHERE session_id=?", (SID,))
    assert runtime.store.snapshot(SID, "command-original")["command"]["state"] == "unconfirmed"
    send(runtime, "command-followup")
    assert runtime.store.claim(SID, "next-owner") is None
    with pytest.raises(CommandError, match="execution_unconfirmed"):
        send(runtime, "command-explicit", run_only=True)
