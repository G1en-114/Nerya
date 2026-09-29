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
