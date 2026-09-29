"""Publish a bounded, read-only local demo snapshot for the dashboard.

Only explicit public fields are exported; never copy a workspace or raw report.
Usage: python -m scripts.mandate_dashboard --input .tmp/RUN/evidence.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


TARGET = Path(__file__).resolve().parents[1] / "dashboard/public/mandates/demo.json"


def snapshot(report: dict) -> dict:
    if (report.get("public_testnet") is not False
            or report.get("human_wallet_approval") is not False
            or report.get("domain", {}).get("chainId") != 31337):
        raise ValueError("Only isolated local demo reports can be published here")
    cases = report.get("cases", [])
    if not cases or len(cases) > 100:
        raise ValueError("Missing or oversized demo cases")
    records = []
    for index, case in enumerate(cases):
        if case["status"] not in ("filled", "rejected") or type(case["new_executors"]) is not int or case["new_executors"] < 0:
            raise ValueError("Invalid demo outcome")
        result = case["result"]
        decision = result.get("mandate_decision", {})
        records.append({
            "id": index + 1, "name": case["case"], "status": case["status"],
            "newExecutors": case["new_executors"], "planId": result.get("plan_id"),
            "reason": decision.get("reason", "authorized" if case["status"] == "filled" else "unknown"),
            "policyHash": decision.get("policy_hash"), "actionHash": decision.get("action_hash"),
            "planHash": decision.get("plan_hash"),
            "authorizationTx": case.get("authorization_tx"),
            "authorizationStatus": case.get("authorization_tx_status"),
        })
    policies = []
    for proposal in report.get("proposals", []):
        from nerya.security.mandates import hash_text
        plan = proposal["plan"]
        envelope = plan["meta"]["signed_mandate"]
        policy = envelope["policy"]
        policy_hash = envelope["action"]["policyHash"]
        if any(p["hash"] == policy_hash for p in policies):
            continue
        policies.append({
            "hash": policy_hash, "owner": policy["owner"], "agent": policy["agent"],
            "scope": policy["scope"], "marketHash": policy["market"],
            "marketLabel": next((market for market in ("mock:BTC/USDT", "mock:ETH/USDT")
                                 if hash_text(market).lower() == policy["market"].lower()), None),
            "maxCost": str(policy["maxCost"]), "budget": str(policy["budget"]),
            "validAfter": policy["validAfter"], "validUntil": policy["validUntil"],
            "allowLong": policy["allowLong"], "nonce": str(policy["nonce"]),
        })
    receipts = [{
        "transactionHash": r["transactionHash"], "status": r["status"],
        "blockNumber": r["blockNumber"], "gasUsed": r["gasUsed"],
    } for r in report.get("receipts", [])]
    times = [a["ts"] for a in report.get("audit", []) if a.get("ts")]
    return {
        "schemaVersion": 1, "mode": "local-paper-recording",
        "runId": hashlib.sha256(json.dumps(receipts, sort_keys=True).encode()).hexdigest()[:16],
        "recordedAt": max(times) if times else None,
        "chainId": 31337, "contract": report["domain"]["verifyingContract"],
        "cases": records, "policies": policies, "receipts": receipts,
        "revocationTx": report.get("revocation_tx"),
    }


def publish(source: Path, target: Path = TARGET) -> Path:
    data = snapshot(json.loads(source.read_text(encoding="utf-8")))
    target.parent.mkdir(parents=True, exist_ok=True)
    staged = target.with_suffix(".json.tmp")
    staged.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    staged.replace(target)
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    args = parser.parse_args()
    print(publish(args.input))
