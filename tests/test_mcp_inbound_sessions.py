"""Offline external conversation isolation and durable call-chain regression tests."""
from __future__ import annotations

import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

from nerya.db.repositories import AgentSessionRepository
from nerya.db.sqlite import connect
from nerya.mcp.catalog import ExposedTool, ToolCatalog
from nerya.mcp.inbound_sessions import InboundSessions, InboundTraceExecutor, SESSION_TOOL, active_call

pytestmark = pytest.mark.smoke


def catalog(handler=None):
    result = ToolCatalog()
    result.add(ExposedTool("echo", "Echo for isolated tests", {
        "type": "object", "properties": {"value": {"type": "integer"},
            "password": {"type": "string"}}, "required": ["value"], "additionalProperties": False,
    }, True, handler or (lambda **args: {"ok": True, **args})))
    return result


@pytest.fixture
def store(tmp_path):
    config = SimpleNamespace(paths=SimpleNamespace(db=tmp_path / "state.sqlite3"))
    return InboundSessions(config, catalog())


def session(store, **kwargs):
    result = store.call(SESSION_TOOL, {"action": "open", "client_request_id": uuid.uuid4().hex, **kwargs})
    assert result["ok"], result
    return result["remote_session_id"]


def traces(store, sid):
    con = connect(store.config.paths.db)
    try:
        return [json.loads(row["meta_json"])["turn"]["external_call"]
                for row in AgentSessionRepository(con).transcript(sid, limit=0)]
    finally:
        con.close()


def test_same_session_groups_calls_and_distinct_sessions_never_merge(store):
    a, b = session(store, title="Research A"), session(store, title="Research B")
    assert a != b
    one = store.call("echo", {"remote_session_id": a, "value": 1}, request_id=7)
    two = store.call("echo", {"remote_session_id": a, "value": 2}, request_id=7)
    three = store.call("echo", {"remote_session_id": b, "value": 3})
    assert one["nerya_trace"]["call_id"] != two["nerya_trace"]["call_id"]
    assert [t["arguments"]["value"] for t in traces(store, a)] == [1, 2]
    assert [t["arguments"]["value"] for t in traces(store, b)] == [3]
    assert three["nerya_trace"]["remote_session_id"] == b
    assert all(t["remote_session_id"] == a for t in traces(store, a))
    assert active_call() is None


def session_count(store):
    con = connect(store.config.paths.db)
    try:
        return con.execute("SELECT COUNT(*) FROM agent_sessions").fetchone()[0]
    finally:
        con.close()


def test_unidentified_requests_do_not_execute_or_create_threads(store):
    called = []
    store.catalog = catalog(lambda **args: called.append(args) or {"ok": True})
    for _ in range(20):
        result = store.call("echo", {"value": 1})
        assert result["error"]["code"] == "session_required"
        assert "nerya_trace" not in result
    assert session_count(store) == 0
    assert not called


@pytest.mark.parametrize("sid", ["ext_mcp_" + "0" * 32, "dashboard-chat", "", 0, False, {}])
def test_invalid_ids_never_create_threads_or_execute_business_tools(store, sid):
    executed = []
    store.catalog = catalog(lambda **args: executed.append(args) or {"ok": True})
    result = store.call("echo", {"remote_session_id": sid, "value": 1})
    assert result["error"]["code"] == "invalid_session"
    assert not executed
    assert "nerya_trace" not in result
    assert session_count(store) == 0


def test_tunnel_and_mcp_sources_cannot_reuse_each_others_session(store):
    sid = session(store)
    tunnel = InboundSessions(store.config, catalog(), source="tunnel")
    result = tunnel.call("echo", {"remote_session_id": sid, "value": 1})
    assert result["error"]["code"] == "invalid_session"
    tsid = session(tunnel)
    assert tsid.startswith("ext_tunnel_")
    tunnel.call("echo", {"remote_session_id": tsid, "value": 1})
    assert traces(tunnel, tsid)[0]["source"] == "tunnel"


def test_restart_resumes_the_persisted_logical_session(store):
    sid = session(store)
    other_process = InboundSessions(store.config, catalog())
    result = other_process.call("echo", {"remote_session_id": sid, "value": 3})
    assert result["nerya_trace"]["remote_session_id"] == sid
    assert len(traces(store, sid)) == 1


@pytest.mark.parametrize("name,args,code", [
    ("missing", {}, "not_found"), ("echo", {}, "invalid_arguments"),
    ("echo", {"value": "not-an-integer"}, "invalid_arguments"),
    (SESSION_TOOL, {"action": "delete"}, "invalid_arguments"),
])
def test_failed_calls_are_visible_with_input_and_error(store, name, args, code):
    sid = session(store)
    result = store.call(name, {"remote_session_id": sid, **args})
    assert result["error"]["code"] == code
    if name == SESSION_TOOL:
        assert not traces(store, sid)
        return
    last = traces(store, sid)[-1]
    assert last["status"] == "failed"
    assert last["arguments"] == args
    assert last["result"]["error"]["code"] == code
    assert last["elapsed_ms"] >= 0


def test_inputs_and_results_are_redacted_without_corrupting_ids(store):
    sid = session(store)
    store.call("echo", {"remote_session_id": sid, "value": 1, "password": "unique-secret-needle"})
    last = traces(store, sid)[-1]
    assert "unique-secret-needle" not in json.dumps(last)
    assert last["arguments"]["password"] == "***REDACTED***"
    assert last["result"]["password"] == "***REDACTED***"
    assert last["remote_session_id"] == sid


def test_parent_child_tool_chain_is_persisted_before_and_after_execution(store):
    def run(**args):
        trace = active_call()
        assert trace is not None
        parent = SimpleNamespace(id="tool-parent", name="skill", arguments={"value": 1})
        child = SimpleNamespace(id="tool-child", name="read_file", arguments={"path": "README.md"})
        trace.native_start(parent)
        trace.native_start(child)
        running = traces(store, trace.session_id)[-1]
        assert running["status"] == "running"
        assert running["nodes"][1]["parent_call_id"] == parent.id
        trace.native_finish(child, {"ok": False, "error": {"code": "missing", "message": "Not found"}, "elapsed_ms": 2})
        trace.native_finish(parent, {"ok": True, "elapsed_ms": 3})
        return {"ok": True}
    store.catalog = catalog(run)
    sid = session(store)
    store.call("echo", {"remote_session_id": sid, "value": 1})
    nodes = traces(store, sid)[-1]["nodes"]
    assert nodes[0]["status"] == "succeeded"
    assert nodes[1]["status"] == "failed"
    assert nodes[1]["elapsed_ms"] == 2


def test_internal_permission_rejection_is_not_missing_from_the_chain(store):
    from nerya.tools.types import ToolResult, ToolError, ToolErrorKind
    rejected = ToolResult.from_error(tool_use_id='denied-child', name='run_shell',
        error=ToolError(kind=ToolErrorKind.PERMISSION_DENIED, message='Denied'))
    executor = InboundTraceExecutor(SimpleNamespace(execute=lambda call: rejected))
    def run(**args):
        executor.execute(SimpleNamespace(id="denied-child", name="run_shell", arguments={}))
        return {"ok": True}
    store.catalog = catalog(run)
    sid = session(store)
    store.call("echo", {"remote_session_id": sid, "value": 1})
    node = traces(store, sid)[-1]["nodes"][0]
    assert node["status"] == "failed"
    assert node["result"]["error"]["code"] == "permission_denied"


def test_catalog_and_context_are_isolated_per_session_even_with_concurrent_clients(store):
    def factory():
        calls = []
        def handler(**args):
            calls.append(active_call().session_id)
            return {"ok": True, "count": len(calls), "sessions": list(calls)}
        return catalog(handler)
    store.catalog_factory = factory
    ids = [session(store) for _ in range(6)]
    with ThreadPoolExecutor(max_workers=6) as pool:
        rows = list(pool.map(lambda sid: store.call("echo", {"remote_session_id": sid, "value": 1}), ids))
    assert all(row["count"] == 1 for row in rows)
    assert [row["sessions"] for row in rows] == [[sid] for sid in ids]
    again = store.call("echo", {"remote_session_id": ids[0], "value": 2})
    assert again["count"] == 2
    assert active_call() is None


def test_real_native_catalog_binds_session_context_and_records_tool(tmp_path, monkeypatch):
    from nerya.agent.kernel import AgentKernel
    from nerya.mcp.catalog import build_catalog
    from nerya.mcp.tools import NeryaTools
    tools = NeryaTools.boot(tmp_path)
    dependencies = []
    prepare = AgentKernel.prepare_tools
    def capture(kernel):
        registry, deps = prepare(kernel)
        dependencies.append(deps)
        return registry, deps
    monkeypatch.setattr(AgentKernel, "prepare_tools", capture)
    def factory():
        return build_catalog(tools, include_legacy=False, include_dynamic=False)
    store = InboundSessions(tools.client.config, factory(), catalog_factory=factory)
    ids = [session(store), session(store)]
    for sid in ids:
        result = store.call("nerya_native_role_list", {"remote_session_id": sid})
        assert result["ok"], result
        assert dependencies[-1].active_session_id == sid
        assert dependencies[-1].active_conversation_id == sid
        assert dependencies[-1].active_actor_id == "mcp"
        node = traces(store, sid)[-1]["nodes"][0]
        assert node["tool"] == "role_list"
        assert node["status"] == "succeeded"
    assert dependencies[-1] is not dependencies[-2]
    assert dependencies[-2].active_session_id == ids[0]


def test_recording_failure_prevents_execution(store, monkeypatch):
    called = []
    store.catalog = catalog(lambda **args: called.append(args) or {"ok": True})
    sid = session(store)
    monkeypatch.setattr(store, "persist", lambda trace: (_ for _ in ()).throw(OSError("disk unavailable")))
    result = store.call("echo", {"remote_session_id": sid, "value": 1})
    assert result["error"]["code"] == "trace_unavailable"
    assert not called


def test_final_recording_failure_does_not_invite_replaying_a_completed_tool(store, monkeypatch):
    sid = session(store)
    persist = store.persist
    def fail_final(trace):
        if trace.status != "running":
            raise OSError("disk unavailable")
        persist(trace)
    monkeypatch.setattr(store, "persist", fail_final)
    result = store.call("echo", {"remote_session_id": sid, "value": 1})
    assert result["ok"] is True
    assert result["nerya_trace"]["persisted"] is False
    assert active_call() is None


def test_interrupt_records_terminal_status_and_clears_context(store):
    def interrupted(**args):
        raise KeyboardInterrupt()
    store.catalog = catalog(interrupted)
    sid = session(store)
    with pytest.raises(KeyboardInterrupt):
        store.call("echo", {"remote_session_id": sid, "value": 1})
    assert traces(store, sid)[-1]["status"] == "interrupted"
    assert active_call() is None


def test_transport_metadata_never_changes_or_leaks_into_business_schema(store):
    before = store.catalog.describe("echo")["inputSchema"]
    descriptors = store.descriptors()
    exposed = next(row for row in descriptors if row["name"] == "echo")
    assert "remote_session_id" in exposed["inputSchema"]["properties"]
    assert "remote_session_id" not in before["properties"]
    assert store.catalog.describe("echo")["inputSchema"] == before
    sid = session(store)
    result = store.call("echo", {"remote_session_id": sid, "value": 9})
    assert result["value"] == 9
    assert "remote_session_id" not in result
