from __future__ import annotations

import pytest

Account = pytest.importorskip("eth_account").Account

from nerya.core import jsonl
from nerya.core.paths import WorkspacePaths
from nerya.security.secrets import SecretVault
from nerya.trading.chain_evidence import (
    anchor_decision, decision_evidence, evidence_hash, verify_anchor,
)


@pytest.fixture
def paths(tmp_path):
    paths = WorkspacePaths(tmp_path)
    history = paths.strategy_history("s1")
    jsonl.append(history / "intents.jsonl", {
        "session_id": "session-1",
        "intent": {"intent_id": "intent-1", "plan_id": "plan-1",
                   "market": "BTCUSDT", "side": "buy"},
    })
    jsonl.append(history / "risk.jsonl", {
        "session_id": "session-1",
        "risk_decision": {"intent_id": "intent-1", "risk_evaluation_id": "risk-1",
                          "decision": "reject", "reasons": ["budget_exceeded"],
                          "ts": "2026-01-01T00:00:00Z"},
    })
    return paths


class FakeChain:
    def __init__(self, chain_id=11155111):
        self.chain_id = chain_id
        self.sends = []
        self.tx = None
        self.receipt = None

    def get_chain_id(self):
        return self.chain_id

    def send_raw_transaction(self, *, to, data, value, signer_private_key,
                             gas_limit, confirm, on_broadcast):
        self.sends.append((to, data, value))
        self.tx = {"input": data, "to": to, "value": "0x0"}
        self.receipt = {"status": "0x1", "blockNumber": "0x2a"}
        on_broadcast({"tx_hash": "0xabc"})
        return {"tx_hash": "0xabc", "confirmed": True, "block_number": 42}

    def _rpc(self, method, params):
        if method == "eth_getTransactionByHash":
            return self.tx
        if method == "eth_getTransactionReceipt":
            return self.receipt
        raise AssertionError(method)


@pytest.mark.smoke
def test_anchor_and_verify_persisted_rejection(paths):
    key = Account.create().key.hex()
    SecretVault.open(paths.vault_enc).put(name="audit-key", value=key,
                                          kind="private_key", scope=["chain_audit"])
    chain = FakeChain()
    prepared = decision_evidence(paths, "s1", "session-1")
    first = anchor_decision(paths, "s1", "session-1", chain="sepolia",
                            rpc_url="https://test.invalid", signer_ref="vault://audit-key",
                            connector=chain)
    assert first["record_hash"] == evidence_hash(prepared)
    assert first["status"] == "confirmed"
    assert chain.sends == [(Account.from_key(key).address, first["record_hash"], 0)]
    again = anchor_decision(paths, "s1", "session-1", chain="sepolia",
                            rpc_url="https://test.invalid", signer_ref="vault://audit-key",
                            connector=chain)
    assert again["already_recorded"] is True
    assert len(chain.sends) == 1
    assert verify_anchor(paths, "s1", "session-1", chain="sepolia",
                         rpc_url="https://test.invalid", connector=chain)["verified"] is True
    assert verify_anchor(paths, "s1", "session-1", chain="sepolia",
                         rpc_url="https://test.invalid", connector=chain)["verified"] is True
    chain.tx["input"] = "0x" + "0" * 64
    assert verify_anchor(paths, "s1", "session-1", chain="sepolia",
                         rpc_url="https://test.invalid", connector=chain)["verified"] is False


@pytest.mark.smoke
def test_missing_or_wrong_chain_evidence_is_rejected(paths):
    with pytest.raises(ValueError, match="invalid strategy"):
        decision_evidence(paths, "../escape", "session-1")
    with pytest.raises(ValueError, match="exactly one"):
        decision_evidence(paths, "s1", "missing")
    with pytest.raises(ValueError, match="only supports"):
        anchor_decision(paths, "s1", "session-1", chain="ethereum",
                        rpc_url="https://test.invalid", signer_ref="vault://audit-key")
    with pytest.raises(ValueError, match="no on-chain anchor"):
        verify_anchor(paths, "s1", "session-1", chain="sepolia",
                      rpc_url="https://test.invalid", connector=FakeChain())
