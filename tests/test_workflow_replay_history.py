from __future__ import annotations

import json
import sqlite3
from types import SimpleNamespace

import pytest

from nerya.core.config import Config
from nerya.core.paths import WorkspacePaths
from nerya.strategies.evolution import StrategyEvolutionRunner, TuningRunResult
from nerya.strategies.recorded_turn import recorded_turn
from nerya.strategies.tuning_history import record_tuning_result, tuning_history, tuning_record

pytestmark = pytest.mark.smoke


@pytest.fixture
def paths(tmp_path):
    value = WorkspacePaths(tmp_path)
    value.strategy("alpha").mkdir(parents=True)
    return value


def record(paths, run_id="run_old", **kwargs):
    record_tuning_result(paths, {"strategy_id": "alpha", "run_id": run_id, "status": "ok", "started_at": "2026-09-01T00:00:00Z", **kwargs})


def test_history_deduplicates_running_and_final_and_pages(paths):
    record(paths, status="running")
    record(paths, status="ok")
    record(paths, "run_new", started_at="2026-09-02T00:00:00Z")
    page = tuning_history(paths, "alpha", limit=1)
    assert [row["run_id"] for row in page["runs"]] == ["run_new"]
    assert page["has_more"] and page["next_offset"] == 1
    older = tuning_history(paths, "alpha", limit=1, offset=1)
    assert older["runs"][0]["status"] == "ok"
    assert not older["has_more"]


def test_record_is_exact_redacted_and_never_latest(paths):
    record(paths, request={"api_key": "never-show-this-value"}, subagent_output={"quantity": 0, "allowed": False})
    record(paths, "run_new", subagent_output={"text": "new reply"})
    result = tuning_record(paths, "alpha", "run_old")
    assert result["record"]["subagent_output"] == {"quantity": 0, "allowed": False}
    assert "never-show-this-value" not in json.dumps(result)
    assert result["partial"]  # No audit was recorded, not an invented empty conversation.
    assert not tuning_record(paths, "alpha", "missing")["ok"]
    assert not tuning_record(paths, "another", "run_old")["ok"]


@pytest.mark.parametrize("value", ["../alpha", "a/b", ".", "..", "", "a\\b"])
def test_history_rejects_unsafe_ids(paths, value):
    with pytest.raises(ValueError):
        tuning_record(paths, value, "run_old")
    with pytest.raises(ValueError):
        tuning_record(paths, "alpha", value)


def test_symlink_and_mismatched_audit_are_not_read(paths, tmp_path):
    record(paths)
    audit = paths.strategy("alpha") / "reviews/tuning_run_old_audit.json"
    audit.write_text(json.dumps({"strategy_id": "other", "run_id": "run_old", "payload": "wrong strategy"}))
    out = tuning_record(paths, "alpha", "run_old")
    assert "audit" not in out and out["partial"]
    assert "wrong strategy" not in json.dumps(out)
    paths.strategy("linked").symlink_to(paths.strategy("alpha"), target_is_directory=True)
    with pytest.raises(ValueError):
        tuning_history(paths, "linked")


def test_legacy_journal_and_malformed_tail(paths):
    paths.journals.mkdir(parents=True)
    paths.journal("strategy_evolution").write_text(json.dumps({"strategy_id": "alpha", "run_id": "legacy", "status": "skipped", "ts": "2026-08-01"}) + "\ninvalid\n")
    history = tuning_history(paths, "alpha")
    assert history["partial"] and history["runs"][0]["run_id"] == "legacy"
    assert tuning_record(paths, "alpha", "legacy")["record"]["status"] == "skipped"


@pytest.mark.parametrize("status", ["ok", "error", "hold", "skipped"])
def test_every_tuning_outcome_is_persisted(paths, monkeypatch, status):
    runner = StrategyEvolutionRunner(Config(paths=paths, data={"runtime": {"mock_mode": True}}), SimpleNamespace())
    def once(self, strategy_id, *, run_id, started, **kwargs):
        assert tuning_history(paths, strategy_id)["runs"][0]["status"] == "running"
        return TuningRunResult(run_id, strategy_id, started, started, 0, status)
    monkeypatch.setattr(StrategyEvolutionRunner, "_run_once", once)
    result = runner.run_once("alpha", note="operator request")
    saved = tuning_record(paths, "alpha", result.run_id)["record"]
    assert saved["status"] == status and saved["request"]["note"] == "operator request"


def test_unexpected_failure_records_error_and_preserves_exception(paths, monkeypatch):
    def fail(*args, **kwargs):
        raise RuntimeError("isolated test error")
    monkeypatch.setattr(StrategyEvolutionRunner, "_run_once", fail)
    runner = StrategyEvolutionRunner(Config(paths=paths, data={"runtime": {"mock_mode": True}}), SimpleNamespace())
    with pytest.raises(RuntimeError, match="isolated test error"):
        runner.run_once("alpha")
    assert tuning_history(paths, "alpha")["runs"][0]["status"] == "error"


def test_recorded_turn_keeps_exact_conversation_and_tool_io(paths):
    paths.db.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(paths.db) as db:
        db.execute("CREATE TABLE agent_messages(message_id TEXT, session_id TEXT, turn_id TEXT, role TEXT, content TEXT, ts TEXT, deleted INTEGER)")
        db.execute("CREATE TABLE agent_tool_events(event_id TEXT, session_id TEXT, turn_id TEXT, call_id TEXT, tool TEXT, phase TEXT, ok INTEGER, ts TEXT, payload_json TEXT)")
        db.executemany("INSERT INTO agent_messages VALUES(?,?,?,?,?,?,?)", [
            ("m1", "session", "old", "user", "old request", "01", 0),
            ("m2", "session", "old", "assistant", "old reply", "04", 0),
            ("m3", "session", "new", "assistant", "latest reply", "05", 0),
            ("m4", "session", "old", "assistant", "deleted reply", "06", 1),
        ])
        db.executemany("INSERT INTO agent_tool_events VALUES(?,?,?,?,?,?,?,?,?)", [
            ("e1", "session", "old", "c1", "market.read", "tool_use", None, "02", json.dumps({"payload": {"limit": 0, "api_key": "secret-test-value"}})),
            ("e2", "session", "old", "c1", "market.read", "tool_result", 1, "03", json.dumps({"result": False})),
        ])
    result = recorded_turn(paths, "session", "old")
    assert not result["partial"]
    assert [item["content"] for item in result["messages"]] == ["old request", "old reply"]
    assert result["events"][0]["payload"]["payload"]["limit"] == 0
    assert result["events"][1]["payload"]["result"] is False
    assert "secret-test-value" not in json.dumps(result)
    assert not recorded_turn(paths, "session", "missing")["messages"]


def test_reading_missing_database_does_not_create_it(paths):
    result = recorded_turn(paths, "session", "turn")
    assert result["partial"] and not paths.db.exists()
