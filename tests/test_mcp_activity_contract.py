"""Regression for per-call session explosion and missing public work updates."""
import json
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from jsonschema import Draft202012Validator

from nerya.db.repositories import AgentSessionRepository
from nerya.db.sqlite import connect
from nerya.mcp.catalog import ExposedTool, ToolCatalog
from nerya.mcp.inbound_sessions import InboundSessions, active_call

pytestmark = pytest.mark.smoke


def make_store(tmp_path, source="mcp", handler=None):
    cfg = SimpleNamespace(paths=SimpleNamespace(db=tmp_path / "db.sqlite3"))
    catalog = ToolCatalog()
    catalog.add(ExposedTool("inspect", "Inspect actual state", {
        "type": "object", "properties": {"value": {"type": "integer"}},
        "required": ["value"], "additionalProperties": False,
    }, True, handler or (lambda value: {"ok": True, "value": value})))
    return InboundSessions(cfg, catalog, source=source)


def counts(store):
    con = connect(store.config.paths.db)
    try:
        return tuple(con.execute("SELECT count(*) FROM " + table).fetchone()[0]
                     for table in ("agent_sessions", "agent_messages", "agent_tool_events"))
    finally:
        con.close()


def traces(store, sid):
    con = connect(store.config.paths.db)
    try:
        return [json.loads(row["meta_json"])["turn"]["external_call"]
                for row in AgentSessionRepository(con).transcript(sid, limit=0)]
    finally:
        con.close()


def opened(store, key="conversation-one"):
    result = store.call("nerya_session", {"action": "open", "client_request_id": key,
                                         "title": "Same title, not identity"})
    assert result["ok"], result
    return result


def test_missing_or_invalid_ids_and_session_list_create_zero_rows(tmp_path):
    called = []
    store = make_store(tmp_path, handler=lambda value: called.append(value))
    for _ in range(30):
        assert store.call("inspect", {"value": 1})["error"]["code"] == "session_required"
        assert store.call("inspect", {"value": 1, "remote_session_id": "bad"})["error"]["code"] == "invalid_session"
        assert store.call("nerya_session", {"action": "list"}) == {"ok": True, "sessions": []}
        assert store.call("nerya_session", {})["error"]["code"] == "session_identity_required"
    assert counts(store) == (0, 0, 0)
    assert not called


def test_repeated_open_resume_and_list_do_not_create_messages(tmp_path):
    store = make_store(tmp_path)
    first = opened(store)
    assert first["created"]
    for _ in range(20):
        repeat = opened(store)
        assert repeat["remote_session_id"] == first["remote_session_id"]
        assert not repeat["created"]
        assert store.call("nerya_session", {"remote_session_id": first["remote_session_id"]})["ok"]
        assert len(store.call("nerya_session", {"action": "list"})["sessions"]) == 1
    assert counts(store) == (1, 0, 0)


def test_parallel_open_across_stores_is_idempotent_and_survives_restart(tmp_path):
    initial = make_store(tmp_path)
    counts(initial)  # migrate once before concurrent independent connections
    with ThreadPoolExecutor(max_workers=8) as pool:
        rows = list(pool.map(lambda _: opened(make_store(tmp_path)), range(24)))
    assert len({row["remote_session_id"] for row in rows}) == 1
    assert sum(row["created"] for row in rows) == 1
    assert counts(initial) == (1, 0, 0)
    assert opened(make_store(tmp_path))["remote_session_id"] == rows[0]["remote_session_id"]


def test_same_title_different_conversation_keys_or_sources_stay_isolated(tmp_path):
    store = make_store(tmp_path)
    ids = {opened(store, key)["remote_session_id"] for key in ("conversation-one", "conversation-two")}
    ids.add(opened(make_store(tmp_path, "tunnel"))["remote_session_id"])
    assert len(ids) == 3
    assert counts(store)[0] == 3


def test_activity_is_persisted_before_dispatch_and_not_passed_to_handler(tmp_path):
    seen = []
    def handler(value):
        trace = active_call()
        row = traces(trace.store, trace.session_id)[-1]
        assert row["status"] == "running"
        assert row["activity"]["next"] == "Read current state"
        assert row["purpose"] == "Check continuity"
        seen.append(value)
        return {"ok": True, "value": value}
    store = make_store(tmp_path, handler=handler)
    sid = opened(store)["remote_session_id"]
    result = store.call("inspect", {"remote_session_id": sid, "value": 1,
        "purpose": "Check continuity", "activity": {"intent": "Verify session", "next": "Read current state"}})
    assert result["ok"] and seen == [1]
    row = traces(store, sid)[-1]
    assert row["status"] == "succeeded"
    assert row["arguments"] == {"value": 1}


def test_task_groups_and_sequences_survive_restart_and_progress_uses_same_session(tmp_path):
    store = make_store(tmp_path)
    sid = opened(store)["remote_session_id"]
    first = store.call("inspect", {"remote_session_id": sid, "value": 1,
        "activity": {"intent": "Check continuity", "next": "Read state"}})
    store = make_store(tmp_path)
    store.call("inspect", {"remote_session_id": sid, "value": 2,
        "activity": {"intent": "Check continuity", "evidence": "First read succeeded", "next": "Verify again"}})
    progress = store.call("nerya_progress", {"remote_session_id": sid,
        "current": "Verification completed", "status": "completed", "result": ["Two reads in one conversation"]})
    rows = traces(store, sid)
    assert len(rows) == 3
    assert [row["sequence"] for row in rows] == [1, 2, 3]
    assert len({row["turn_id"] for row in rows}) == 1
    assert progress["nerya_trace"]["remote_session_id"] == sid
    assert progress["progress"]["status"] == "completed"
    third = store.call("inspect", {"remote_session_id": sid, "value": 3,
        "activity": {"intent": "A new task", "next": "Read next item"}})
    assert third["nerya_trace"]["turn_id"] != first["nerya_trace"]["turn_id"]
    assert counts(store)[0] == 1


def test_public_activity_and_progress_redact_secrets(tmp_path):
    store = make_store(tmp_path)
    sid = opened(store)["remote_session_id"]
    result = store.call("nerya_progress", {"remote_session_id": sid, "current": "password=unique-secret-needle",
        "result": ["api_key=another-secret-needle"], "activity": {"evidence": "token=secret-evidence-needle"}})
    text = json.dumps([result, traces(store, sid)])
    assert "unique-secret-needle" not in text
    assert "another-secret-needle" not in text
    assert "secret-evidence-needle" not in text


@pytest.mark.parametrize("activity", [None, [], {"next": 1}, {"unknown": "ignored?"}, {"evidence": "x" * 4001}])
def test_invalid_activity_has_no_execution_or_log_side_effects(tmp_path, activity):
    seen = []
    store = make_store(tmp_path, handler=lambda value: seen.append(value))
    sid = opened(store)["remote_session_id"]
    result = store.call("inspect", {"remote_session_id": sid, "value": 1, "activity": activity})
    assert result["error"]["code"] == "invalid_arguments"
    assert counts(store) == (1, 0, 0) and not seen


def test_tools_advertise_required_session_and_public_activity_without_changing_business_schema(tmp_path):
    store = make_store(tmp_path)
    schema = next(row for row in store.descriptors() if row["name"] == "inspect")["inputSchema"]
    assert not Draft202012Validator(schema).is_valid({"value": 1})
    assert "activity" in schema["properties"]
    assert "remote_session_id" not in store.catalog.describe("inspect")["inputSchema"]["properties"]
