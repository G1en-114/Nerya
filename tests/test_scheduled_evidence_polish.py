from __future__ import annotations

import threading
from types import SimpleNamespace

import pytest

from nerya.core import jsonl
from nerya.core.config import Config
from nerya.core.paths import WorkspacePaths
from nerya.sdk import strategy_api as api_module
from nerya.sdk.strategy_api import StrategyAPI
from nerya.strategies.agent_execution import agent_task_receipt
from nerya.strategy_history.store import record_agent_task
from nerya.triggers.schedule import ScheduleEntry
from nerya.triggers.scheduled_session import ScheduledSessionRunner


def config(tmp_path):
    return Config(paths=WorkspacePaths(tmp_path), data={})


def entry(**kwargs):
    return ScheduleEntry(id="fixture", kind="agent.digest", every_seconds=60,
                         session_kind="agent", **kwargs)


def outcome(kwargs, reason="end_turn"):
    return SimpleNamespace(turn_id=kwargs["turn_id"], decision={"summary": "fixture"},
                           actions=[], stopped_reason=reason, final_text="late evidence")


@pytest.mark.parametrize("raises", [False, True])
def test_ttl_preserves_fixed_identity_and_late_terminal_outcome(tmp_path, raises):
    release, persisted = threading.Event(), threading.Event()
    calls, delivery_calls = [], []
    cfg = config(tmp_path)

    class Kernel:
        def run_turn(self, **kwargs):
            calls.append(kwargs)
            assert release.wait(3)
            if raises:
                raise ValueError("late failure")
            return outcome(kwargs)

    class Runner(ScheduledSessionRunner):
        def _journal(self, schedule, result, now_ts):
            super()._journal(schedule, result, now_ts)
            if result.execution_status == "failed" or result.delivery_status == "failed":
                persisted.set()

    def deliver(_config, _entry, result):
        delivery_calls.append(result.turn_id)
        return [{"ok": False, "error": "fixture notifier unavailable"}]

    runner = Runner(cfg, lambda _: Kernel(), deliver)
    schedule = entry(session_ttl_seconds=0.03, delivery_targets=[{"kind": "local"}])
    try:
        initial = runner.run_once(schedule, now_ts=1000)
        assert initial.execution_status == "running_unconfirmed"
        assert initial.stopped_reason is None
        assert initial.delivery_status == "pending"
        assert initial.cancellation_requested and calls[0]["cancel_token"].is_set
        assert initial.turn_id == calls[0]["turn_id"]
        assert not initial.ok
    finally:
        release.set()
    assert persisted.wait(3)
    rows = jsonl.read_all(cfg.paths.journal("scheduled_session"))
    assert {r["turn_id"] for r in rows} == {initial.turn_id}
    assert {r["session_id"] for r in rows} == {initial.session_id}
    assert {r["trigger_event_id"] for r in rows} == {initial.trigger_event_id}
    terminal = rows[-1]
    assert terminal["late_outcome"] and terminal["ttl_exceeded"]
    assert terminal["receipt_id"] == initial.turn_id
    assert terminal["execution_status"] == ("failed" if raises else "completed")
    assert terminal["delivery_status"] == ("not_sent" if raises else "failed")
    assert len(calls) == 1
    assert len(delivery_calls) == (0 if raises else 1)
    if not raises:
        assert terminal["final_text"] == "late evidence"
        assert terminal["ok"] and terminal["error"] is None
    assert initial.execution_status == "running_unconfirmed"  # immutable caller snapshot


def test_ttl_cooperative_cancel_returns_real_cancelled_outcome(tmp_path):
    class Kernel:
        def run_turn(self, **kwargs):
            assert kwargs["cancel_token"].wait(2)
            return outcome(kwargs, "cancelled")

    result = ScheduledSessionRunner(config(tmp_path), lambda _: Kernel()).run_once(
        entry(session_ttl_seconds=0.05), now_ts=1000)
    assert result.execution_status == "cancelled"
    assert result.stopped_reason == "cancelled"
    assert result.ttl_exceeded and result.late_outcome and not result.ok


def test_slow_delivery_does_not_mark_completed_execution_timed_out(tmp_path):
    release, persisted = threading.Event(), threading.Event()
    cfg = config(tmp_path)
    tokens = []

    class Kernel:
        def run_turn(self, **kwargs):
            tokens.append(kwargs["cancel_token"])
            return outcome(kwargs)

    class Runner(ScheduledSessionRunner):
        def _journal(self, schedule, result, now_ts):
            super()._journal(schedule, result, now_ts)
            if result.delivery_status == "delivered":
                persisted.set()

    def delivery(*_):
        assert release.wait(3)
        return [{"ok": True}]

    try:
        result = Runner(cfg, lambda _: Kernel(), delivery).run_once(
            entry(session_ttl_seconds=0.03, delivery_targets=[{"kind": "local"}]))
        assert result.execution_status == "completed"
        assert result.delivery_status == "pending"
        assert not result.ttl_exceeded and not tokens[0].is_set
    finally:
        release.set()
    assert persisted.wait(3)
    assert jsonl.read_all(cfg.paths.journal("scheduled_session"))[-1]["delivery_status"] == "delivered"


@pytest.mark.parametrize("reason,status", [("approval_required", "needs_approval"),
    ("max_iterations", "returned"), ("provider_error", "failed"), ("end_turn", "completed")])
def test_schedule_and_strategy_receipts_classify_actual_stop_reason(tmp_path, reason, status):
    kernel = SimpleNamespace(run_turn=lambda **kwargs: outcome(kwargs, reason))
    result = ScheduledSessionRunner(config(tmp_path), lambda _: kernel).run_once(entry())
    assert result.execution_status == status
    task = {"status": "executed", "stopped_reason": reason, "task_id": "task",
            "turn_id": result.turn_id, "trigger_event_id": result.trigger_event_id}
    receipt = agent_task_receipt("demo", task, result.session_id)
    assert receipt["execution_status"] == status
    assert receipt["command_id"] is None and receipt["delivery_status"] == "unrecorded"


@pytest.fixture
def api(tmp_path, monkeypatch):
    api = StrategyAPI(config(tmp_path), skills=None)
    monkeypatch.setattr(api, "_read_proposal_files", lambda _: ("demo", {"strategy.yml": "fixture"}))
    monkeypatch.setattr(api_module, "validate_proposal_files", lambda **_: SimpleNamespace(
        ok=True, asdict=lambda: {"ok": True, "blockers": []}))
    monkeypatch.setattr(api_module, "set_state", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(api_module, "apply_proposal", lambda *_: {"ok": True})
    monkeypatch.setattr(api_module, "load_package", lambda *_: SimpleNamespace(
        manifest=SimpleNamespace(extras={"runtime": {"mode": "tick"}})))
    return api


def synced(*_):
    return SimpleNamespace(trading_id="demo_tick", tuning_id=None, added=["demo_tick"], updated=[], removed=[])


def test_application_success_survives_sync_failure_and_only_sync_is_retried(api, monkeypatch):
    def broken(*_):
        raise OSError("fixture write denied")
    monkeypatch.setattr(api_module, "apply_strategy_schedules", broken)
    result = api.promote("proposal")
    assert result["ok"] and result["application"]["status"] == "applied"
    assert result["schedule_sync"]["status"] == "failed"
    assert result["promotion"]["warnings"] == ["schedule_sync_failed"]
    assert api.schedule_status("demo")["promotion_receipt"]["schedule_sync"]["status"] == "failed"
    monkeypatch.setattr(api_module, "apply_proposal", lambda *_: pytest.fail("must not reapply proposal"))
    monkeypatch.setattr(api_module, "apply_strategy_schedules", synced)
    assert api.schedule("demo")["status"] == "synced"
    saved = api.schedule_status("demo")["promotion_receipt"]
    assert saved["schedule_sync"]["status"] == "synced"
    assert saved["proposal_id"] == "proposal" and saved["application"]["status"] == "applied"


def test_failed_application_does_not_sync_or_start_service(api, monkeypatch):
    monkeypatch.setattr(api_module, "apply_proposal", lambda *_: {"ok": False, "reason": "gate_blocked"})
    monkeypatch.setattr(api_module, "apply_strategy_schedules", lambda *_: pytest.fail("must not sync"))
    monkeypatch.setattr(api, "service_start", lambda *_: pytest.fail("must not start"))
    result = api.promote("proposal")
    assert not result["ok"] and result["application"]["status"] == "failed"
    assert result["schedule_sync"]["status"] == "not_attempted"


def test_validation_blockers_keep_proposal_and_schedules_untouched(api, monkeypatch):
    monkeypatch.setattr(api_module, "validate_proposal_files", lambda **_: SimpleNamespace(
        ok=False, asdict=lambda: {"ok": False, "blockers": ["fixture blocker"]}))
    monkeypatch.setattr(api_module, "set_state", lambda *_args, **_kwargs: pytest.fail("must not approve"))
    monkeypatch.setattr(api_module, "apply_proposal", lambda *_: pytest.fail("must not apply"))
    result = api.promote("proposal")
    assert not result["ok"] and result["reason"] == "validation_blockers"
    assert result["application"]["status"] == "not_applied"


def test_receipt_write_failure_does_not_claim_application_failed(api, monkeypatch):
    monkeypatch.setattr(api_module, "apply_strategy_schedules", synced)
    def broken(*_):
        raise OSError("fixture disk error")
    monkeypatch.setattr(api_module.jsonl, "append", broken)
    result = api.promote("proposal")
    assert result["ok"] and result["application"]["status"] == "applied"
    assert result["promotion"]["warnings"] == ["activation_receipt_persist_failed"]


def test_continuous_application_reports_service_without_starting(api, monkeypatch):
    monkeypatch.setattr(api_module, "load_package", lambda *_: SimpleNamespace(
        manifest=SimpleNamespace(extras={"runtime": {"mode": "continuous"}})))
    monkeypatch.setattr(api_module, "apply_strategy_schedules", lambda *_: SimpleNamespace(
        trading_id="", tuning_id=None, added=[], updated=[], removed=[]))
    monkeypatch.setattr(api, "service_status", lambda *_: {"state": "stopped"})
    monkeypatch.setattr(api, "service_start", lambda *_: pytest.fail("must not start"))
    result = api.promote("proposal")
    assert result["service"] == {"state": "stopped", "start_requested": False}
    assert result["schedule_sync"]["trading_id"] == ""


def test_strategy_list_consumes_merged_task_receipt(tmp_path):
    cfg = config(tmp_path)
    record_agent_task(cfg.paths, strategy_id="demo", session_id="ses", task={
        "task_id": "task", "turn_id": "turn", "status": "running", "trigger_event_id": "evt"})
    record_agent_task(cfg.paths, strategy_id="demo", session_id="ses", task={
        "task_id": "task", "status": "executed", "stopped_reason": "approval_required"})
    response = StrategyAPI(cfg, skills=None).agent_tasks("demo")
    assert response["count"] == 1 and response["event_count"] == 2
    receipt = response["tasks"][0]["receipt"]
    assert receipt["session_id"] == "ses" and receipt["turn_id"] == "turn"
    assert receipt["trigger_event_id"] == "evt" and receipt["execution_status"] == "needs_approval"


def test_schedule_receipt_redacts_payloads_and_does_not_copy_delivery_credentials(tmp_path):
    cfg = config(tmp_path)
    def run_turn(**kwargs):
        result = outcome(kwargs)
        result.actions = [{"api_key": "fixture-secret"}]
        return result
    result = ScheduledSessionRunner(cfg, lambda _: SimpleNamespace(run_turn=run_turn)).run_once(
        entry(delivery_targets=[{"kind": "webhook", "url": "fixture-private-url",
                                 "headers": {"Authorization": "fixture-secret"}}]))
    serialized = result.asdict()
    assert serialized["actions"][0]["api_key"]["__redacted__"]
    rows = cfg.paths.journal("scheduled_session").read_text()
    assert "fixture-secret" not in rows and "fixture-private-url" not in rows
