"""Operator-triggered testnet anchoring of persisted RiskGate decisions."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from ..connectors.evm_native import EVMNative
from ..core import jsonl
from ..core.paths import WorkspacePaths
from ..security.secrets import SecretVault
from .locks import trading_lock


TESTNET_CHAIN_IDS = {"sepolia": 11155111, "base-sepolia": 84532}
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


def _valid_id(value: str) -> str:
    if not _ID.fullmatch(value):
        raise ValueError("invalid strategy or session id")
    return value


def decision_evidence(paths: WorkspacePaths, strategy_id: str, session_id: str) -> dict[str, Any]:
    """Build a bounded public claim from the existing strategy history."""
    strategy_id, session_id = _valid_id(strategy_id), _valid_id(session_id)
    root = paths.strategy_history(strategy_id)
    risks = [r.get("risk_decision") for r in jsonl.read_all(root / "risk.jsonl")
             if r.get("session_id") == session_id and isinstance(r.get("risk_decision"), dict)]
    if len(risks) != 1:
        raise ValueError("session must have exactly one persisted risk decision")
    risk = risks[0]
    intent_id = risk.get("intent_id")
    intents = [r.get("intent") for r in jsonl.read_all(root / "intents.jsonl")
               if r.get("session_id") == session_id and isinstance(r.get("intent"), dict)
               and r["intent"].get("intent_id") == intent_id]
    if len(intents) != 1 or not intent_id or risk.get("decision") not in {"allow", "reject", "escalate"}:
        raise ValueError("matching persisted intent and risk decision required")
    intent = intents[0]
    return {
        "version": 1,
        "strategy_id": strategy_id,
        "session_id": session_id,
        "intent_id": intent_id,
        "plan_id": intent.get("plan_id", ""),
        "market": intent.get("market", ""),
        "side": intent.get("side", ""),
        "risk_evaluation_id": risk.get("risk_evaluation_id", ""),
        "decision": risk["decision"],
        "reasons": risk.get("reasons") or [],
        "decision_ts": risk.get("ts", ""),
    }


def evidence_hash(evidence: dict[str, Any]) -> str:
    payload = json.dumps(evidence, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "0x" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _records(paths: WorkspacePaths, digest: str) -> list[dict[str, Any]]:
    return [row for row in jsonl.read_all(paths.journal("chain_evidence"))
            if row.get("record_hash") == digest]


def anchor_decision(
    paths: WorkspacePaths, strategy_id: str, session_id: str, *, chain: str,
    rpc_url: str, signer_ref: str, connector: EVMNative | None = None,
) -> dict[str, Any]:
    """Anchor one existing decision; never rebroadcast an already attempted hash."""
    if chain not in TESTNET_CHAIN_IDS:
        raise ValueError("chain evidence only supports sepolia or base-sepolia")
    if not rpc_url.startswith("https://") and not rpc_url.startswith("http://127.0.0.1:"):
        raise ValueError("testnet RPC must use HTTPS")
    if not signer_ref.startswith("vault://") or not signer_ref[8:]:
        raise ValueError("signer must be a vault:// reference")
    evidence = decision_evidence(paths, strategy_id, session_id)
    digest = evidence_hash(evidence)
    with trading_lock(paths, "chain_evidence:" + chain + ":" + digest) as acquired:
        if not acquired:
            raise ValueError("anchor already in progress for this decision")
        return _anchor_locked(paths, strategy_id, session_id, chain=chain,
                              rpc_url=rpc_url, signer_ref=signer_ref,
                              connector=connector, evidence=evidence, digest=digest)


def _anchor_locked(
    paths: WorkspacePaths, strategy_id: str, session_id: str, *, chain: str,
    rpc_url: str, signer_ref: str, connector: EVMNative | None,
    evidence: dict[str, Any], digest: str,
) -> dict[str, Any]:
    prior = [r for r in _records(paths, digest) if r.get("chain") == chain]
    if prior:
        return {"status": prior[-1]["status"], "record_hash": digest,
                "tx_hash": prior[-1].get("tx_hash", ""), "already_recorded": True}

    signer = SecretVault.open(paths.vault_enc).resolve(signer_ref[8:], required_scope="chain_audit")
    from eth_account import Account  # type: ignore

    sender = Account.from_key(signer).address
    conn = connector or EVMNative(chain=chain, chain_id=TESTNET_CHAIN_IDS[chain],
                                  rpc_url=rpc_url, live=True)
    # A self-addressed zero-value transaction carries only the 32-byte claim hash.
    def on_broadcast(tx: dict[str, Any]) -> None:
        jsonl.append(paths.journal("chain_evidence"), {
            "kind": "chain_evidence.anchor", "status": "broadcast_attempted",
            "chain": chain, "chain_id": TESTNET_CHAIN_IDS[chain],
            "strategy_id": strategy_id, "session_id": session_id,
            "intent_id": evidence["intent_id"], "record_hash": digest,
            "tx_hash": tx["tx_hash"], "from": sender,
        })

    result = conn.send_raw_transaction(to=sender, data=digest, value=0,
                                       signer_private_key=signer, gas_limit=100_000,
                                       confirm=True, on_broadcast=on_broadcast)
    status = "confirmed" if result.get("confirmed") else "submitted"
    jsonl.append(paths.journal("chain_evidence"), {
        "kind": "chain_evidence.anchor", "status": status,
        "chain": chain, "chain_id": TESTNET_CHAIN_IDS[chain],
        "strategy_id": strategy_id, "session_id": session_id,
        "intent_id": evidence["intent_id"], "record_hash": digest,
        "tx_hash": result["tx_hash"], "from": sender,
        "block_number": result.get("block_number"),
    })
    return {"status": status, "chain": chain, "chain_id": TESTNET_CHAIN_IDS[chain],
            "strategy_id": strategy_id, "session_id": session_id,
            "record_hash": digest, "tx_hash": result["tx_hash"],
            "block_number": result.get("block_number")}


def verify_anchor(
    paths: WorkspacePaths, strategy_id: str, session_id: str, *, chain: str,
    rpc_url: str, connector: EVMNative | None = None,
) -> dict[str, Any]:
    if chain not in TESTNET_CHAIN_IDS:
        raise ValueError("unsupported testnet")
    if not rpc_url.startswith("https://") and not rpc_url.startswith("http://127.0.0.1:"):
        raise ValueError("testnet RPC must use HTTPS")
    evidence = decision_evidence(paths, strategy_id, session_id)
    digest = evidence_hash(evidence)
    rows = [r for r in _records(paths, digest)
            if r.get("kind") == "chain_evidence.anchor" and r.get("chain") == chain
            and r.get("tx_hash")]
    if not rows:
        raise ValueError("no on-chain anchor recorded for this decision")
    row = rows[-1]
    conn = connector or EVMNative(chain=chain, chain_id=TESTNET_CHAIN_IDS[chain], rpc_url=rpc_url)
    if conn.get_chain_id() != TESTNET_CHAIN_IDS[chain]:
        raise ValueError("RPC chain id does not match selected testnet")
    tx = conn._rpc("eth_getTransactionByHash", [row["tx_hash"]])
    receipt = conn._rpc("eth_getTransactionReceipt", [row["tx_hash"]])
    verified = (isinstance(tx, dict) and isinstance(receipt, dict)
                and str(tx.get("input", "")).lower() == digest.lower()
                and str(tx.get("to", "")).lower() == str(row.get("from", "")).lower()
                and int(tx.get("value", "0x0"), 16) == 0
                and int(receipt.get("status", "0x0"), 16) == 1)
    result = {"verified": bool(verified), "status": "confirmed" if verified else "unverified",
              "chain": chain, "chain_id": TESTNET_CHAIN_IDS[chain],
              "strategy_id": strategy_id, "session_id": session_id,
              "intent_id": evidence["intent_id"], "record_hash": digest,
              "tx_hash": row["tx_hash"]}
    if verified:
        result["block_number"] = int(receipt["blockNumber"], 16)
        if row.get("status") != "confirmed":
            jsonl.append(paths.journal("chain_evidence"),
                         {"kind": "chain_evidence.verified", **result})
    return result
