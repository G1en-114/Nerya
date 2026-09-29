"""The demo's explicit drift rule latches a real persisted stop; no network."""
from copy import deepcopy

import pytest

pytest.importorskip("web3")

from nerya.core import jsonl, yaml_io
from nerya.core.config import Config, DEFAULT_CONFIG, load_config
from nerya.core.paths import WorkspacePaths
from nerya.security.mandate_demo import _halt_demo_on_drift, validate_request
from nerya.trading.reconciliation import ReconciliationReport

pytestmark = pytest.mark.smoke


def test_drift_stop_persists_and_clean_report_cannot_resume(tmp_path, monkeypatch):
    cfg = Config(paths=WorkspacePaths(root=tmp_path), data=deepcopy(DEFAULT_CONFIG))
    yaml_io.dump(tmp_path / "nerya.yml", cfg.data)
    report = ReconciliationReport(report_id="test-drift", ts=1, scope="local", severity="warning",
        account_id="mandate_paper", issues=[{"kind": "position_fill_drift"}])
    monkeypatch.setattr("nerya.trading.reconciliation.reconcile_local", lambda *a, **kw: report)
    detected = _halt_demo_on_drift(cfg)
    assert detected["severity"] == "warning"  # Never forge a severity from the reconciler.
    restored = load_config(tmp_path)
    assert restored.kill_switch()
    incident = jsonl.read_all(cfg.paths.journal("mandate_demo_incidents"))[0]
    assert incident["report_id"] == "test-drift" and incident["automatic_resume"] is False
    report.issues = []
    report.severity = "info"
    _halt_demo_on_drift(restored)
    assert load_config(tmp_path).kill_switch()


def test_other_warnings_do_not_trigger_the_demo_position_rule(tmp_path, monkeypatch):
    cfg = Config(paths=WorkspacePaths(root=tmp_path), data=deepcopy(DEFAULT_CONFIG))
    report = ReconciliationReport(report_id="other", ts=1, scope="local", severity="warning",
        issues=[{"kind": "order_fills_mismatch"}])
    monkeypatch.setattr("nerya.trading.reconciliation.reconcile_local", lambda *a, **kw: report)
    _halt_demo_on_drift(cfg)
    assert cfg.data["runtime"]["kill_switch"] is False
    assert not cfg.paths.journal("mandate_demo_incidents").exists()


@pytest.mark.parametrize("scenario", ["budget", "reconciliation"])
def test_extended_scenarios_cannot_select_an_existing_workspace(scenario):
    assert validate_request({"scenario": scenario})["scenario"] == scenario
    with pytest.raises(ValueError):
        validate_request({"scenario": scenario, "workspace": "operator-workspace"})
