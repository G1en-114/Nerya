from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import threading
import time

import pytest

from nerya.agent.command_runtime import CommandRuntime, outcome_state
from nerya.agent.command_store import CommandError, CommandStore
from nerya.agent.streaming import StreamingEventBus, get_default_bus
from nerya.core.config import Config, DEFAULT_CONFIG
from nerya.core.paths import WorkspacePaths
from nerya.harness.cancellation import (CancelToken, SteerInbox, register_token,
    unregister_token, register_steer_inbox, unregister_steer_inbox)

pytestmark = pytest.mark.smoke


def config(tmp_path):
    return Config(paths=WorkspacePaths(root=tmp_path),data=deepcopy(DEFAULT_CONFIG))


def payload(cid="command-001",text="inspect files",kind="send"):
    return {"command_id":cid,"session_id":"conversation-1","command_type":kind,
            "_auth_actor_id":"operator","request":{"source":"user_chat","payload":{"text":text}}}


def wait_for(test, timeout=5):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        value=test()
        if value:
            return value
        time.sleep(.02)
    raise AssertionError("condition did not become true")


def test_concurrent_same_command_is_admitted_once(tmp_path):
    runtime=CommandRuntime(config(tmp_path),lambda *_: {},epoch="a")
    with ThreadPoolExecutor(max_workers=6) as pool:
        receipts=list(pool.map(lambda _:runtime.submit(payload(),start=False),range(20)))
    assert sum(not r["duplicate"] for r in receipts)==1
    snapshot=runtime.store.snapshot("conversation-1")
    assert len(snapshot["commands"])==1
    with pytest.raises(CommandError,match="command_conflict"):
        runtime.submit(payload(text="different"),start=False)


def test_same_text_new_command_is_a_new_intent(tmp_path):
    runtime=CommandRuntime(config(tmp_path),lambda *_:{},epoch="a")
    runtime.submit(payload(),start=False)
    runtime.submit(payload("command-002"),start=False)
    assert len(runtime.store.snapshot("conversation-1")["commands"])==2


def test_queue_revision_edit_reorder_remove_and_claim_guard(tmp_path):
    runtime=CommandRuntime(config(tmp_path),lambda *_:{},epoch="a")
    store=runtime.store
    for number in range(3):
        runtime.submit(payload(f"command-00{number}"),start=False)
    first=store.snapshot("conversation-1")["commands"][0]
    store.control("conversation-1","edit",cid=first["command_id"],revision=first["revision"],text="edited")
    with pytest.raises(CommandError,match="revision_conflict"):
        store.control("conversation-1","remove",cid=first["command_id"],revision=first["revision"])
    retry=runtime.submit(payload("command-000"),start=False)
    assert retry["duplicate"] and retry["command"]["input"]=="edited"
    rows=store.snapshot("conversation-1")["commands"]
    store.control("conversation-1","move",cid=rows[2]["command_id"],revision=rows[2]["revision"],before=rows[0]["command_id"])
    claimed=store.claim("conversation-1","owner")
    assert claimed["command_id"]=="command-002"
    assert store.claim("conversation-1","other-owner") is None
    running=store.snapshot("conversation-1","command-002")["command"]
    with pytest.raises(CommandError,match="already_claimed"):
        store.control("conversation-1","edit",cid="command-002",revision=running["revision"],text="wrong")


def test_restart_pauses_queue_and_does_not_replay(tmp_path):
    runtime=CommandRuntime(config(tmp_path),lambda *_:{},epoch="a")
    runtime.submit(payload(),start=False)
    restarted=CommandStore(runtime.config.paths,"b")
    snapshot=restarted.snapshot("conversation-1")
    assert snapshot["queue"]["paused"] and snapshot["queue"]["pause_reason"]=="restarted"
    assert restarted.claim("conversation-1","new-worker") is None
    restarted.control("conversation-1","resume",revision=snapshot["queue"]["revision"])
    assert restarted.claim("conversation-1","new-worker")


def test_expired_running_lease_is_unknown_not_cancelled(tmp_path):
    runtime=CommandRuntime(config(tmp_path),lambda *_:{},epoch="a")
    runtime.submit(payload(),start=False)
    store=runtime.store
    store.claim("conversation-1","lost-worker")
    with store.transaction() as con:
        con.execute("UPDATE agent_command_queues SET lease_until=1")
    restarted=CommandStore(runtime.config.paths,"b")
    snapshot=restarted.snapshot("conversation-1")
    assert snapshot["commands"][0]["state"]=="unconfirmed"
    with pytest.raises(CommandError,match="execution_unconfirmed"):
        restarted.control("conversation-1","resume",revision=snapshot["queue"]["revision"])
    assert not store.finish("command-001","conversation-1","lost-worker","succeeded",{})


def test_stop_is_requested_before_execution_terminal(tmp_path):
    entered=threading.Event()
    release=threading.Event()
    def execute(_config,request):
        token=CancelToken()
        register_token(request["turn_id"],token)
        entered.set()
        try:
            assert release.wait(5)
            assert token.is_set
            return {"turn_id":request["turn_id"],"stopped_reason":"cancelled"}
        finally:
            unregister_token(request["turn_id"])
    runtime=CommandRuntime(config(tmp_path),execute,epoch="a")
    runtime.submit(payload())
    assert entered.wait(3)
    current=runtime.store.snapshot("conversation-1","command-001")["command"]
    try:
        response=runtime.control({"action":"stop","session_id":"conversation-1","command_id":"command-001","expected_revision":current["revision"]})
        assert response["commands"][0]["state"]=="stopping"
    finally:
        release.set()
    wait_for(lambda:runtime.store.snapshot("conversation-1","command-001")["command"]["state"]=="interrupted")


def test_guide_receipt_only_after_actual_insertion(tmp_path):
    runtime=CommandRuntime(config(tmp_path),lambda *_:{},epoch="a")
    runtime.submit(payload(),start=False)
    row=runtime.store.claim("conversation-1","owner")
    inbox=SteerInbox()
    register_steer_inbox(row["turn_id"],inbox)
    try:
        runtime.submit(payload("guidance-001","include constraints","guide"),start=False)
        runtime._guides("conversation-1",row["turn_id"])
        assert runtime.store.snapshot("conversation-1","guidance-001")["command"]["state"]=="delivered"
        texts=inbox.drain()
        assert texts==["include constraints"]
        assert runtime.store.snapshot("conversation-1","guidance-001")["command"]["state"]=="delivered"
        texts[0].confirm()
        texts[0].confirm()
        assert runtime.store.snapshot("conversation-1","guidance-001")["command"]["state"]=="injected"
        assert runtime.submit(payload("guidance-001","include constraints","guide"),start=False)["duplicate"]
        assert inbox.drain()==[]
    finally:
        unregister_steer_inbox(row["turn_id"])


def test_unconsumed_guide_is_preserved_as_not_consumed(tmp_path):
    runtime=CommandRuntime(config(tmp_path),lambda *_:{},epoch="a")
    runtime.submit(payload(),start=False)
    runtime.store.claim("conversation-1","owner")
    runtime.submit(payload("guidance-001","too late","guide"),start=False)
    runtime.store.finish("command-001","conversation-1","owner","succeeded",{})
    assert runtime.store.snapshot("conversation-1","guidance-001")["command"]["state"]=="not_consumed"
    with pytest.raises(CommandError,match="no_running_turn"):
        runtime.submit(payload("guidance-002","later","guide"),start=False)


def test_event_pagination_covers_600_and_filtered_global_gaps():
    bus=StreamingEventBus()
    for i in range(600):
        bus.publish("tool.complete",session_id="s",number=i)
        bus.publish("tool.complete",session_id="other")
    first=bus.page(after_seq=0,session_id="s",limit=500)
    assert first["has_more"] and first["events"][0]["number"]==0
    second=bus.page(after_seq=first["next_cursor"],epoch=first["epoch"],session_id="s",limit=500)
    assert [e["number"] for e in first["events"]+second["events"]]==list(range(600))
    assert not second["has_more"] and not second["reset_required"]


def test_event_reset_epoch_and_retention_are_explicit():
    bus=StreamingEventBus(_max_replay=10)
    old=bus.page()
    for _ in range(20):
        bus.publish("tick")
    assert bus.page(after_seq=0)["reset_required"]
    bus.clear()
    assert bus.page(after_seq=old["cursor"],epoch=old["epoch"])["reset_required"]


def test_concurrent_event_allocations_and_payload_cannot_override_sequence():
    bus=StreamingEventBus()
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda _:bus.publish("tick",seq=99999),range(600)))
    assert [event["seq"] for event in bus.recent()]==list(range(1,601))


def test_durable_events_survive_bus_clear_and_deduplicate(tmp_path):
    runtime=CommandRuntime(config(tmp_path),lambda *_:{},epoch="a")
    runtime.submit(payload(),start=False)
    for i in range(610):
        event={"event_id":f"e{i}","kind":"tool.complete","number":i}
        runtime.store.record_event("command-001",event)
        runtime.store.record_event("command-001",event)
    get_default_bus().clear()
    first=runtime.store.events("conversation-1","command-001")
    second=runtime.store.events("conversation-1","command-001",first["cursor"])
    assert [e["number"] for e in first["events"]+second["events"]]==list(range(610))


@pytest.mark.parametrize("result,state",[({"stopped_reason":"end_turn"},"succeeded"),
    ({"stopped_reason":"max_iterations"},"blocked"),({"stopped_reason":"approval_pending"},"awaiting_approval"),
    ({"stopped_reason":"cancelled"},"interrupted"),({"ok":False},"failed")])
def test_execution_outcomes_are_not_all_success(result,state):
    assert outcome_state(result)==state
