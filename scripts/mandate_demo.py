"""Rehearse signed mandates on an ephemeral LOCAL Anvil chain and paper ledger.

Run: python -m scripts.mandate_demo --output .tmp/mandate-demo
Requires: pip install -e .[mandates]; forge build --root contracts/mandates
Never connects to a public RPC or uses an existing wallet/workspace.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
from contextlib import closing
import html
import json
from pathlib import Path
import shutil
import socket
import subprocess
import time

from eth_account import Account
from eth_utils import keccak
from web3 import Web3

from nerya.core import jsonl, yaml_io
from nerya.core.config import Config, DEFAULT_CONFIG
from nerya.core.paths import WorkspacePaths
from nerya.db.sqlite import connect
from nerya.security.mandates import (
    ACTION_FIELDS, POLICY_FIELDS, digest, domain, hash_text, plan_hash,
    scope_hash, sign, typed_data,
)
from nerya.security.secrets import SecretVault
from nerya.trading.order_intents import SizingPolicy, TradePlan
from nerya.trading.submit import submit_trade_plan


def json_safe(value):
    return json.loads(Web3.to_json(value))


def run_demo(output: Path) -> dict:
    binary = shutil.which("anvil")
    artifact_path = Path(__file__).resolve().parents[1] / "contracts/mandates/out/NeryaMandateVerifier.sol/NeryaMandateVerifier.json"
    if not binary or not artifact_path.is_file():
        raise RuntimeError("Install Foundry and run: forge build --root contracts/mandates")
    artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    output.mkdir(parents=True, exist_ok=False)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    process = subprocess.Popen(
        [binary, "--host", "127.0.0.1", "--port", str(port), "--chain-id", "31337", "--silent"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        web3 = Web3(Web3.HTTPProvider(f"http://127.0.0.1:{port}", request_kwargs={"timeout": 3}))
        for _ in range(100):
            if web3.is_connected(): break
            if process.poll() is not None: raise RuntimeError("Local Anvil exited before startup")
            time.sleep(.1)
        else: raise RuntimeError("Local Anvil did not start")
        cfg = Config(paths=WorkspacePaths(root=output / "workspace"), data=deepcopy(DEFAULT_CONFIG))
        vault = SecretVault.open(cfg.paths.vault_enc)
        # Throwaway keys live only in the isolated demo vault, not the report.
        addresses = {}
        for name in ("demo-owner", "demo-agent"):
            account = Account.create()
            addresses[name] = account.address
            vault.put(name=name, value=account.key.hex(), kind="evm_private_key", scope=["mandate:sign"], owner="demo")
            web3.provider.make_request("anvil_setBalance", [account.address, hex(10**20)])
        receipts = []

        def transact(call, name="demo-owner"):
            tx = call.build_transaction({
                "from": addresses[name], "nonce": web3.eth.get_transaction_count(addresses[name]),
                "chainId": 31337, "gas": 3_000_000, "gasPrice": web3.eth.gas_price,
            })
            signed = Account.sign_transaction(tx, vault.resolve(name, required_scope="mandate:sign"))
            receipt = web3.eth.wait_for_transaction_receipt(web3.eth.send_raw_transaction(signed.raw_transaction))
            receipts.append(json_safe(receipt))
            return receipt

        salt = hash_text(str(output.resolve()))
        factory = web3.eth.contract(abi=artifact["abi"], bytecode=artifact["bytecode"]["object"])
        deployed = transact(factory.constructor(bytes.fromhex(salt[2:])))
        if deployed.status != 1: raise RuntimeError("Local deployment failed")
        contract = web3.eth.contract(address=deployed.contractAddress, abi=artifact["abi"])
        settings = {
            "accounts": {"mandate_paper": addresses["demo-owner"]}, "chain_id": 31337,
            "verifier": contract.address, "workspace": salt,
            "rpc_url": f"http://127.0.0.1:{port}",
            "runtime_code_hash": "0x" + keccak(web3.eth.get_code(contract.address)).hex(),
        }
        cfg.data.setdefault("trading", {})["signed_mandates"] = settings
        yaml_io.dump(cfg.paths.root / "nerya.yml", cfg.data)
        yaml_io.dump(cfg.paths.accounts_file, {"accounts": [{
            "id": "mandate_paper", "venue": "mock", "exchange": "mock", "mode": "paper",
            "status": "active", "initial_balance_usd": 10000,
            "permissions": {"read_balances": True, "place_order": True, "cancel_order": True},
        }]})
        yaml_io.dump(cfg.paths.strategy("mandate_demo") / "strategy.yml", {
            "id": "mandate_demo", "status": "paper", "account_id": "mandate_paper",
            "markets": ["mock:BTC/USDT", "mock:ETH/USDT"], "paper_trading_enabled": True,
            "live_trading_enabled": False,
        })
        yaml_io.dump(cfg.paths.strategy("mandate_demo") / "limits.yml", {
            "allowed_markets": ["mock:BTC/USDT", "mock:ETH/USDT"],
            "min_confidence": 0, "max_stale_seconds": 60, "approval_threshold_usd": 0,
        })
        d = domain(chain_id=31337, verifier=contract.address, workspace=salt)
        now = int(time.time())
        policy = {"owner": addresses["demo-owner"], "agent": addresses["demo-agent"],
                  "scope": scope_hash("mandate_paper", "mandate_demo"),
                  "market": hash_text("mock:BTC/USDT"), "maxCost": 110_000_000,
                  "budget": 500_000_000, "validAfter": now - 60, "validUntil": now + 3600,
                  "nonce": 1, "allowLong": True}
        proposals = []

        def make(nonce, *, size=100, cost=101_000_000, market="mock:BTC/USDT", policy_override=None):
            plan = TradePlan(strategy_id="mandate_demo", account_id="mandate_paper", market=market,
                side="long", sizing=SizingPolicy(method="fixed_usd", fixed_usd=size),
                confidence=1, source="strategy_runtime")
            p = {**policy, **(policy_override or {})}
            a = {"policyHash": digest(d, "Policy", p), "planHash": plan_hash(plan),
                 "market": hash_text(market), "cost": cost, "opensLong": True,
                 "nonce": nonce, "validUntil": p["validUntil"]}
            env = {"policy": p, "action": a,
                "policy_signature": sign(d, "Policy", p, vault.resolve("demo-owner", required_scope="mandate:sign")),
                "action_signature": sign(d, "Action", a, vault.resolve("demo-agent", required_scope="mandate:sign"))}
            plan.meta["signed_mandate"] = env
            # Cross-language verification of EIP-712 bytes against the compiled contract.
            assert "0x" + bytes(contract.functions.policyHash(tuple(p[n] for n, _ in POLICY_FIELDS)).call()).hex() == a["policyHash"]
            assert "0x" + bytes(contract.functions.actionHash(tuple(a[n] for n, _ in ACTION_FIELDS)).call()).hex() == digest(d, "Action", a)
            proposals.append({"plan": plan.asdict(), "policy_typed_data": typed_data(d, "Policy", p),
                              "action_typed_data": typed_data(d, "Action", a)})
            return plan

        def authorize(plan):
            e = plan.meta["signed_mandate"]
            return transact(contract.functions.authorize(
                tuple(e["policy"][n] for n, _ in POLICY_FIELDS), e["policy_signature"],
                tuple(e["action"][n] for n, _ in ACTION_FIELDS), e["action_signature"],
            ))

        results = []
        def execute(label, plan, receipt=None, expected="rejected", *, resume=False):
            # Count durable executor creations, not just a UI flag.
            with closing(connect(cfg.paths.db)) as con:
                before = con.execute("SELECT COUNT(*) FROM executor_runs").fetchone()[0]
            out = submit_trade_plan(cfg, plan, market_snapshot={"price": 100, "age_s": 0, "source": "local_demo_synthetic"}, resume=resume)
            with closing(connect(cfg.paths.db)) as con:
                after = con.execute("SELECT COUNT(*) FROM executor_runs").fetchone()[0]
            assert out["status"] == expected, out
            if expected == "rejected": assert before == after, "DENY created executor"
            results.append({"case": label, "status": out["status"], "new_executors": after-before,
                            "authorization_tx": Web3.to_hex(receipt.transactionHash) if receipt is not None else None,
                            "authorization_tx_status": receipt.status if receipt is not None else None,
                            "result": out})

        allowed = make(1)
        receipt = authorize(allowed); assert receipt.status == 1
        execute("ALLOW: signed and anchored action", allowed, receipt, "filled")
        forbidden = make(2, policy_override={"market": hash_text("mock:ETH/USDT"), "nonce": 3})
        receipt = authorize(forbidden); assert receipt.status == 0
        execute("DENY: user changes allowed market to ETH; BTC request stops", forbidden, receipt)
        fees = make(3, size=99, cost=99_000_000)
        receipt = authorize(fees); assert receipt.status == 1
        execute("DENY: fees and slippage exceed signed ceiling", fees, receipt)
        long = make(4, policy_override={"nonce": 2, "allowLong": False})
        receipt = authorize(long); assert receipt.status == 0
        execute("DENY: long opening prohibited", long, receipt)
        tampered = deepcopy(allowed); tampered.sizing.fixed_usd = 777
        execute("DENY: plan changed after signing", tampered)
        # Internal resume flag deliberately stresses nonce enforcement even if
        # the existing RiskGate dedupe is bypassed by the approval-resume path.
        execute("DENY: replay through resume path", allowed, resume=True)
        revoked = make(5, size=80, cost=81_000_000)
        receipt = authorize(revoked); assert receipt.status == 1
        revoke_receipt = transact(contract.functions.revoke(tuple(policy[n] for n, _ in POLICY_FIELDS)))
        assert revoke_receipt.status == 1
        execute("DENY: user revoked previously anchored policy", revoked, receipt)

        events = contract.events.ActionAuthorized.get_logs(from_block=0)
        report = {"environment": "ephemeral local Anvil; paper execution; synthetic market data",
                  "public_testnet": False, "human_wallet_approval": False,
                  "signing": "isolated demo keys in SecretVault; actual ECDSA, automated test owner",
                  "settings": settings, "domain": d, "cases": results,
                  "revocation_tx": Web3.to_hex(revoke_receipt.transactionHash),
                  "receipts": receipts, "authorization_events": json_safe(events),
                  "proposals": proposals,
                  "audit": jsonl.read_all(cfg.paths.journal("mandates"))}
        (output / "evidence.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        rows = "".join(f"<tr><td>{html.escape(r['case'])}</td><td>{r['status']}</td><td>{r['new_executors']}</td><td><code>{html.escape(str(r['authorization_tx'] or '—'))}</code></td></tr>" for r in results)
        page = f"""<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nerya · Signed Mandates</title>
<style>body{{background:#faf9fc;color:#292632;font:16px/1.7 system-ui;margin:40px auto;max-width:1180px;padding:0 20px}}h1{{color:#7854ad}}table{{border-collapse:collapse;width:100%;font-size:14px}}td,th{{padding:12px;text-align:left;border-bottom:1px solid #dfdce6}}code{{overflow-wrap:anywhere}}.table{{overflow:auto}}a{{color:#7854ad}}details{{margin-top:30px}}pre{{white-space:pre-wrap;overflow-wrap:anywhere}}</style>
<p>WayAgent FX · 非小号 × WayToWeb4</p><h1>Nerya Agent · Signed Mandates</h1>
<p>用户授权签名 → Agent 动作签名 → 链上授权登记 → RiskGate / ApprovalGate → 运行时费用检查 → 执行边界复验。</p>
<p><strong>本次为本地 Anvil 链、模拟交易、合成行情、自动化测试用户签名。</strong>不是公开测试网或真实钱包人工授权录像。脚本结束后本地链关闭，以下交易哈希仅对应本次导出的收据。</p>
<div class="table"><table><thead><tr><th>案例</th><th>实际结果</th><th>新增执行器</th><th>授权交易哈希</th></tr></thead><tbody>{rows}</tbody></table></div>
<p>撤销交易：<code>{html.escape(report['revocation_tx'])}</code></p><p><a href="evidence.json">完整证据 JSON：签名、Typed Data、交易收据、合约事件与运行日志</a></p>
<details><summary>查看逐例结果</summary><pre>{html.escape(json.dumps(results, ensure_ascii=False, indent=2))}</pre></details></html>"""
        (output / "report.html").write_text(page, encoding="utf-8")
        return {"report": str(output / "report.html"), "evidence": str(output / "evidence.json"),
                "cases": len(results), "public_testnet": False}
    finally:
        process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill(); process.wait(timeout=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="New directory; never an existing workspace")
    parser.add_argument("--publish-dashboard", action="store_true", help="Publish public demo fields to the local dashboard")
    args = parser.parse_args()
    summary = run_demo(args.output.resolve())
    if args.publish_dashboard:
        from scripts.mandate_dashboard import publish
        summary["dashboard_snapshot"] = str(publish(Path(summary["evidence"])))
    print(json.dumps(summary, ensure_ascii=False, indent=2))
