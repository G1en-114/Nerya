from __future__ import annotations

from copy import deepcopy
from typing import Any

import pytest

import nerya.agent.kernel as kernel_module
from nerya.agent.kernel import AgentKernel
from nerya.agent.loop_state import TurnCheckpointResumeError
from nerya.core.config import Config, DEFAULT_CONFIG
from nerya.core.paths import WorkspacePaths
from nerya.db.repositories import AgentSessionRepository
from nerya.db.sqlite import connect
from nerya.llm.messages import MessagesResponse


pytestmark = pytest.mark.smoke


def _config(tmp_path) -> Config:
    data = deepcopy(DEFAULT_CONFIG)
    data.setdefault("agent", {}).setdefault("native", {})[
        "max_extra_llm_attempts_per_turn"
    ] = 4
    return Config(paths=WorkspacePaths(root=tmp_path), data=data)


def _install_scripted_gateway(
    monkeypatch,
    responses: list[MessagesResponse],
) -> list[list[dict[str, Any]]]:
    scripted = list(responses)
    calls: list[list[dict[str, Any]]] = []

    class _Gateway:
        def __init__(self, *_args, **_kwargs):
            pass

        def effective_model_metadata(self, *_args, **_kwargs):
            return "fixture", "checkpoint-model", {}

        def call_messages(self, **kwargs):  # noqa: ANN001
            calls.append(deepcopy(list(kwargs.get("messages") or [])))
            if not scripted:
                raise AssertionError("checkpoint gateway script exhausted")
            return scripted.pop(0)

    monkeypatch.setattr(kernel_module, "LLMGateway", _Gateway)
    return calls


def _text_response(text: str) -> MessagesResponse:
    return MessagesResponse(
        content=[{"type": "text", "text": text}],
        stop_reason="end_turn",
        usage={"input_tokens": 10, "output_tokens": 2},
        provider="fixture",
        model="checkpoint-model",
        usd_cost=0.01,
    )


def _trigger(event_id: str, text: str = "") -> dict[str, Any]:
    return {
        "id": event_id,
        "source": "dashboard",
        "kind": "user.chat",
        "payload": {"text": text},
    }


def test_durable_checkpoint_resumes_across_kernel_instances_without_leak(
    tmp_path,
    monkeypatch,
) -> None:
    cfg = _config(tmp_path)
    calls = _install_scripted_gateway(
        monkeypatch,
        [_text_response("draft"), _text_response("evidence-backed")],
    )

    first = AgentKernel(config=cfg, skills=None).run_turn(  # type: ignore[arg-type]
        trigger=_trigger("event-1", "inspect the workspace"),
        session_id="session-durable",
        turn_id="turn-durable",
    )

    assert first.final_text == "draft"
    assert first.budget["checkpoint"] == {
        "state": "saved",
        "persisted": True,
        "resumable": True,
        "turn_id": "turn-durable",
        "resume_count": 0,
        "bytes": first.budget["checkpoint"]["bytes"],
    }
    assert first.budget["checkpoint"]["bytes"] > 0

    second = AgentKernel(config=cfg, skills=None).run_turn(  # type: ignore[arg-type]
        trigger=_trigger("event-2"),
        session_id="session-durable",
        resume_turn_id="turn-durable",
        continuation_feedback="include verified evidence",
    )

    assert second.turn_id == "turn-durable"
    assert second.final_text == "evidence-backed"
    assert second.budget["checkpoint_continue"] is True
    assert second.budget["checkpoint"]["state"] == "saved"
    assert second.budget["checkpoint"]["resume_count"] == 1
    assert second.execution_state["checkpoint"] == second.budget["checkpoint"]
    assert len(calls) == 2

    second_messages = calls[1]
    original_requests = [
        message
        for message in second_messages
        if message.get("role") == "user"
        and message.get("content") == "inspect the workspace"
    ]
    continuation_messages = [
        message
        for message in second_messages
        if message.get("role") == "user"
        and "[completion gate continuation]" in str(message.get("content") or "")
    ]
    assert len(original_requests) == 1
    assert len(continuation_messages) == 1
    assert "include verified evidence" in continuation_messages[0]["content"]
    assert continuation_messages[0]["pinned"] is True

    con = connect(cfg.paths.db)
    try:
        repo = AgentSessionRepository(con)
        transcript = repo.transcript("session-durable", limit=0)
        checkpoint_row = repo.peek_turn_checkpoint("session-durable")
        session_row = repo.get_session("session-durable")
    finally:
        con.close()

    assert [row["role"] for row in transcript] == ["user", "assistant"]
    assert transcript[0]["content"] == "inspect the workspace"
    assert transcript[1]["content"] == "evidence-backed"
    assert checkpoint_row is not None
    assert checkpoint_row["claim_id"] is None
    assert checkpoint_row["checkpoint"]["resume_count"] == 1
    assert session_row is not None
    assert "checkpoint_json" not in session_row
    assert "turn_checkpoint" not in str(session_row.get("meta_json") or "")
    assert "inspect the workspace" not in str(session_row.get("meta_json") or "")


def test_normal_turn_cannot_replace_another_workers_live_lease(
    tmp_path,
    monkeypatch,
) -> None:
    cfg = _config(tmp_path)
    calls = _install_scripted_gateway(monkeypatch, [_text_response("draft")])
    AgentKernel(config=cfg, skills=None).run_turn(  # type: ignore[arg-type]
        trigger=_trigger("event-1", "inspect the workspace"),
        session_id="session-live-lease",
        turn_id="turn-live-lease",
    )

    con = connect(cfg.paths.db)
    try:
        repo = AgentSessionRepository(con)
        claimed = repo.claim_turn_checkpoint(
            "session-live-lease",
            turn_id="turn-live-lease",
            claim_id="tcp_live_worker",
        )
    finally:
        con.close()
    assert claimed is not None

    with pytest.raises(
        TurnCheckpointResumeError,
        match="Another worker already owns",
    ) as exc_info:
        AgentKernel(config=cfg, skills=None).run_turn(  # type: ignore[arg-type]
            trigger=_trigger("event-2", "start a different task"),
            session_id="session-live-lease",
            turn_id="turn-new",
        )

    assert exc_info.value.code == "turn_checkpoint_already_claimed"
    assert exc_info.value.status == 409
    assert len(calls) == 1
    con = connect(cfg.paths.db)
    try:
        current = AgentSessionRepository(con).peek_turn_checkpoint(
            "session-live-lease"
        )
    finally:
        con.close()
    assert current is not None
    assert current["turn_id"] == "turn-live-lease"
    assert current["claim_id"] == "tcp_live_worker"


def test_failed_durable_resume_discards_checkpoint_and_prevents_replay(
    tmp_path,
    monkeypatch,
) -> None:
    cfg = _config(tmp_path)
    _install_scripted_gateway(monkeypatch, [_text_response("draft")])
    AgentKernel(config=cfg, skills=None).run_turn(  # type: ignore[arg-type]
        trigger=_trigger("event-1", "inspect the workspace"),
        session_id="session-failed-resume",
        turn_id="turn-failed-resume",
    )

    def _fail_after_claim(self, **_kwargs):  # noqa: ANN001
        raise RuntimeError("provider failed after checkpoint claim")

    monkeypatch.setattr(AgentKernel, "_run", _fail_after_claim)

    with pytest.raises(RuntimeError, match="failed after checkpoint claim"):
        AgentKernel(config=cfg, skills=None).run_turn(  # type: ignore[arg-type]
            trigger=_trigger("event-2"),
            session_id="session-failed-resume",
            resume_turn_id="turn-failed-resume",
            continuation_feedback="continue safely",
        )

    con = connect(cfg.paths.db)
    try:
        claimed = AgentSessionRepository(con).peek_turn_checkpoint(
            "session-failed-resume"
        )
    finally:
        con.close()
    assert claimed is None

    with pytest.raises(
        TurnCheckpointResumeError,
        match="No durable checkpoint",
    ) as exc_info:
        AgentKernel(config=cfg, skills=None).run_turn(  # type: ignore[arg-type]
            trigger=_trigger("event-3"),
            session_id="session-failed-resume",
            resume_turn_id="turn-failed-resume",
            continuation_feedback="retry the same checkpoint",
        )
    assert exc_info.value.code == "turn_checkpoint_not_found"
    assert exc_info.value.status == 404

def test_large_checkpoint_persists_and_resumes_across_instances(tmp_path, monkeypatch):
    cfg = _config(tmp_path)
    cfg.data['agent']['native']['turn_checkpoint_max_bytes'] = 1024
    answer = '研究证据' * 200000
    calls = _install_scripted_gateway(monkeypatch, [_text_response(answer), _text_response('next')])
    kernel = AgentKernel(config=cfg, skills=None)
    first = kernel.run_turn(trigger=_trigger('large', 'research'), session_id='overflow', turn_id='large-turn')
    assert first.final_text == answer
    assert first.budget['checkpoint']['persisted'] is True
    assert first.budget['checkpoint']['resumable'] is True
    assert first.budget['checkpoint']['bytes'] > 2 * 1024 * 1024
    second = AgentKernel(config=cfg, skills=None).run_turn(
        trigger=_trigger('next'), session_id='overflow', resume_turn_id='large-turn',
        continuation_feedback='continue from the complete evidence')
    assert second.final_text == 'next'
    assert second.budget['checkpoint']['resume_count'] == 1
    assert answer in str(calls[-1])


def test_failed_turn_releases_only_its_own_lease(tmp_path, monkeypatch):
    cfg = _config(tmp_path)
    kernel = AgentKernel(config=cfg, skills=None)
    original = kernel._run
    def fail(**kwargs):
        raise RuntimeError('injected failure after lease acquisition')
    monkeypatch.setattr(kernel, '_run', fail)
    with pytest.raises(RuntimeError, match='injected failure'):
        kernel.run_turn(trigger=_trigger('fail'), session_id='failed-lease')
    monkeypatch.setattr(kernel, '_run', original)
    _install_scripted_gateway(monkeypatch, [_text_response('recovered')])
    result = kernel.run_turn(trigger=_trigger('recover'), session_id='failed-lease')
    assert result.final_text == 'recovered'


def test_provider_skill_load_compatibility_uses_canonical_tool(tmp_path, monkeypatch):
    from nerya.tools.native.skill import SkillIndex
    from nerya.tools.native.skill_tool import register_skill_tool
    skill = tmp_path / 'skills' / 'fixture'
    skill.mkdir(parents=True)
    (skill / 'SKILL.md').write_text('---\nname: fixture\ndescription: fixture\n---\nRead-only fixture instructions.')
    kernel = AgentKernel(config=_config(tmp_path), skills=None)
    kernel._ensure_registry()
    register_skill_tool(kernel._registry, skill_index=SkillIndex([skill.parent]), replace=True)
    calls = _install_scripted_gateway(monkeypatch, [
        MessagesResponse(content=[{'type': 'tool_use', 'id': 'skill-call', 'name': 'skill_load', 'input': {'skill': 'fixture'}}], stop_reason='tool_use'),
        _text_response('loaded'),
    ])
    result = kernel.run_turn(trigger=_trigger('skill', 'load fixture'), session_id='skill-alias')
    assert result.final_text == 'loaded'
    import json
    transcript = json.dumps(calls[-1])
    assert 'Read-only fixture instructions.' in transcript
    assert 'permission_denied' not in transcript
