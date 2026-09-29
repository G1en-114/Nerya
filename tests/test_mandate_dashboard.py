"""The dashboard projection must preserve outcomes without publishing workspace data."""
from copy import deepcopy
import json

import pytest

from nerya.security.mandate_demo_export import publish, snapshot

pytestmark = pytest.mark.smoke


@pytest.fixture
def report():
    return {
        "public_testnet": False, "human_wallet_approval": False,
        "domain": {"chainId": 31337, "verifyingContract": "0xcontract"},
        "settings": {"rpc_url": "https://secret-token@rpc.invalid", "vault": "private-key"},
        "cases": [{"case": "DENY: fees", "status": "rejected", "new_executors": 0,
                   "authorization_tx": "0xtx", "authorization_tx_status": 1,
                   "result": {"plan_id": "p1", "notifications": {"token": "do-not-export"},
                              "mandate_decision": {"reason": "resolved_cost_exceeds_signed_ceiling"}}}],
        "proposals": [], "receipts": [{"transactionHash": "0xtx", "status": 1, "blockNumber": 2,
                                        "gasUsed": 123, "extra": "private-note"}],
        "audit": [{"ts": "2026-09-29T05:00:00Z", "secret": "do-not-export"}],
    }


def test_projection_preserves_chain_success_and_runtime_rejection(report):
    exported = snapshot(report)
    case = exported["cases"][0]
    assert case["status"] == "rejected" and case["authorizationStatus"] == 1
    assert case["newExecutors"] == 0
    assert exported["recordedAt"] == "2026-09-29T05:00:00Z"
    encoded = json.dumps(exported)
    for forbidden in ("private-key", "secret-token", "do-not-export", "private-note", "rpc_url"):
        assert forbidden not in encoded


@pytest.mark.parametrize("field,value", [("public_testnet", True), ("human_wallet_approval", True)])
def test_refuses_mislabeling_other_environments(report, field, value):
    report[field] = value
    with pytest.raises(ValueError):
        snapshot(report)


def test_refuses_nonlocal_chain_and_missing_results(report):
    wrong_chain = deepcopy(report)
    wrong_chain["domain"]["chainId"] = 1
    with pytest.raises(ValueError):
        snapshot(wrong_chain)
    report["cases"] = []
    with pytest.raises(ValueError):
        snapshot(report)


def test_failed_publication_preserves_last_recording(tmp_path, report):
    source, target = tmp_path / "evidence.json", tmp_path / "demo.json"
    source.write_text(json.dumps(report), encoding="utf-8")
    publish(source, target)
    original = target.read_bytes()
    report["cases"][0]["status"] = "unknown"
    source.write_text(json.dumps(report), encoding="utf-8")
    with pytest.raises(ValueError):
        publish(source, target)
    assert target.read_bytes() == original


def test_extended_evidence_keeps_stop_and_budget_without_private_fields(report):
    report["cases"][0]["result"] = {"risk_decision": {"reasons": ["kill_switch_enabled"]}}
    report["cases"][0].update(new_orders=0, new_fills=0)
    report["budget_steps"] = [{"step": 3, "policy_hash": "0xpolicy", "notional_usd": 98,
        "ceiling": 101000000, "budget": 220000000, "chain_spent": 202000000,
        "local_spent": 202000000, "remaining": 18000000, "chain_reason": "session_budget_exceeded",
        "block_number": 4, "fills": 2, "fill_cost_usd": 199.1, "private": "do-not-export"}]
    report["reconciliation"] = {"fault_injected": True, "injected_delta_base": .25,
        "baseline_report_id": "baseline", "halt_persisted": True, "scope": "isolated_demo_workspace",
        "automatic_resume": False, "blocked_attempts": 2,
        "report": {"report_id": "drift", "ts": 1, "severity": "warning", "private": "do-not-export",
                   "issues": [{"kind": "position_fill_drift", "position_id": "pos1", "market": "mock:BTC/USDT",
                               "expected_net": 1, "position_size": 1.25, "private": "do-not-export"}]}}
    exported = snapshot(report)
    assert exported["cases"][0]["reason"] == "kill_switch_enabled"
    assert exported["cases"][0]["newFills"] == 0
    assert exported["budgetSteps"][0]["remaining"] == "18000000"
    assert exported["reconciliation"]["differences"][0]["expectedNet"] == 1
    assert exported["reconciliation"]["haltPersisted"] is True
    assert "do-not-export" not in json.dumps(exported)
