"""Offline protocol regression: actual SQLite messages, no network/model/trading."""
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from nerya.db.repositories import AgentSessionRepository
from nerya.db.sqlite import connect
from nerya.mcp.catalog import ToolCatalog, ExposedTool
from nerya.mcp.inbound_sessions import InboundSessions
from nerya.mcp.operator_messages import append_message

pytestmark = pytest.mark.smoke


def make_store(tmp_path, source="mcp", handler=None):
    catalog = ToolCatalog()
    catalog.add(ExposedTool("echo", "test echo", {"type": "object", "additionalProperties": False,
        "properties": {"value": {"type": "integer"}}, "required": ["value"]}, True,
        handler or (lambda value: {"ok": True, "value": value})))
    config = SimpleNamespace(paths=SimpleNamespace(db=tmp_path / "messages.sqlite3"))
    return InboundSessions(config, catalog, source=source)


def open_session(store, key="conversation-one"):
    return store.call("nerya_session", {"action": "open", "client_request_id": key})["remote_session_id"]


def send(store, sid, text="Only inspect, do not trade", key="message-one"):
    return append_message(store.config, {"session_id": sid, "text": text, "client_request_id": key})


def call(store, sid, **extra):
    return store.call("echo", {"remote_session_id": sid, "value": 1, **extra})


def transcript(store, sid):
    con = connect(store.config.paths.db)
    try:
        return AgentSessionRepository(con).transcript(sid, limit=0)
    finally:
        con.close()


@pytest.mark.parametrize("source", ["mcp", "tunnel"])
def test_append_deliver_repeat_restart_acknowledge_in_same_session(tmp_path, source):
    store = make_store(tmp_path, source)
    sid = open_session(store)
    first = call(store, sid)
    added = send(store, sid)
    mid = added["message"]["id"]
    assert added["message"]["external_request"]["after_call_id"] == first["nerya_trace"]["call_id"]
    assert send(store, sid)["created"] is False
    delivered = call(store, sid)
    assert delivered["operator_control"]["requests"][0]["id"] == mid
    restarted = make_store(tmp_path, source)
    assert call(restarted, sid)["operator_control"]["requests"][0]["id"] == mid
    ack = call(restarted, sid, acknowledge_requests=[mid])
    assert ack["ok"] and ack["operator_control"]["requests"] == []
    assert call(restarted, sid, acknowledge_requests=[mid])["ok"]  # idempotent acknowledgement
    users = [row for row in transcript(store, sid) if row["role"] == "user"]
    assert len(users) == 1
    assert json.loads(users[0]["meta_json"])["external_request"]["state"] == "acknowledged"


def test_message_arriving_during_tool_is_in_that_result(tmp_path):
    started, finish = threading.Event(), threading.Event()
    def slow(value):
        started.set()
        assert finish.wait(5)
        return {"ok": True}
    store = make_store(tmp_path, handler=slow)
    sid = open_session(store)
    with ThreadPoolExecutor() as pool:
        future = pool.submit(call, store, sid)
        assert started.wait(5)
        added = send(store, sid)
        finish.set()
        result = future.result(timeout=5)
    assert result["operator_control"]["requests"][0]["id"] == added["message"]["id"]
    assert result["operator_control"]["requests"][0]["after_call_id"] == result["nerya_trace"]["call_id"]


def test_failed_tool_still_delivers_and_progress_appends_after_it(tmp_path):
    store = make_store(tmp_path, handler=lambda value: {"ok": False, "error": {"message": "expected test failure"}})
    sid = open_session(store)
    mid = send(store, sid)["message"]["id"]
    failed = call(store, sid)
    assert failed["ok"] is False and failed["operator_control"]["requests"][0]["id"] == mid
    progress = store.call("nerya_progress", {"remote_session_id": sid, "current": "The tool failed; no action retried.",
        "status": "blocked", "acknowledge_requests": [mid]})
    assert progress["ok"] and progress["operator_control"]["requests"] == []
    rows = transcript(store, sid)
    assert [r["role"] for r in rows] == ["user", "assistant", "assistant"]
    assert json.loads(rows[-1]["meta_json"])["turn"]["external_call"]["tool"] == "nerya_progress"


def test_foreign_or_undelivered_ack_cannot_execute_or_consume_messages(tmp_path):
    calls = []
    store = make_store(tmp_path, handler=lambda value: calls.append(value) or {"ok": True})
    a, b = open_session(store), open_session(store, "conversation-two")
    mid = send(store, a)["message"]["id"]
    assert call(store, a, acknowledge_requests=[mid])["error"]["code"] == "invalid_acknowledgement"
    assert not calls
    assert store.call("nerya_session", {"action": "resume", "remote_session_id": a})["operator_control"]["requests"]
    assert call(store, b, acknowledge_requests=[mid])["error"]["code"] == "invalid_acknowledgement"
    assert not calls
    assert call(store, b)["operator_control"]["requests"] == []
    assert call(store, a)["operator_control"]["requests"][0]["id"] == mid


def test_bounded_delivery_retains_tail_until_acknowledged(tmp_path):
    store = make_store(tmp_path)
    sid = open_session(store)
    ids = [send(store, sid, f"note {i}", f"message-{i:04}")["message"]["id"] for i in range(18)]
    first = call(store, sid)["operator_control"]
    assert [r["id"] for r in first["requests"]] == ids[:16] and first["has_more"]
    last = call(store, sid, acknowledge_requests=ids[:16])["operator_control"]
    assert [r["id"] for r in last["requests"]] == ids[16:] and not last["has_more"]


def test_invalid_session_conflict_and_secret_redaction(tmp_path):
    store = make_store(tmp_path)
    with pytest.raises(ValueError): send(store, "ext_mcp_" + "0" * 32)
    sid = open_session(store)
    send(store, sid)
    with pytest.raises(ValueError): send(store, sid, "different text, same retry key")
    with pytest.raises(ValueError): send(store, sid, " " * 10, "other-key")
    with pytest.raises(ValueError): send(store, sid, "x" * 8001, "other-key")
    added = send(store, sid, "api_key=never-publish-this", "secret-key")
    assert "never-publish-this" not in added["message"]["text"]
    assert "never-publish-this" not in json.dumps(call(store, sid)["operator_control"])


def test_ack_metadata_is_advertised_but_not_passed_to_business_handler(tmp_path):
    store = make_store(tmp_path)
    assert all("acknowledge_requests" in row["inputSchema"]["properties"] for row in store.descriptors())
    sid = open_session(store)
    assert call(store, sid, acknowledge_requests="bad")["error"]["code"] == "invalid_arguments"
    assert call(store, sid, acknowledge_requests=[])["ok"]


def test_business_payload_cannot_redirect_operator_messages(tmp_path):
    store = make_store(tmp_path)
    a, b = open_session(store), open_session(store, 'second-session-key')
    own = send(store, a, 'A only')['message']['id']
    send(store, b, 'B only')
    store.catalog.tools['echo'].fn = lambda value: {'ok': True, 'remote_session_id': b}
    result = call(store, a)
    assert [row['id'] for row in result['operator_control']['requests']] == [own]


def test_delivery_failure_does_not_make_completed_tool_retryable(tmp_path, monkeypatch):
    from nerya.mcp import operator_messages
    calls = []
    store = make_store(tmp_path, handler=lambda value: calls.append(value) or {'ok': True})
    sid = open_session(store)
    def broken(*a, **k): raise RuntimeError('delivery unavailable')
    monkeypatch.setattr(operator_messages, 'pending_messages', broken)
    result = call(store, sid)
    assert result['ok'] and len(calls) == 1
    assert result['operator_control']['delivery_error']
    assert 'do NOT replay' in result['operator_control']['guidance']
