"""Regression contracts for script/Agent canvases and strategy conversations."""
from copy import deepcopy
from types import SimpleNamespace

import pytest

from nerya.agent.session import SessionStore
from nerya.agent.session_profile import render_strategy_context_block
from nerya.core.config import Config, DEFAULT_CONFIG
from nerya.core.paths import WorkspacePaths
from nerya.strategies.input_context import StrategyInputContext, collect_task_context
from nerya.strategies.agent_task import StrategyAgentTask
from nerya.strategies.package import StrategyAgentSessionConfig
from nerya.strategies.workflow_graph import build_workflows
from nerya.strategies.workflow_service import source_files, propose_workflow
from nerya.strategies.workflow_templates import create_workflow_template
from nerya.triggers.schedule import ScheduleEntry, save_schedules, load_schedules
from nerya.triggers.scheduled_session import ScheduledSessionRunner


def template(paths, kind="script_agent"):
    return create_workflow_template(paths, {"template": kind, "strategy_id": "context_demo", "accounts": ["paper"], "markets": ["mock:BTC/USDT"]})


def test_scripts_compose_and_dispatch_actual_outputs():
    inputs = StrategyInputContext([], None, None, (), "run1")
    inputs.publish("raw", {"score": 0, "approved": False, "rows": []})
    copied = inputs.read("raw")
    copied["rows"].append("changed")
    assert inputs.read("raw")["rows"] == []
    inputs.publish("signal", inputs.read("raw")["score"])
    task = StrategyAgentTask.dispatch(prompt="Review", outputs=["signal"])
    ctx = SimpleNamespace(inputs=inputs, trigger=SimpleNamespace(payload={}))
    collect_task_context(task, ctx, {"include_trigger": False})
    assert task.context["published"]["signal"]["value"] == 0
    with pytest.raises(KeyError):
        StrategyInputContext([], None, None, (), "run2").read("raw")


def test_templates_have_script_data_and_shared_context(tmp_path):
    out = template(WorkspacePaths(tmp_path))
    assert out["ok"], out
    assert "data_sources" not in out["workflow"]["manifest"]
    assert out["workflow"]["manifest"]["agent_session"]["policy"] == "per_strategy"
    assert out["workflow"]["manifest"]["agent_session"]["include_prior_messages"] is True
    assert StrategyAgentSessionConfig.from_dict(None, where="test").policy == "per_strategy"
    assert StrategyAgentSessionConfig.from_dict({"policy": "per_signal"}, where="test").policy == "per_signal"


def test_candidate_context_is_real_and_bound_to_strategy(tmp_path):
    paths = WorkspacePaths(tmp_path)
    out = template(paths)
    rendered = render_strategy_context_block(paths, "context_demo", proposal_id=out["proposal_id"], max_chars=20000)
    assert out["proposal_id"] in rendered and "main.py" in rendered
    assert "ctx.inputs.publish" in rendered
    wrong = render_strategy_context_block(paths, "different", proposal_id=out["proposal_id"])
    assert "unavailable" in wrong and "Do not substitute" in wrong


def test_workflow_defaults_reuse_and_fresh_choice_roundtrips(tmp_path):
    paths = WorkspacePaths(tmp_path)
    shared = ScheduleEntry(id="shared", kind="agent.task", every_seconds=60, session_kind="agent")
    fresh = ScheduleEntry(id="fresh", kind="agent.task", every_seconds=60, session_kind="agent", session_mode="ephemeral")
    save_schedules(paths, [shared, fresh])
    a, b = load_schedules(paths)
    assert a.session_mode == "reuse" and b.session_mode == "ephemeral"
    assert ScheduledSessionRunner._session_ids_for(a, 1) == ScheduledSessionRunner._session_ids_for(a, 2)
    assert ScheduledSessionRunner._session_ids_for(b, 1) != ScheduledSessionRunner._session_ids_for(b, 2)


def test_script_read_publish_edges_reflect_source(tmp_path):
    out = template(WorkspacePaths(tmp_path))
    files, _ = source_files(WorkspacePaths(tmp_path), "context_demo", out["proposal_id"])
    files["producer.py"] = 'def run(ctx):\n    ctx.inputs.publish("score", 0)\n'
    files["consumer.py"] = 'def run(ctx):\n    return ctx.inputs.read("score")\n'
    graph = build_workflows(files)["strategy"]
    assert any(e["source"] == "script:producer.py" and e["target"] == "script:consumer.py" and e["relation"] == "script_output" for e in graph["edges"])


def test_inherited_role_edit_creates_local_prompt_only(tmp_path):
    paths = WorkspacePaths(tmp_path)
    out = template(paths)
    files, _ = source_files(paths, "context_demo", out["proposal_id"])
    role = "market_analyst"
    files.pop(f"subagents/{role}.agent.md")
    package = paths.strategy("context_demo")
    for name, content in files.items():
        target = package / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    paths.subagents.mkdir(parents=True, exist_ok=True)
    inherited = paths.subagents / f"{role}.agent.md"
    inherited.write_text("Original shared instructions")
    from nerya.strategies.workflow_service import view_workflow
    view = view_workflow(paths, "context_demo")
    node = next(n for n in view["strategy"]["nodes"] if n["id"] == f"agent:role/{role}")
    assert node["editable"] and node["content"] == "Original shared instructions"
    saved = propose_workflow(paths, {"strategy_id": "context_demo", "base_revision": view["revision"], "changes": [{"node_id": node["id"], "content": "Strategy-specific instructions"}]})
    assert saved["ok"], saved
    assert inherited.read_text() == "Original shared instructions"
    assert not (package / f"subagents/{role}.agent.md").exists()


def test_role_context_reuses_history_but_receives_new_input(tmp_path):
    from test_subagent_native_runtime import Gateway, final, runtime, spec
    gateway = Gateway(final("first evidence"), final("second evidence"), final("fresh evidence"))
    rt, sp = runtime(tmp_path, gateway), spec(tmp_path)
    first = rt.run(sp, trigger_event_id="a", payload={"task": "FIRST_INPUT"}, strategy_id="s", session_id="strategy_session")
    second = rt.run(sp, trigger_event_id="b", payload={"task": "SECOND_INPUT"}, strategy_id="s", session_id="strategy_session")
    assert first["agent_id"] == second["agent_id"]
    assert "FIRST_INPUT" in str(gateway.calls[1]) and "SECOND_INPUT" in str(gateway.calls[1])
    rt.run(sp, trigger_event_id="c", payload={"task": "FRESH_INPUT"}, strategy_id="s", session_id="new_signal_session")
    assert "FIRST_INPUT" not in str(gateway.calls[2])



def test_chat_candidate_binding_persists_and_rejects_cross_strategy(tmp_path, monkeypatch):
    from nerya.agent.kernel import AgentKernel, AgentTurnResult
    from nerya.api import routes_agent
    paths = WorkspacePaths(tmp_path)
    out = template(paths)
    captured = []
    def fake_turn(self, **kwargs):
        state = SessionStore(paths.root).load(kwargs["session_id"])
        captured.append(state.meta["strategy_proposal_id"])
        return AgentTurnResult(trigger_event_id="event", strategy_id=kwargs.get("strategy_id"), session_id=kwargs["session_id"], turn_id="turn", decision={}, actions=[], tool_trace=[], stopped_reason="end_turn", final_text="candidate updated")
    monkeypatch.setattr(AgentKernel, "run_turn", fake_turn)
    client = SimpleNamespace(config=Config(paths=paths, data=deepcopy(DEFAULT_CONFIG)), skills=None)
    handler = next(h for method, route, h in routes_agent.routes() if method == "POST" and route == "/agent/run_turn")
    body = {"session_id": "edit_strategy", "strategy_id": "context_demo", "strategy_proposal_id": out["proposal_id"], "trigger": {"source": "user_chat", "payload": {"text": "edit this candidate"}}}
    handler(client, body)
    handler(client, {k: v for k, v in body.items() if k != "strategy_proposal_id"})
    assert captured == [out["proposal_id"], out["proposal_id"]]
    rejected = handler(client, {**body, "strategy_id": "different"})
    assert rejected["_status"] == 400 and len(captured) == 2


def test_legacy_prompt_nodes_save_reviewable_delta(tmp_path):
    from nerya.core import yaml_io
    from nerya.strategies.workflow_service import view_workflow
    from nerya.evolution.patch_proposal import list_proposals
    paths = WorkspacePaths(tmp_path)
    root = paths.strategy("legacy")
    yaml_io.dump(root / "strategy.yml", {"id": "legacy", "title": "Old strategy", "driver": "prompt", "account_id": "paper"})
    (root / "prompts").mkdir()
    (root / "prompts/analyze.md").write_text("Original instructions")
    view = view_workflow(paths, "legacy")
    prompt = next(n for n in view["strategy"]["nodes"] if n["binding"]["file"] == "prompts/analyze.md")
    saved = propose_workflow(paths, {"strategy_id": "legacy", "base_revision": view["revision"], "changes": [{"node_id": prompt["id"], "content": "Changed instructions"}]})
    assert saved["ok"]
    assert list_proposals(paths)[0].kind == "prompt_patch"
    assert (root / "prompts/analyze.md").read_text() == "Original instructions"
    files, _ = source_files(paths, "legacy", saved["proposal_id"])
    assert files["prompts/analyze.md"] == "Changed instructions"


def test_chat_transcript_returns_candidate_reference(tmp_path):
    from nerya.api import routes_agent
    cfg = Config(paths=WorkspacePaths(tmp_path), data=deepcopy(DEFAULT_CONFIG))
    SessionStore(tmp_path).update_meta("chat", {"strategy_proposal_id": "candidate"}, strategy_id="demo")
    handler = next(h for method, route, h in routes_agent.routes() if method == "GET" and route == "/agent/session/transcript")
    result = handler(SimpleNamespace(config=cfg), {"session_id": "chat"})
    assert result["strategy_proposal_id"] == "candidate" and result["strategy_id"] == "demo"


def test_new_candidate_from_turn_becomes_next_chat_reference(tmp_path, monkeypatch):
    from nerya.agent.kernel import AgentKernel, AgentTurnResult
    from nerya.api import routes_agent
    paths = WorkspacePaths(tmp_path)
    first = template(paths)
    next_view = propose_workflow(paths, {"strategy_id": "context_demo", "proposal_id": first["proposal_id"], "base_revision": first["workflow"]["revision"], "changes": [{"node_id": "strategy:context_demo", "config": {"title": "New candidate"}}]})
    def fake_turn(self, **kwargs):
        return AgentTurnResult(trigger_event_id="event", strategy_id="context_demo", session_id=kwargs["session_id"], turn_id="turn", decision={}, actions=[], tool_trace=[{"action": "strategy_submit_proposal", "result": {"proposal_id": next_view["proposal_id"], "strategy_id": "context_demo", "ok": True}}], stopped_reason="end_turn", final_text="updated")
    monkeypatch.setattr(AgentKernel, "run_turn", fake_turn)
    client = SimpleNamespace(config=Config(paths=paths, data=deepcopy(DEFAULT_CONFIG)), skills=None)
    handler = next(h for method, route, h in routes_agent.routes() if method == "POST" and route == "/agent/run_turn")
    handler(client, {"session_id": "editing", "strategy_id": "context_demo", "strategy_proposal_id": first["proposal_id"], "trigger": {"source": "user_chat", "payload": {"text": "edit this"}}})
    assert SessionStore(tmp_path).load("editing").meta["strategy_proposal_id"] == next_view["proposal_id"]


def test_script_ticks_share_context_with_explicit_fresh_option(tmp_path, monkeypatch):
    from nerya.core import yaml_io
    from nerya.strategies.runner import StrategyRunner
    paths = WorkspacePaths(tmp_path)
    out = template(paths, "multi_script")
    files, _ = source_files(paths, "context_demo", out["proposal_id"])
    files["main.py"] = 'def run(ctx):\n    return ctx.result.hold(reason="fixture")\n'
    for name, content in files.items():
        path = paths.strategy("context_demo") / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    cfg = Config(paths=paths, data=deepcopy(DEFAULT_CONFIG))
    cfg.data["runtime"]["mock_mode"] = True
    runner = StrategyRunner(config=cfg)
    observed = []
    original = StrategyRunner._invoke_entrypoint
    def capture(self, **kwargs):
        observed.append(kwargs["ctx"].subagents.session_id)
        return original(self, **kwargs)
    monkeypatch.setattr(StrategyRunner, "_invoke_entrypoint", capture)
    first, second = runner.run_tick("context_demo"), runner.run_tick("context_demo")
    assert first.session_id == second.session_id
    assert first.status == second.status == "hold", (first.outputs, first.error)
    assert observed == [first.session_id, second.session_id]
    manifest_file = paths.strategy("context_demo") / "strategy.yml"
    raw = yaml_io.load(manifest_file)
    raw["agent_session"] = {"policy": "per_signal"}
    yaml_io.dump(manifest_file, raw)
    assert runner.run_tick("context_demo").session_id != runner.run_tick("context_demo").session_id
