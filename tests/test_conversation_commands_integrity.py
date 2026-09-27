from __future__ import annotations

from copy import deepcopy
import json
import threading
import time
import urllib.error
import urllib.request

import pytest

from nerya.agent.command_runtime import CommandRuntime
from nerya.agent.history_branch import fork_session
from nerya.agent.history_mutations import mutate_message, delete_session, HistoryMutationError
from nerya.agent.reference_preview import reference_preview
from nerya.agent.session_compaction import compact_session_history, SessionCompactionPolicy
from nerya.core.config import Config, DEFAULT_CONFIG
from nerya.core.paths import WorkspacePaths
from nerya.db.repositories import AgentSessionRepository
from nerya.db.sqlite import connect
from nerya.mcp.lazy import LazyMcpState, attach_lazy_state, pull_session_cache_into, push_state_into_session_cache
from nerya.tools.registry import ToolRegistry
from nerya.tools.types import ToolDescriptor, ToolResult, RiskLevel, PermissionScope

pytestmark = pytest.mark.smoke


def cfg(tmp_path):
    return Config(paths=WorkspacePaths(root=tmp_path),data=deepcopy(DEFAULT_CONFIG))


def request(cid="command-first"):
    return {"command_id":cid,"session_id":"session-history","request":{"payload":{"text":"Read the evidence"}},"_auth_actor_id":"operator"}


def seed(paths):
    con=connect(paths.db)
    repo=AgentSessionRepository(con)
    repo.upsert_session(session_id="session-history",source="user_chat",title="Evidence")
    for index,(role,text) in enumerate([("user","First request"),("assistant","Observed evidence"),("user","Edit this request"),("assistant","Original result")]):
        repo.record_message(message_id=f"m{index}",session_id="session-history",role=role,content=text,
            turn_id=f"t{index//2}",ts=100+index,
            meta={"turn":{"blocks":[{"kind":"approval_request","approval_id":"original-approval"}]}} if role=="assistant" else {})
    con.close()


def test_fork_copies_only_prior_context_and_is_idempotent(tmp_path):
    config=cfg(tmp_path); seed(config.paths)
    body={"session_id":"session-history","message_id":"m2","expected_content":"Edit this request","client_request_id":"fork-request-001"}
    first=fork_session(config.paths,body)
    assert not first["duplicate"] and first["copied_messages"]==2
    assert fork_session(config.paths,body)["duplicate"]
    con=connect(config.paths.db)
    try:
        rows=AgentSessionRepository(con).transcript(first["session_id"],limit=0)
        assert [r["content"] for r in rows]==["First request","Observed evidence"]
        assert all("original-approval" not in r["meta_json"] for r in rows)
        assert con.execute("SELECT count(*) FROM agent_commands WHERE session_id=?",(first["session_id"],)).fetchone()[0]==0
        assert len(AgentSessionRepository(con).transcript("session-history",limit=0))==4
    finally:
        con.close()


def test_fork_conflict_and_tombstone_are_not_silently_recreated(tmp_path):
    config=cfg(tmp_path); seed(config.paths)
    body={"session_id":"session-history","message_id":"m2","expected_content":"wrong","client_request_id":"fork-request-002"}
    with pytest.raises(HistoryMutationError,match="message_conflict"):
        fork_session(config.paths,body)
    delete_session(config.paths,{"session_id":"session-history"})
    with pytest.raises(HistoryMutationError,match="session_deleted"):
        fork_session(config.paths,{**body,"expected_content":"Edit this request"})


def test_edit_records_original_and_keeps_old_answer(tmp_path):
    config=cfg(tmp_path); seed(config.paths)
    mutate_message(config.paths,{"session_id":"session-history","message_id":"m2","expected_content":"Edit this request","content":"Revised wording"})
    con=connect(config.paths.db)
    try:
        assert con.execute("SELECT content FROM agent_message_revisions WHERE message_id='m2'").fetchone()[0]=="Edit this request"
        assert con.execute("SELECT content FROM agent_messages WHERE message_id='m3'").fetchone()[0]=="Original result"
    finally:
        con.close()


def test_queued_command_locks_history_and_edit_updates_context(tmp_path):
    config=cfg(tmp_path); seed(config.paths)
    runtime=CommandRuntime(config,lambda *_:{},epoch="history-test")
    received=runtime.submit(request(),start=False)["command"]
    with pytest.raises(HistoryMutationError,match="history_busy"):
        mutate_message(config.paths,{"session_id":"session-history","message_id":"m2","content":"unsafe while queued"})
    result=runtime.store.control("session-history","edit",cid=received["command_id"],revision=received["revision"],text="Edited queued request")
    assert result["commands"][0]["context"]["input_text"]=="Edited queued request"


def test_old_receipt_does_not_re_resolve_changed_model(tmp_path,monkeypatch):
    config=cfg(tmp_path)
    runtime=CommandRuntime(config,lambda *_:{},epoch="identity-test")
    runtime.submit(request(),start=False)
    from nerya.llm.gateway import LLMGateway
    def forbidden(*args,**kwargs):
        raise AssertionError("A duplicate must not re-resolve a model")
    monkeypatch.setattr(LLMGateway,"effective_model_metadata",forbidden)
    assert runtime.submit(request(),start=False)["duplicate"]


def test_failure_before_kernel_creates_durable_terminal_message(tmp_path):
    config=cfg(tmp_path)
    runtime=CommandRuntime(config,lambda *_:{},epoch="failure-test")
    receipt=runtime.submit(request(),start=False)["command"]
    row=runtime.store.claim("session-history","owner")
    runtime.store.finish(row["command_id"],"session-history","owner","failed",error={"code":"turn_failed"})
    con=connect(config.paths.db)
    try:
        row=con.execute("SELECT meta_json FROM agent_messages WHERE message_id=?",(receipt["turn_id"]+":assistant",)).fetchone()
        meta=json.loads(row[0])
        assert meta["source_command_id"]==receipt["command_id"]
        assert meta["execution_status"]=="failed"
        assert json.loads(meta["error"])["code"]=="turn_failed"
    finally:
        con.close()


def test_reference_preview_uses_saved_bytes_and_actual_hash(tmp_path):
    config=cfg(tmp_path)
    folder=config.paths.artifacts/"attachments"/"upload"
    folder.mkdir(parents=True)
    (folder/"snapshot.txt").write_text('{"content":"Original immutable text"}')
    preview=reference_preview(config.paths,"nerya://artifact/attachments/upload/snapshot.txt")
    assert preview["ok"] and "Original immutable" in preview["content"]
    assert len(preview["artifact_sha256"])==64


@pytest.mark.parametrize("uri",["file:///etc/passwd","nerya://artifact/attachments/../private","nerya://artifact/attachments//etc/passwd","nerya://artifact/attachments/a/../../secret","nerya://artifact/attachments/a\\b"])
def test_reference_preview_rejects_escape_paths(tmp_path,uri):
    assert not reference_preview(cfg(tmp_path).paths,uri)["ok"]


def test_reference_preview_rejects_symlink_and_binary(tmp_path):
    config=cfg(tmp_path); root=config.paths.artifacts/"attachments"; root.mkdir(parents=True)
    outside=tmp_path/"outside.txt"; outside.write_text("not a reference")
    (root/"linked.txt").symlink_to(outside)
    (root/"binary.bin").write_bytes(b"a\x00b")
    assert not reference_preview(config.paths,"nerya://artifact/attachments/linked.txt")["ok"]
    assert reference_preview(config.paths,"nerya://artifact/attachments/binary.bin")["_status"]==415


def test_compaction_keeps_late_constraints_and_typed_evidence():
    metadata={"source_command_id":"command-evidence","execution_status":"interrupted","turn":{"context_snapshot":{
        "strategy_id":"strategy-alpha","proposal_id":"proposal-beta","strategy_source":{"revision":"revision-pinned"},
        "attachments":[{"artifact_uri":"nerya://artifact/attachments/evidence.txt","reference":{"kind":"file","id":"notes.md","captured_at":"2026-09-25T00:00:00Z"}}]}}}
    rows=[{"message_id":"m0","role":"user","content":"Background\n"+"neutral text\n"*1200+"必须保留候选版本，禁止重复提交已经完成的操作。","ts":1},
          {"message_id":"m1","turn_id":"turn-evidence","role":"assistant","content":"Partial execution recorded.","ts":2,"meta_json":json.dumps(metadata)},
          {"message_id":"m2","role":"user","content":"Next request","ts":3},{"message_id":"m3","role":"assistant","content":"Next result","ts":4}]
    result=compact_session_history(rows,policy=SessionCompactionPolicy(keep_recent_pairs=1,trigger_pairs=1))
    text=result.messages[0]["content"]
    assert "禁止重复提交" in text
    assert "command-evidence" in text and "revision-pinned" in text and "proposal-beta" in text
    assert "2026-09-25T00:00:00Z" in text
    assert "not an exhaustive execution ledger" in text


def descriptor(field="old",risk=RiskLevel.READ):
    return ToolDescriptor(name="mcp__evidence__read",description="Read evidence",input_schema={"type":"object","properties":{field:{"type":"string"}}},
        handler=lambda call:ToolResult.from_text(tool_use_id=call.id,name=call.name,text="ok"),risk=risk,permission_scope=PermissionScope.NETWORK,
        namespace="mcp",tags=("mcp","evidence"),lazy=True)


def state_for(tool):
    registry=ToolRegistry(); registry.register(tool)
    state=LazyMcpState(); state.register_namespace("evidence",[tool.name],always_eager=False)
    attach_lazy_state(registry,state)
    return state


def test_mcp_cache_rejects_changed_schema_and_keeps_same_schema(tmp_path):
    original=state_for(descriptor())
    original.described_namespaces.add("evidence")
    original.describe_response_cache["evidence"]={"schema_signature":original.namespace_signature("evidence"),"tools":[]}
    push_state_into_session_cache(original,workspace_root=tmp_path,session_id="cache-session")
    assert pull_session_cache_into(state_for(descriptor()),workspace_root=tmp_path,session_id="cache-session")==1
    changed=state_for(descriptor("new"))
    assert pull_session_cache_into(changed,workspace_root=tmp_path,session_id="cache-session")==0
    assert not changed.described_namespaces


def test_commands_http_requires_internal_assertion(tmp_path,monkeypatch):
    from nerya.api.local_server import build_server
    import nerya.mcp.openai_tunnel as tunnel
    monkeypatch.setattr(tunnel,"restore",lambda *args,**kwargs:None)
    monkeypatch.setenv("NERYA_DASHBOARD_INTERNAL_TOKEN","test-internal-token")
    from nerya.llm.messages import MessagesResponse
    import nerya.agent.kernel as kernel_module
    provider_calls=[]
    class Gateway:
        def __init__(self,*args,**kwargs): pass
        def effective_model_metadata(self,*args,**kwargs): return "fixture","local-test",{}
        def call_messages(self,**kwargs):
            provider_calls.append(deepcopy(kwargs.get("messages",[])))
            return MessagesResponse(content=[{"type":"text","text":"Verified isolated response."}],stop_reason="end_turn",usage={"input_tokens":10,"output_tokens":4},provider="fixture",model="local-test")
    monkeypatch.setattr(kernel_module,"LLMGateway",Gateway)
    config=cfg(tmp_path)
    server=build_server(config,host="127.0.0.1",port=0,start_continuous=False)
    thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
    try:
        url=f"http://127.0.0.1:{server.server_address[1]}/agent/commands?session_id=test-session"
        with pytest.raises(urllib.error.HTTPError) as failure:
            urllib.request.urlopen(url,timeout=5)
        assert failure.value.code==403
        allowed=urllib.request.Request(url,headers={"x-nerya-dashboard-internal":"test-internal-token"})
        with urllib.request.urlopen(allowed,timeout=5) as response:
            assert json.load(response)["commands"]==[]
        base=f"http://127.0.0.1:{server.server_address[1]}"
        def http(path,body=None):
            req=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),
                headers={"x-nerya-dashboard-internal":"test-internal-token","Content-Type":"application/json"})
            with urllib.request.urlopen(req,timeout=10) as response:
                return json.load(response)
        original={"command_id":"http-command-original","session_id":"test-session","command_type":"send", "request":{"payload":{"text":"Say hello without using tools."}}}
        receipt=http("/agent/commands",original)
        assert receipt["ok"]
        def settled(cid):
            deadline=time.monotonic()+10
            while time.monotonic()<deadline:
                value=http(f"/agent/commands?session_id=test-session&command_id={cid}")["command"]
                if value["state"] not in ("running","queued","stopping"):
                    return value
                time.sleep(.02)
            raise AssertionError("Real Kernel command did not settle")
        first=settled(original["command_id"])
        assert first["state"]=="succeeded", first
        assert first["result"]["final_text"]=="Verified isolated response."
        assert http("/agent/commands",original)["duplicate"]
        assert len(provider_calls)==1
        continuation={"command_id":"http-command-resume","session_id":"test-session","command_type":"resume", "request":{"resume_turn_id":first["turn_id"],"continuation_feedback":"Add one sentence without repeating completed work.","payload":{}}}
        assert http("/agent/commands",continuation)["ok"]
        resumed=settled(continuation["command_id"])
        assert resumed["state"]=="succeeded", resumed
        assert resumed["turn_id"]==first["turn_id"]
        assert resumed["result"]["budget"]["checkpoint_continue"] is True
        assert len(provider_calls)==2
        assert sum(message.get("content")=="Say hello without using tools." for message in provider_calls[-1])==1
        events=http(f"/agent/commands/events?session_id=test-session&command_id={continuation['command_id']}")
        assert events["events"]
        transcript=http("/agent/session/transcript?session_id=test-session")
        assert len([row for row in transcript["messages"] if row["role"]=="user"])==1
        user=next(row for row in transcript["messages"] if row["role"]=="user")
        edited=http('/agent/session/message/edit',{'session_id':'test-session','message_id':user['message_id'],'expected_content':user['content'],'content':'Corrected history wording'})
        assert edited['ok'], edited
        assert http('/agent/commands?session_id=test-session')['checkpoint'] is None
        deleted=http('/agent/session/message/delete',{'session_id':'test-session','message_id':user['message_id'],'expected_content':'Corrected history wording'})
        assert deleted['ok'], deleted
        snapshot=http('/agent/commands?session_id=test-session')
        assert all(not item['show_user'] for item in snapshot['commands'])
        assert len(provider_calls)==2
    finally:
        server.shutdown(); server.server_close(); thread.join(3)
