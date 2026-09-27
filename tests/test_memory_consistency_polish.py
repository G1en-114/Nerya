"""R34–36: real route/runtime operations on isolated memory, with no network."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from types import SimpleNamespace

import pytest

from nerya.api.routes_memory import routes
from nerya.core.config import Config
from nerya.core.paths import WorkspacePaths
from nerya.db.sqlite import connect
from nerya.memory.notebook import ENTRY_DELIMITER, load_notebook
from nerya.memory.runtime import MemoryRuntime
from nerya.memory.scope import bind_session_context
from nerya.memory.store import MemoryConflictError

pytestmark = pytest.mark.smoke


@pytest.fixture
def env(tmp_path):
    config = Config(paths=WorkspacePaths(tmp_path), data={})
    client = SimpleNamespace(config=config, actor_id="alice")
    handlers = {(method, path): handler for method, path, handler in routes()}
    def api(method, path, body=None, actor=None):
        return handlers[(method, path)](SimpleNamespace(config=config, actor_id=actor) if actor else client, body or {})
    return config, api


def test_notebook_ui_runtime_versions_and_removal_share_owner(env):
    config, api = env
    memory = MemoryRuntime(config, actor_id="alice")
    first = memory.remember(category="notebook_operator", content="Prefer weekly summaries.", key="report").record
    state = api("GET", "/memory/notebook")["operator"]
    corrected = api("POST", "/memory/notebook", dict(target="operator", action="replace",
        old_text=first.content, content="Prefer daily summaries.", expected_revision=state["revision"]))
    assert corrected["ok"]
    row = corrected["records"][0]
    assert row["memory_id"] != first.memory_id and row["stable_key"] == "report"
    with pytest.raises(MemoryConflictError):
        memory.remember(category="notebook_operator", content="Stale report", key="report", expected_memory_id=first.memory_id)
    stale = api("POST", "/memory/notebook", dict(target="operator", action="remove", old_text=first.content,
                                                expected_revision=state["revision"]))
    assert stale == {"ok": False, "error": "update_conflict"}
    assert memory.forget(key="report", scope="global") == 2
    assert api("GET", "/memory/notebook")["operator"]["entries"] == []


def test_missing_revision_and_actor_forgery_do_not_write(env):
    config, api = env
    assert api("POST", "/memory/notebook", {"target": "agent", "action": "add", "content": "No version"})["error"] == "update_conflict"
    rev = api("GET", "/memory/notebook")["agent"]["revision"]
    assert api("POST", "/memory/notebook", dict(target="agent", action="add", content="Alice note", actor_id="bob", expected_revision=rev))["ok"]
    assert api("GET", "/memory/notebook", actor="bob")["agent"]["entries"] == []


def test_competing_runtime_writers_preserve_the_winning_file_and_record(env):
    config, _ = env
    seed = MemoryRuntime(config, actor_id="alice")
    first = seed.remember(category="notebook_agent", key="shared", content="Initial fact").record
    workers = [MemoryRuntime(config, actor_id="alice") for _ in range(2)]
    def update(index):
        try:
            return workers[index].remember(category="notebook_agent", key="shared", content=f"Writer {index} fact", expected_memory_id=first.memory_id).record
        except MemoryConflictError:
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        result = list(pool.map(update, range(2)))
    winners = [r for r in result if r]
    assert len(winners) == 1
    state = MemoryRuntime(config, actor_id="alice").notebook_state()["agent"]
    assert state["entries"] == [winners[0].content]
    assert state["records"][0]["memory_id"] == winners[0].memory_id


def test_file_only_and_historical_keyless_entries_can_be_curated(env):
    config, api = env
    nb = load_notebook(config, actor_id="alice")
    assert nb.add("agent", "Legacy file entry").ok
    memory = MemoryRuntime(config, actor_id="alice")
    assert memory.store.projection_records(actor_id="alice") == []  # no read migration
    state = api("GET", "/memory/notebook")["agent"]
    assert api("POST", "/memory/notebook", dict(target="agent", action="replace", old_text="Legacy file entry",
        content="Updated legacy entry", expected_revision=state["revision"]))["ok"]
    with connect(config.paths.db) as con:
        con.execute("UPDATE memory_records SET stable_key='' WHERE status='active' AND actor_id='alice'")
    state = api("GET", "/memory/notebook")["agent"]
    assert api("POST", "/memory/notebook", dict(target="agent", action="remove", old_text="Updated legacy entry",
                                                expected_revision=state["revision"]))["ok"]
    assert api("GET", "/memory/notebook")["agent"]["entries"] == []


def test_external_file_mismatch_and_unreadable_file_are_explicit(env, monkeypatch):
    config, api = env
    memory = MemoryRuntime(config, actor_id="alice")
    memory.remember(category="notebook_agent", content="Canonical content", key="fact")
    nb = load_notebook(config, actor_id="alice")
    nb.replace("agent", "Canonical content", "External edit")
    state = api("GET", "/memory/notebook")["agent"]
    assert state["sync_error"]
    assert api("POST", "/memory/notebook", dict(target="agent", action="remove", old_text="External edit", expected_revision=state["revision"]))["error"] == "notebook_sync_conflict"
    context = MemoryRuntime(config, actor_id="alice").context("")
    assert not context.stable and {r["reason"] for r in context.metadata["omitted"]} == {"notebook_sync_conflict"}
    from nerya.memory.notebook import MemoryNotebook
    def denied(_path):
        raise PermissionError("fixture")
    monkeypatch.setattr(MemoryNotebook, "_read_file", staticmethod(denied))
    broken = MemoryRuntime(config, actor_id="alice")
    assert broken.notebook_state()["error"] == "notebook_unreadable"
    assert broken.context("").metadata["omitted"][0]["reason"] == "notebook_unreadable"
    record = broken.remember(category="learning", content="Independent record", key="regular").record
    assert broken.forget(memory_id=record.memory_id) == 1


def test_notebook_budget_packs_whole_small_entries_and_reports_versions(env):
    config, _ = env
    seed = MemoryRuntime(config, actor_id="alice")
    large = seed.remember(category="notebook_agent", content="Long note " * 120, key="large").record
    short = seed.remember(category="notebook_agent", content="Small complete fact.", key="short", source="fixture", source_turn_id="turn-origin").record
    memory = MemoryRuntime(config, actor_id="alice")
    context = memory.context("", max_chars=400)
    assert "Small complete fact." in context.stable and "Long note" not in context.stable
    assert context.metadata["used_chars"] == len(context.stable) + len(context.dynamic) <= 400
    included = context.metadata["included"]
    assert included[0]["memory_id"] == included[0]["version"] == short.memory_id
    assert included[0]["source_ref"] == "fixture" and included[0]["source_turn_id"] == "turn-origin"
    assert context.metadata["omitted"][0]["memory_id"] == large.memory_id
    assert context.metadata["omitted"][0]["reason"] == "budget"
    assert not memory.context("", max_chars=0).stable
    assert len(memory.context("", max_chars=0).metadata["omitted"]) == 2
    assert not seed.remember(category="notebook_agent", content="part one" + ENTRY_DELIMITER + "part two").ok


def test_trusted_session_management_rejects_actor_ancestor_and_deleted_scope(env):
    config, api = env
    bind_session_context(config, session_id="s1", actor_id="alice", strategy_id="alpha", workflow_id="execution")
    domain = dict(scope="session", session_id="s1", strategy_id="alpha", workflow_id="execution")
    assert domain in api("GET", "/memory/domains")["domains"]
    saved = api("POST", "/memory/capture", {**domain, "category": "learning", "content": "Session evidence", "key": "fact", "expected_memory_id": ""})
    assert saved["ok"]
    for override in ({"strategy_id": "beta"}, {"workflow_id": "evolution"}, {"session_id": "guessed"}):
        assert not api("POST", "/memory/records", {**domain, **override})["ok"]
        assert not api("POST", "/memory/forget", {**domain, **override, "key": "fact"})["ok"]
    assert not api("POST", "/memory/records", domain, actor="bob")["ok"]
    assert not api("POST", "/memory/capture", {**domain, "scope": "global", "category": "learning", "content": "leak"})["ok"]
    records = api("POST", "/memory/records", domain)["records"]
    assert [r["memory_id"] for r in records] == [saved["memory_id"]]
    assert api("POST", "/memory/forget", {**domain, "key": "fact"})["forgotten"] == 1
    with connect(config.paths.db) as con:
        con.execute("INSERT INTO agent_deleted_sessions VALUES ('s1', 1)")
    assert not api("POST", "/memory/records", domain)["ok"]


def test_policy_separates_use_auto_save_and_management_with_native_recall(env):
    config, api = env
    config.data["agent"] = {"native": {"memory_write_on_turn": True}}
    memory = MemoryRuntime(config, actor_id="alice", session_id="s1")
    memory.remember(category="learning", content="Existing fact", scope="global")
    assert api("POST", "/memory/policy", {"use_enabled": False, "auto_save_enabled": False})["ok"]
    assert not memory.use_enabled and not memory.auto_save_enabled
    assert memory.recall("") == [] and memory.context("").metadata["reason"] == "use_disabled"
    assert memory.remember(category="learning", content="Manual fact", scope="global").ok
    assert memory.remember(category="session_summary", content="Automatic", automatic=True).skip_reason == "auto_save_disabled"
    assert memory.end_session(summary="Disabled automatic summary").skip_reason == "auto_save_disabled"
    assert len(api("POST", "/memory/records", {"scope": "global"})["records"]) == 2
    from nerya.tools.native.memory import memory_recall_handler
    from nerya.tools.types import ToolCall
    result = memory_recall_handler(ToolCall(id="call", name="memory_recall", arguments={"query": "fact", "management": True}), runtime=memory)
    assert "Existing fact" not in str(result)
    assert api("POST", "/memory/policy", {"use_enabled": "false"})["error"] == "invalid_memory_policy"
    assert api("POST", "/memory/policy", {"use_enabled": False, "auto_save_enabled": True})["ok"]
    assert memory.end_session(summary="Auto save while use is disabled").ok


def test_zero_hit_recent_browse_stays_in_scope_and_is_chronological(env):
    config, api = env
    config.paths.strategy("alpha").mkdir(parents=True)
    alpha = MemoryRuntime(config, actor_id="alice", strategy_id="alpha")
    alpha.remember(category="learning", content="Older high importance", importance=1)
    newest = alpha.remember(category="learning", content="Recent low importance", importance=0).record
    MemoryRuntime(config, actor_id="bob", strategy_id="alpha").remember(category="learning", content="Bob secret")
    response = api("POST", "/memory/records", dict(scope="strategy", strategy_id="alpha", query="unmatchedxyz"))
    assert response["records"] == []
    assert response["recent_records"][0]["memory_id"] == newest.memory_id
    assert len(response["recent_records"]) == 2


def test_actual_usage_not_preview_and_source_link_requires_owned_turn(env):
    config, api = env
    bind_session_context(config, session_id="s1", actor_id="alice", strategy_id="", workflow_id="")
    bind_session_context(config, session_id="s2", actor_id="bob", strategy_id="", workflow_id="")
    with connect(config.paths.db) as con:
        con.execute("INSERT INTO agent_messages(message_id,session_id,turn_id,role,content,ts) VALUES ('m1','s1','t1','user','fixture',1)")
        con.execute("INSERT INTO agent_messages(message_id,session_id,turn_id,role,content,ts) VALUES ('m2','s2','t2','user','fixture',1)")
    memory = MemoryRuntime(config, actor_id="alice", session_id="s1")
    memory.remember(category="learning", content="Owned source fact", source_turn_id="t1")
    memory.remember(category="learning", content="Foreign reference fact", source_turn_id="t2")
    ctx = memory.context("fact")
    assert api("POST", "/memory/usage", {"session_id": "s1"})["events"] == []
    memory.record_injection(ctx, turn_id="t3")
    usage = api("POST", "/memory/usage", {"session_id": "s1"})["events"][0]["extra"]
    assert usage["turn_id"] == "t3"
    owned = next(r for r in usage["included"] if r["source_turn_id"] == "t1")
    foreign = next(r for r in usage["included"] if r["source_turn_id"] == "t2")
    assert owned["source_session_id"] == "s1" and "source_session_id" not in foreign
    assert not api("POST", "/memory/usage", {"session_id": "s1"}, actor="bob")["ok"]


def test_notebook_database_failure_restores_file_and_does_not_delete_legacy(env, monkeypatch):
    config, _ = env
    memory = MemoryRuntime(config, actor_id="alice")
    first = memory.remember(category="notebook_agent", key="fact", content="Before correction").record
    def fail(**_kwargs):
        raise OSError("fixture database failure")
    monkeypatch.setattr(memory.store, "remember", fail)
    with pytest.raises(OSError):
        memory.remember(category="notebook_agent", key="fact", content="After correction", expected_memory_id=first.memory_id)
    assert load_notebook(config, actor_id="alice").entries("agent") == ("Before correction",)
    legacy = load_notebook(config, actor_id="alice")
    legacy.add("agent", "Legacy no record")
    with pytest.raises(OSError):
        memory.remember(category="notebook_agent", content="Legacy no record")
    assert load_notebook(config, actor_id="alice").entries("agent") == ("Before correction", "Legacy no record")


def test_runtime_and_api_revision_conflict_after_identical_content_aba(env):
    config, api = env
    memory = MemoryRuntime(config, actor_id="alice")
    first = memory.remember(category="notebook_operator", key="fact", content="Value A").record
    state = api("GET", "/memory/notebook")["operator"]
    second = memory.remember(category="notebook_operator", key="fact", content="Value B", expected_memory_id=first.memory_id).record
    memory.remember(category="notebook_operator", key="fact", content="Value A", expected_memory_id=second.memory_id)
    rejected = api("POST", "/memory/notebook", dict(target="operator", action="remove", old_text="Value A", expected_revision=state["revision"]))
    assert rejected["error"] == "update_conflict"


def test_builtin_provider_cannot_bypass_use_or_version_policy(env):
    from nerya.memory.builtin_provider import BuiltinMemoryProvider
    config, api = env
    provider = BuiltinMemoryProvider(config)
    provider.initialize()
    assert provider.handle_tool_call("memory", dict(action="add", target="agent", content="Compatibility fact")).ok
    state = provider.handle_tool_call("memory", dict(action="read", target="agent"))
    assert state.extra["revision"]
    assert not provider.handle_tool_call("memory", dict(action="replace", target="agent", old_text="Compatibility fact", content="Changed")).ok
    assert provider.handle_tool_call("memory", dict(action="replace", target="agent", old_text="Compatibility fact", content="Changed", expected_revision=state.extra["revision"])).ok
    config.data["memory"] = {"use_enabled": False}
    assert provider.system_prompt_block() == ""
    assert provider.prefetch("Changed") == []
    assert not provider.handle_tool_call("memory", dict(action="read", target="agent")).ok


@pytest.mark.parametrize("enabled", [False, True])
def test_kernel_nudge_and_turn_save_follow_explicit_auto_policy(env, monkeypatch, enabled):
    from nerya.agent import kernel as kernel_module
    from nerya.memory.activity import MemoryActivityLog
    config, _ = env
    config.data.update({"memory": {"auto_save_enabled": enabled, "use_enabled": False},
                        "agent": {"native": {"memory_write_on_turn": not enabled}}})
    kernel = kernel_module.AgentKernel.__new__(kernel_module.AgentKernel)
    kernel.config = config
    kernel._deps = SimpleNamespace(active_actor_id="alice", active_workflow_id="")
    notifications = []
    kernel._evolution_hooks = SimpleNamespace(on_memory_write=lambda **kw: notifications.append(kw))
    nudge = SimpleNamespace(triggered=True, message="Verify the completed work against recorded evidence.", asdict=lambda: {"triggered": True})
    monkeypatch.setattr(kernel_module, "compute_verifier_nudge", lambda **kw: nudge)
    kernel._fire_verifier_nudge(turn_id="nudge-turn", strategy_id=None, session_id="s1", blocks=[], todos_before=[], todos_after=[])
    kernel._after_turn_memory(turn_id="summary-turn", strategy_id=None, session_id="s1",
        result=SimpleNamespace(final_text="Completed fixture work.", actions=[], stopped_reason="end_turn"))
    rows = MemoryRuntime(config, actor_id="alice", session_id="s1").recall("", management=True)
    assert len(rows) == (2 if enabled else 0)
    assert len(notifications) == int(enabled)
    assert config.paths.journal("agent").exists()  # nudge diagnostics remain independent of saving


def test_policy_write_failure_keeps_in_memory_policy(env, monkeypatch):
    from nerya.core import yaml_io
    config, api = env
    def denied(*args):
        raise PermissionError("fixture denied")
    monkeypatch.setattr(yaml_io, "dump", denied)
    assert api("POST", "/memory/policy", {"use_enabled": False})["error"] == "memory_policy_save_failed"
    assert MemoryRuntime(config).use_enabled
    assert not config.paths.config.exists()
