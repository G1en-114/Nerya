"""Independently verify the public GWDC bundle against Sepolia (no wallet needed)."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from web3 import Web3

from scripts.gwdc_deploy import CHAIN_ID, RPC, canonical, sha


def verify(bundle: Path, rpc_url: str) -> dict:
    state = json.loads((bundle / "deployment.json").read_text(encoding="utf-8"))
    record = json.loads((bundle / "record.json").read_text(encoding="utf-8"))
    metadata = json.loads((bundle / "strategy.json").read_text(encoding="utf-8"))
    if sha(canonical(record)) != state["evidence_sha256"] or sha(canonical(metadata)) != state["metadata_sha256"]:
        raise ValueError("Bundle content hash mismatch")
    web3 = Web3(Web3.HTTPProvider(rpc_url, request_kwargs={"timeout": 25}))
    if state["chain_id"] != CHAIN_ID or web3.eth.chain_id != CHAIN_ID:
        raise ValueError("Wrong chain")
    contracts = {}
    for name, info in state["contracts"].items():
        receipt = web3.eth.get_transaction_receipt(state["transactions"][name]["tx_hash"])
        if receipt.contractAddress != info["address"]:
            raise ValueError("Deployment address mismatch")
        code = web3.eth.get_code(info["address"])
        if not code or Web3.to_hex(Web3.keccak(code)) != info["runtime_code_hash"]:
            raise ValueError("Runtime code hash mismatch")
        abi = json.loads((bundle / f"{name}.abi.json").read_text(encoding="utf-8"))
        contracts[name] = web3.eth.contract(address=info["address"], abi=abi)
    for info in state["transactions"].values():
        tx = web3.eth.get_transaction(info["tx_hash"])
        receipt = web3.eth.get_transaction_receipt(info["tx_hash"])
        saved = info["receipt"]
        if receipt.status != 1 or tx["from"] != state["sender"] or tx["value"] != 0:
            raise ValueError("Transaction not successful/from expected sender/zero value")
        if receipt.blockNumber != saved["blockNumber"] or Web3.to_hex(receipt.blockHash) != saved["blockHash"]:
            raise ValueError("Receipt block mismatch")
        if json.loads(Web3.to_json(receipt.logs)) != saved["logs"]:
            raise ValueError("Receipt logs mismatch")
    registry = contracts["NeryaStrategyRegistry"]
    records = contracts["NeryaRunRecords"]
    sid, rid = state["strategy_id"], state["run_id"]
    if registry.functions.ownerOf(sid).call() != state["sender"]:
        raise ValueError("Wrong strategy owner")
    if Web3.to_hex(registry.functions.metadataHash(sid).call()) != state["metadata_sha256"]:
        raise ValueError("Metadata commitment mismatch")
    if records.functions.registry().call() != registry.address:
        raise ValueError("Wrong registry link")
    if Web3.to_hex(records.functions.evidenceHash(sid, rid).call()) != state["evidence_sha256"]:
        raise ValueError("On-chain evidence commitment mismatch")
    receipt = web3.eth.get_transaction_receipt(state["transactions"]["record_run"]["tx_hash"])
    events = records.events.RunRecorded().process_receipt(receipt)
    if len(events) != 1 or Web3.to_hex(events[0]["args"]["evidenceHash"]) != state["evidence_sha256"]:
        raise ValueError("Missing matching RunRecorded log")
    event = events[0]["args"]
    if Web3.to_hex(event["strategyId"]) != sid or Web3.to_hex(event["runId"]) != rid or event["recorder"] != state["sender"]:
        raise ValueError("RunRecorded identity mismatch")
    return {"verified": True, "chain_id": CHAIN_ID, "transactions": len(state["transactions"]),
            "record_tx": state["transactions"]["record_run"]["tx_hash"], "claim": record["claim"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--rpc-url", default=RPC)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.bundle, args.rpc_url)))
    except Exception as exc:
        print(json.dumps({"verified": False, "error_type": type(exc).__name__}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
