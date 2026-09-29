"""Operator CLI: deploy two small Sepolia registries and anchor a recorded run.

Reads secrets only through SecretVault. No mainnet or trading calls.
Run with --check first; reusing --output resumes receipts without rebroadcasting.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

from eth_account import Account
from web3 import Web3

from nerya.core.atomic_write import atomic_write_bytes
from nerya.security.secrets import SecretVault

ROOT = Path(__file__).resolve().parents[1]
RPC = "https://ethereum-sepolia.publicnode.com"
EXPLORER = "https://sepolia.etherscan.io"
CHAIN_ID = 11155111
MAX_FEE_WEI = 3_000_000_000_000_000  # 0.003 test ETH, whole run upper bound


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sha(value):
    return "0x" + hashlib.sha256(value).hexdigest()


def save(path, value):
    atomic_write_bytes(path, json.dumps(value, ensure_ascii=False, indent=2).encode())


def dotenv():
    values = {}
    path = ROOT / ".env"
    if path.exists():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                values[k.strip()] = v.strip().strip('"').strip("'")
    return {**values, **os.environ}


def public_evidence(path):
    raw = path.read_bytes()
    data = json.loads(raw)
    if not isinstance(data.get("cases"), list) or not data["cases"]:
        raise ValueError("Expected an existing mandate demo evidence.json with cases")
    cases = []
    for case in data["cases"]:
        if not isinstance(case.get("case"), str) or case.get("status") not in {"rejected", "executed", "approved", "submitted", "filled"}:
            raise ValueError("Unsupported recorded case/status")
        cases.append({k: case[k] for k in ("case", "status", "new_executors") if k in case})
    return {
        "schema": "nerya.gwdc.record.v1", "source_sha256": sha(raw),
        "kind": "commitment_to_previously_recorded_local_paper_demo",
        "cases": cases, "public_testnet_execution": False,
        "claim": "Public-chain timestamped commitment to a local paper demo summary; not a live trade or Kiln usage proof.",
    }


def run(args):
    env = dotenv()
    workspace = Path(args.workspace or env.get("NERYA_WORKSPACE", "~/.nerya")).expanduser()
    if not (workspace / "vault/secrets.enc").exists() and (workspace / "default/vault/secrets.enc").exists():
        workspace /= "default"
    vault_file = workspace / "vault/secrets.enc"
    if not vault_file.exists():
        raise ValueError("Signer Vault missing")
    ref = env.get("NERYA_TESTNET_SIGNER_REF", "vault://sepolia-signer")
    if not ref.startswith("vault://"):
        raise ValueError("Signer must be a Vault reference")
    vault = SecretVault.open(vault_file)
    account = Account.from_key(vault.resolve(ref[8:], required_scope="chain_audit").strip())
    rpc = args.rpc_url or env.get("NERYA_TESTNET_RPC_URL", RPC)
    if not rpc or "<" in rpc:
        rpc = RPC
    if not rpc.startswith("https://"):
        raise ValueError("Public testnet RPC must use HTTPS")
    if env.get("NERYA_TESTNET_CHAIN", "sepolia") != "sepolia":
        raise ValueError("This deployment is Sepolia only")
    web3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 25}))
    if web3.eth.chain_id != CHAIN_ID:
        raise ValueError("RPC chain is not Sepolia")
    balance = web3.eth.get_balance(account.address)
    payload = public_evidence(args.evidence)
    print(json.dumps({"chain_id": CHAIN_ID, "sender": account.address, "balance_wei": balance,
                      "evidence_sha256": sha(canonical(payload)), "check_only": args.check}), flush=True)
    if args.check:
        return
    if balance == 0:
        raise ValueError("Signer needs Sepolia test ETH")
    artifacts = {}
    for name in ("NeryaStrategyRegistry", "NeryaRunRecords"):
        path = ROOT / f"contracts/gwdc/out/{name}.sol/{name}.json"
        artifacts[name] = json.loads(path.read_text(encoding="utf-8"))
    args.output.mkdir(parents=True, exist_ok=True)
    lock = args.output / "deployment.lock"
    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        state_path = args.output / "deployment.json"
        metadata = {"name": "Nerya GWDC paper strategy", "function": "Strategy provenance and execution evidence records", "version": 1}
        identity = {"chain_id": CHAIN_ID, "sender": account.address,
                    "evidence_sha256": sha(canonical(payload)), "metadata_sha256": sha(canonical(metadata)),
                    "bytecode_sha256": {k: sha(bytes.fromhex(v["bytecode"]["object"].removeprefix("0x"))) for k, v in artifacts.items()}}
        state = json.loads(state_path.read_text()) if state_path.exists() else {**identity, "transactions": {}}
        if any(state.get(k) != v for k, v in identity.items()):
            raise ValueError("Output belongs to a different sender, build or evidence; choose a new output")
        save(args.output / "record.json", payload)
        save(args.output / "strategy.json", metadata)
        save(state_path, state)

        def transact(label, call):
            prior = state["transactions"].get(label)
            if prior is None:
                # Public testnet base fees can rise between estimation and mining.
                gas_price = web3.eth.gas_price * 2
                base = {"from": account.address, "chainId": CHAIN_ID,
                        "nonce": web3.eth.get_transaction_count(account.address, "pending"), "gasPrice": gas_price}
                gas = (call.estimate_gas(base) * 120 + 99) // 100
                bound = gas * gas_price
                previous_bound = sum(t["max_fee_wei"] for t in state["transactions"].values())
                if previous_bound + bound > MAX_FEE_WEI or web3.eth.get_balance(account.address) < bound:
                    raise ValueError("Test ETH fee cap/balance exceeded")
                tx = call.build_transaction({**base, "gas": gas})
                signed = account.sign_transaction(tx)
                tx_hash = Web3.to_hex(signed.hash)
                prior = {"tx_hash": tx_hash, "status": "broadcast_attempted", "nonce": base["nonce"],
                         "max_fee_wei": bound, "explorer": f"{EXPLORER}/tx/{tx_hash}"}
                state["transactions"][label] = prior
                save(state_path, state)  # Persist before submission; uncertain broadcasts never auto-repeat.
                web3.eth.send_raw_transaction(signed.raw_transaction)
            receipt = web3.eth.wait_for_transaction_receipt(prior["tx_hash"], timeout=180, poll_latency=3)
            prior["receipt"] = json.loads(Web3.to_json(receipt))
            prior["status"] = "confirmed" if receipt.status == 1 else "reverted"
            save(state_path, state)
            if receipt.status != 1:
                raise ValueError("Transaction reverted; receipt saved")
            print(json.dumps({"step": label, "tx_hash": prior["tx_hash"], "block": receipt.blockNumber}), flush=True)
            return receipt

        def deploy(name, *constructor_args):
            artifact = artifacts[name]
            factory = web3.eth.contract(abi=artifact["abi"], bytecode=artifact["bytecode"]["object"])
            receipt = transact(name, factory.constructor(*constructor_args))
            address = receipt.contractAddress
            code = web3.eth.get_code(address)
            if not code:
                raise ValueError("Deployment has no runtime code")
            save(args.output / f"{name}.abi.json", artifact["abi"])
            state.setdefault("contracts", {})[name] = {"address": address, "runtime_code_hash": Web3.to_hex(Web3.keccak(code)),
                                                       "explorer": f"{EXPLORER}/address/{address}"}
            save(state_path, state)
            return web3.eth.contract(address=address, abi=artifact["abi"])

        registry = deploy("NeryaStrategyRegistry")
        records = deploy("NeryaRunRecords", registry.address)
        strategy_id = Web3.keccak(text="nerya-gwdc-paper-strategy-v1")
        run_id = Web3.keccak(canonical(payload))
        transact("register_strategy", registry.functions.register(strategy_id, identity["metadata_sha256"]))
        transact("record_run", records.functions.record(strategy_id, run_id, identity["evidence_sha256"]))
        if registry.functions.ownerOf(strategy_id).call() != account.address:
            raise ValueError("Strategy owner verification failed")
        if Web3.to_hex(registry.functions.metadataHash(strategy_id).call()) != identity["metadata_sha256"]:
            raise ValueError("Metadata verification failed")
        if records.functions.registry().call() != registry.address:
            raise ValueError("Registry link verification failed")
        if Web3.to_hex(records.functions.evidenceHash(strategy_id, run_id).call()) != identity["evidence_sha256"]:
            raise ValueError("Evidence read-back failed")
        state.update({"verified": True, "strategy_id": Web3.to_hex(strategy_id), "run_id": Web3.to_hex(run_id),
                      "claim": payload["claim"]})
        state["events"] = {
            "StrategyRegistered": json.loads(Web3.to_json(registry.events.StrategyRegistered().process_receipt(state["transactions"]["register_strategy"]["receipt"]))),
            "RunRecorded": json.loads(Web3.to_json(records.events.RunRecorded().process_receipt(state["transactions"]["record_run"]["receipt"]))),
        }
        save(state_path, state)
        print(json.dumps({"verified": True, "evidence_file": str(state_path)}))
    finally:
        os.close(fd)
        lock.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace")
    parser.add_argument("--rpc-url")
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / ".tmp/gwdc-sepolia")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        run(args)
    except Exception as exc:
        # RPC exceptions can contain credential-bearing URLs. Never print them.
        print(json.dumps({"ok": False, "error_type": type(exc).__name__,
                          "detail": "Deployment incomplete. Check Vault, RPC, build and saved receipts. No automatic rebroadcast."}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
