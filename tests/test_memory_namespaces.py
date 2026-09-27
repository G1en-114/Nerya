"""Cross-domain isolation and correction invariants for built-in learning."""
import pytest

from nerya.core.config import Config
from nerya.core.paths import WorkspacePaths
from nerya.memory.runtime import MemoryRuntime, MemoryScopeError
from nerya.memory.store import MemoryConflictError

pytestmark = pytest.mark.smoke


def test_hierarchy_never_shares_sibling_or_child_memory(tmp_path):
    config = Config(paths=WorkspacePaths(tmp_path), data={})
    global_memory = MemoryRuntime(config)
    alpha = MemoryRuntime(config, strategy_id="alpha")
    a_exec = MemoryRuntime(config, strategy_id="alpha", workflow_id="execution", session_id="same")
    a_review = MemoryRuntime(config, strategy_id="alpha", workflow_id="evolution", session_id="same")
    beta = MemoryRuntime(config, strategy_id="beta", workflow_id="execution", session_id="same")
    for memory, value in [(global_memory, "shared rule"), (alpha, "alpha rule"), (a_exec, "execution rule"), (a_review, "review rule"), (beta, "beta rule")]:
        assert memory.remember(category="learning", content=value, key="rule").ok
    a_exec.remember(category="decision", content="private session", scope="session")
    def contents(memory):
        return {r.content for r in memory.recall("")}
    assert contents(global_memory) == {"shared rule"}
    assert contents(alpha) == {"shared rule", "alpha rule"}
    assert contents(a_exec) == {"shared rule", "alpha rule", "execution rule", "private session"}
    assert contents(a_review) == {"shared rule", "alpha rule", "review rule"}
    assert contents(beta) == {"shared rule", "beta rule"}
    assert MemoryRuntime(config, actor_id="other", strategy_id="alpha", workflow_id="execution", session_id="same").recall("") == []
    for memory, scope in [(alpha, "global"), (a_exec, "global"), (a_exec, "strategy")]:
        with pytest.raises(MemoryScopeError):
            memory.remember(category="learning", content="leak", scope=scope)
        with pytest.raises(MemoryScopeError):
            memory.forget(key="rule", scope=scope)
    assert a_exec.forget(key="rule") == 1
    assert "review rule" in contents(a_review)
    assert "beta rule" in contents(beta)


def test_corrections_are_idempotent_and_reject_stale_updates(tmp_path):
    memory = MemoryRuntime(Config(paths=WorkspacePaths(tmp_path), data={}), strategy_id="alpha")
    first = memory.remember(category="decision", content="leverage two", key="leverage")
    repeated = memory.remember(category="decision", content="leverage two", key="leverage")
    assert repeated.record.memory_id == first.record.memory_id
    corrected = memory.remember(category="decision", content="leverage one", key="leverage", expected_memory_id=first.record.memory_id)
    with pytest.raises(MemoryConflictError):
        memory.remember(category="decision", content="leverage ten", key="leverage", expected_memory_id=first.record.memory_id)
    assert [r.content for r in memory.recall("leverage")] == ["leverage one"]
    history = memory.store.projection_records(actor_id="default")
    assert next(r for r in history if r.memory_id == first.record.memory_id).superseded_by == corrected.record.memory_id
    assert memory.forget(key="leverage") == 2
    assert memory.recall("leverage") == []


def test_workflow_identity_is_derived_not_model_selected():
    from nerya.memory.scope import workflow_for_trigger
    assert workflow_for_trigger({"source": "chat", "workflow_id": "other", "payload": {"workflow_id": "other"}}) == ""
    assert workflow_for_trigger({"source": "strategy", "kind": "strategy.agent_task"}, strategy_id="alpha") == "execution"
    assert workflow_for_trigger({"source": "scheduled_session", "payload": {"schedule_id": "daily"}}) == "daily"


def test_session_resume_keeps_immutable_workflow_and_actor(tmp_path):
    from nerya.memory.scope import bind_session_context
    config = Config(paths=WorkspacePaths(tmp_path), data={})
    args = dict(session_id="session", actor_id="alice", strategy_id="alpha")
    assert bind_session_context(config, **args, workflow_id="execution") == "execution"
    assert bind_session_context(config, **args, workflow_id="") == "execution"
    for overrides in ({"workflow_id": "evolution"}, {"actor_id": "bob"}, {"strategy_id": "beta"}):
        with pytest.raises(MemoryScopeError):
            bind_session_context(config, **{**args, "workflow_id": "execution", **overrides})


def test_upgrade_preserves_lineage_import_refs_and_session_ownership(tmp_path):
    import sqlite3
    from nerya.db.migrations import MIGRATIONS, apply_migrations
    db = tmp_path / "old.db"
    con = sqlite3.connect(db, isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("CREATE TABLE schema_version(version INTEGER PRIMARY KEY, name TEXT, applied_at REAL)")
    for migration in MIGRATIONS[:10]:
        migration.up(con)
        con.execute("INSERT INTO schema_version VALUES (?, ?, 0)", (migration.version, migration.name))
    for identity, status in [("old", "superseded"), ("new", "active")]:
        con.execute("""INSERT INTO memory_records
            (memory_id, actor_id, scope, scope_id, strategy_id, session_id, category, stable_key, content, status, created_at, updated_at)
            VALUES (?, 'alice', 'session', 'session', 'alpha', 'session', 'learning', 'fact', ?, ?, 1, 1)""",
            (identity, identity + " content", status))
    con.execute("UPDATE memory_records SET superseded_by='new' WHERE memory_id='old'")
    con.execute("INSERT INTO memory_import_sources VALUES ('alice', 'legacy', 'ref', 'old', 1)")
    assert apply_migrations(con) == [migration.version for migration in MIGRATIONS[10:]]
    assert apply_migrations(con) == []
    assert con.execute("PRAGMA foreign_key_check").fetchall() == []
    assert con.execute("SELECT superseded_by FROM memory_records WHERE memory_id='old'").fetchone()[0] == "new"
    assert con.execute("SELECT memory_id FROM memory_import_sources").fetchone()[0] == "old"
    from nerya.memory.store import MemoryStore
    store = MemoryStore(db)
    assert len(store.recall(actor_id="alice", query="content", strategy_id="alpha", session_id="session").records) == 1
    assert store.recall(actor_id="alice", query="content", strategy_id="beta", session_id="session").records == ()
    assert con.execute("SELECT scope_id FROM memory_records LIMIT 1").fetchone()[0] == '["alpha","","session"]'
    con.close()


def test_review_updates_memory_only_with_current_owned_evidence(tmp_path):
    from nerya.core import jsonl
    from nerya.evolution.reflection_engine import run_reflection
    from nerya.memory.learning import remember_review
    config = Config(paths=WorkspacePaths(tmp_path), data={})
    config.paths.strategy("alpha").mkdir(parents=True)
    config.paths.strategy("beta").mkdir(parents=True)
    jsonl.append(config.paths.journal("errors"), {"strategy_id": "alpha", "error": "bounded retry required"})
    jsonl.append(config.paths.journal("errors"), {"strategy_id": "beta", "error": "private beta incident"})
    packet = run_reflection(config.paths, ["alpha"], config=config)
    blob = (tmp_path / packet["snapshot_ref"].removeprefix("file:")).read_text()
    assert "private beta incident" not in blob
    memory = MemoryRuntime(config, strategy_id="alpha", workflow_id="evolution")
    review = {"key": "retry.policy", "conclusion": "The observed timeout requires bounded retries before requesting fresh execution evidence.", "evidence_sha256": packet["evidence_sha256"]}
    assert remember_review(memory, packet, review)["ok"]
    assert remember_review(memory, packet, review)["ok"]
    assert len(memory.recall("timeout")) == 1
    assert MemoryRuntime(config, strategy_id="beta", workflow_id="evolution").recall("timeout") == []
    assert not remember_review(MemoryRuntime(config), packet, review)["ok"]
    assert not remember_review(memory, packet, {**review, "evidence_sha256": "stale"})["ok"]


def test_workflow_api_and_retired_backends(tmp_path):
    from types import SimpleNamespace
    from nerya.api.routes_memory import routes
    config = Config(paths=WorkspacePaths(tmp_path), data={})
    config.paths.strategy("alpha").mkdir(parents=True)
    client = SimpleNamespace(config=config, actor_id="alice")
    handlers = {(method, path): fn for method, path, fn in routes()}
    domain = {"scope": "workflow", "strategy_id": "alpha", "workflow_id": "execution"}
    assert domain in handlers["GET", "/memory/domains"](client, {})["domains"]
    saved = handlers["POST", "/memory/capture"](client, {**domain, "key": "fact", "category": "learning", "content": "Scoped observed lesson."})
    assert saved["ok"]
    assert len(handlers["POST", "/memory/records"](client, domain)["records"]) == 1
    assert handlers["POST", "/memory/records"](client, {**domain, "workflow_id": "evolution"})["records"] == []
    assert handlers["POST", "/memory/records"](SimpleNamespace(config=config, actor_id="bob"), domain)["records"] == []
    stale = handlers["POST", "/memory/capture"](client, {**domain, "key": "fact", "category": "learning", "content": "New lesson.", "expected_memory_id": "stale"})
    assert stale["skip_reason"] == "update_conflict"
    assert handlers["POST", "/memory/external/install/run"](client, {})["error"] == "builtin_memory_only"


def test_forget_preserves_sibling_audit_with_same_key_and_content(tmp_path):
    config = Config(paths=WorkspacePaths(tmp_path), data={})
    alpha = MemoryRuntime(config, strategy_id="alpha", workflow_id="execution")
    beta = MemoryRuntime(config, strategy_id="beta", workflow_id="execution")
    for memory in (alpha, beta):
        assert memory.remember(category="learning", key="same", content="Identical observed lesson").ok
    assert alpha.forget(key="same") == 1
    writes = [event for event in alpha.activity.tail() if event["kind"] == "write_ok"]
    assert len(writes) == 1
    assert writes[0]["extra"]["strategy_id"] == "beta"


def test_request_identity_is_not_retained_on_cached_client(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from nerya.api import local_server
    config = Config(paths=WorkspacePaths(tmp_path), data={})
    shared = SimpleNamespace(config=config)
    monkeypatch.setattr(local_server, "_client_for_current_thread", lambda _config: shared)
    alice = local_server._memory_request_client(config, SimpleNamespace(actor="alice"), "/memory/records")
    bob = local_server._memory_request_client(config, SimpleNamespace(actor="bob"), "/memory/records")
    assert alice.actor_id == "alice" and bob.actor_id == "bob"
    assert not hasattr(shared, "actor_id")


def test_notebook_api_keeps_authenticated_actors_separate(tmp_path):
    from types import SimpleNamespace
    from nerya.api.routes_memory import routes
    config = Config(paths=WorkspacePaths(tmp_path), data={})
    handlers = {(method, path): fn for method, path, fn in routes()}
    alice = SimpleNamespace(config=config, actor_id="alice")
    bob = SimpleNamespace(config=config, actor_id="bob")
    revision = handlers["GET", "/memory/notebook"](alice, {})["operator"]["revision"]
    result = handlers["POST", "/memory/notebook"](alice, {"target": "operator", "action": "add", "content": "Alice prefers concise Chinese answers.", "expected_revision": revision})
    assert result["ok"]
    assert handlers["GET", "/memory/notebook"](alice, {})["operator"]["entries"]
    assert handlers["GET", "/memory/notebook"](bob, {})["operator"]["entries"] == []


def test_native_tools_receive_workflow_binding_and_refuse_global_write(tmp_path):
    from nerya.tools.native.bootstrap import NativeToolDeps, _wrap_memory_remember, _wrap_memory_recall
    from nerya.tools.types import ToolCall
    config = Config(paths=WorkspacePaths(tmp_path), data={})
    deps = NativeToolDeps(workspace_root=tmp_path, paths=config.paths, config=config,
                          active_strategy_id="alpha", active_workflow_id="execution",
                          file_state=None, task_state=None, skill_index=None)
    write = _wrap_memory_remember(deps)
    result = write(ToolCall(name="memory_remember", arguments={"note": "After timeout, record the response before retrying the same action.", "key": "retry"}))
    assert result.content[0].data["scope"] == "workflow"
    assert write(ToolCall(name="memory_remember", arguments={"note": "A private lesson must not become global.", "scope": "global"})).is_error
    deps.active_strategy_id = "beta"
    assert _wrap_memory_recall(deps)(ToolCall(name="memory_recall", arguments={})).content[0].data["count"] == 0
