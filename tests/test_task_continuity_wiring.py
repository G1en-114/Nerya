from copy import deepcopy
import json
import pytest
from nerya.agent.kernel import AgentKernel
from nerya.agent.task_continuity import session_task_snapshot
from nerya.core.config import Config, DEFAULT_CONFIG
from nerya.core.paths import WorkspacePaths
from nerya.db.repositories import AgentSessionRepository
from nerya.db.sqlite import connect
from nerya.tools.native.task import TaskState, TodoItem


def fixture(tmp_path):
    cfg=Config(paths=WorkspacePaths(tmp_path),data=deepcopy(DEFAULT_CONFIG))
    con=connect(cfg.paths.db);repo=AgentSessionRepository(con)
    repo.upsert_session(session_id="scope-a")
    for i in range(12):
        repo.record_message(message_id=f"m{i}",session_id="scope-a",turn_id=f"t{i//2}",role="user" if i%2==0 else "assistant",content=f"canonical {i}")
    snapshot={"version":1,"updated_at":100,"source":{"session_id":"scope-a","turn_id":"t1","tool_use_id":"todo"},"todos":[{"id":"A","content":"Cancelled objective","activeForm":"A","status":"cancelled"},{"id":"B","content":"Current objective","activeForm":"B","status":"in_progress"}]}
    repo.record_tool_event(event_id="todo",session_id="scope-a",tool="native.todo_write",phase="tool_result",ok=True,payload={"task_state":snapshot})
    return cfg,con,repo,snapshot


def test_only_scoped_successful_todo_restored(tmp_path):
    cfg,con,repo,snapshot=fixture(tmp_path)
    other=TaskState();other.set_todos([TodoItem("leak","Other session")],source={"session_id":"scope-b"})
    assert session_task_snapshot(repo,"scope-a",live=other)==snapshot
    assert session_task_snapshot(repo,"scope-c",live=other) is None
    kernel=AgentKernel(config=cfg,skills=None)
    prior=kernel._load_prior_chat_messages(session_id="scope-a",max_pairs=2)
    assert "Current objective" in str(prior) and "cancelled" in str(prior)
    assert "Other session" not in str(prior)
    checkpoint=json.loads(repo.get_session("scope-a")["meta_json"])["context_compaction"]
    assert checkpoint["task_state"]==snapshot
    con.close()


@pytest.mark.parametrize("always_conflict",[False,True])
def test_compaction_conflict_rereads_once_then_explains_degradation(tmp_path,monkeypatch,always_conflict):
    cfg,con,repo,_=fixture(tmp_path)
    original=AgentSessionRepository.update_context_checkpoint;calls=[]
    def conflict(self,sid,checkpoint,*,expected_epoch):
        calls.append(expected_epoch)
        if len(calls)==1:
            self.update_message_content(session_id=sid,message_id="m0",content="NEW canonical instruction")
            return False
        return False if always_conflict else original(self,sid,checkpoint,expected_epoch=expected_epoch)
    monkeypatch.setattr(AgentSessionRepository,"update_context_checkpoint",conflict)
    result=AgentKernel(config=cfg,skills=None)._load_prior_chat_messages(session_id="scope-a",max_pairs=2)
    assert len(calls)==2
    if always_conflict:
        assert result[0]["kind"]=="context.degraded"
        assert "Current objective" in str(result)
    else:
        assert "NEW canonical instruction" in str(result)
        assert not any(m.get("kind")=="context.degraded" for m in result)
    con.close()
