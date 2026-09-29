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
import sqlite3
import subprocess
import time

from eth_account import Account
from eth_utils import keccak
from web3 import Web3

from nerya.core import jsonl, yaml_io
from nerya.core.config import Config, DEFAULT_CONFIG, load_config
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


SCENARIOS = {"suite", "allowed", "market", "fees", "long", "tamper", "replay", "revoke", "custom", "budget", "reconciliation"}


def _ledger_observation(paths: WorkspacePaths) -> dict:
    """Read actual durable effects, including fills rather than executor flags."""
    with closing(connect(paths.db)) as con:
        return {
            "executors": con.execute("SELECT COUNT(*) FROM executor_runs").fetchone()[0],
            "orders": con.execute("SELECT COUNT(*) FROM orders").fetchone()[0],
            "fills": con.execute("SELECT COUNT(*) FROM fills").fetchone()[0],
            "fill_cost_usd": con.execute("SELECT COALESCE(SUM(notional_usd + fee_usd), 0) FROM fills").fetchone()[0],
        }


def _halt_demo_on_drift(config: Config) -> dict:
    """Operator demo rule, called only with the freshly created demo workspace.

    Local reconciliation itself reports warnings. This explicit demo rule
    latches the existing workspace kill switch for a position/fill mismatch.
    It never clears a stop, even if a later reconciliation is clean.
    """
    from nerya.trading.reconciliation import reconcile_local

    report = reconcile_local(config.paths, account_id="mandate_paper")
    if any(issue["kind"] == "position_fill_drift" for issue in report.issues):
        config.data.setdefault("runtime", {})["kill_switch"] = True
        yaml_io.dump(config.paths.root / "nerya.yml", config.data)
        jsonl.append(config.paths.journal("mandate_demo_incidents"), {
            "kind": "demo_position_drift_halt", "report_id": report.report_id,
            "ts": report.ts, "scope": "isolated_demo_workspace", "automatic_resume": False,
        })
    return report.as_dict()


def validate_request(request: dict) -> dict:
    """Only demo enums and bounded integer amounts; no paths, accounts or RPCs."""
    defaults = {"scenario": "suite", "allowed_market": "mock:BTC/USDT", "request_market": "mock:BTC/USDT",
                "amount": 100, "ceiling": 101, "max_cost": 110, "budget": 500, "allow_long": True}
    if not isinstance(request, dict) or set(request) - set(defaults):
        raise ValueError("invalid_demo_fields")
    value = {**defaults, **request}
    if not isinstance(value["scenario"], str) or value["scenario"] not in SCENARIOS:
        raise ValueError("invalid_scenario")
    for field in ("allowed_market", "request_market"):
        if value[field] not in ("mock:BTC/USDT", "mock:ETH/USDT"):
            raise ValueError("invalid_market")
    for field in ("amount", "ceiling", "max_cost", "budget"):
        if type(value[field]) is not int or not 1 <= value[field] <= 1000:
            raise ValueError("amount_must_be_integer_1_to_1000")
    if type(value["allow_long"]) is not bool:
        raise ValueError("invalid_long_permission")
    return value


def run_demo(output: Path, request: dict | None = None) -> dict:
    options = validate_request({} if request is None else request)
    scenario = options["scenario"]
    binary = shutil.which("anvil")
    if not binary:
        installed = Path.home() / ".foundry" / "bin" / ("anvil.exe" if __import__("os").name == "nt" else "anvil")
        binary = str(installed) if installed.is_file() else None
    artifact_path = Path(__file__).resolve().parents[2] / "contracts/mandates/out/NeryaMandateVerifier.sol/NeryaMandateVerifier.json"
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

        def authorization_call(plan):
            e = plan.meta["signed_mandate"]
            return contract.functions.authorize(
                tuple(e["policy"][n] for n, _ in POLICY_FIELDS), e["policy_signature"],
                tuple(e["action"][n] for n, _ in ACTION_FIELDS), e["action_signature"],
            )

        def authorize(plan):
            return transact(authorization_call(plan))

        results = []
        def execute(label, plan, receipt=None, expected="rejected", *, resume=False):
            # Count durable executor creations, not just a UI flag.
            before = _ledger_observation(cfg.paths)
            out = submit_trade_plan(cfg, plan, market_snapshot={"price": 100, "age_s": 0, "source": "local_demo_synthetic"}, resume=resume)
            after = _ledger_observation(cfg.paths)
            if expected is not None:
                assert out["status"] == expected, "Unexpected demo outcome"
            assert out["status"] in ("filled", "rejected"), "Unexpected demo outcome"
            if out["status"] == "rejected": assert before == after, "DENY changed execution records"
            results.append({"case": label, "status": out["status"], "new_executors": after["executors"]-before["executors"],
                            "new_orders": after["orders"]-before["orders"], "new_fills": after["fills"]-before["fills"],
                            "authorization_tx": Web3.to_hex(receipt.transactionHash) if receipt is not None else None,
                            "authorization_tx_status": receipt.status if receipt is not None else None,
                            "result": out})

        revocation_tx = None
        budget_steps = []
        reconciliation = None
        if scenario == "budget":
            for step, amount in enumerate((100, 99, 98), start=1):
                # Distinct notionals exercise the normal entry without tripping
                # its duplicate-intent guard. Every action has a $101 ceiling.
                plan = make(step, size=amount, policy_override={"budget": 220_000_000})
                chain_reason = None
                if step == 3:
                    from web3.exceptions import ContractLogicError
                    try:
                        authorization_call(plan).call({"from": addresses["demo-owner"]})
                    except ContractLogicError as exc:
                        if "session_budget_exceeded" not in str(exc):
                            raise
                        chain_reason = "session_budget_exceeded"
                    assert chain_reason, "Third authorization unexpectedly allowed"
                receipt = authorize(plan)
                assert receipt.status == (0 if step == 3 else 1)
                execute(f"Budget step {step}", plan, receipt, "rejected" if step == 3 else "filled")
                results[-1]["chain_reason"] = chain_reason
                ph = plan.meta["signed_mandate"]["action"]["policyHash"]
                chain_spent = contract.functions.spent(bytes.fromhex(ph[2:])).call()
                with closing(sqlite3.connect(cfg.paths.db.with_name("mandates.sqlite"))) as con:
                    local_spent = sum(int(r[0]) for r in con.execute("SELECT cost FROM claims WHERE policy_hash=?", (ph,)))
                assert chain_spent == local_spent == min(step, 2) * 101_000_000
                observation = _ledger_observation(cfg.paths)
                assert observation["fills"] == min(step, 2)
                budget_steps.append({"step": step, "policy_hash": ph, "notional_usd": amount,
                    "ceiling": 101_000_000, "budget": 220_000_000, "chain_spent": chain_spent,
                    "local_spent": local_spent, "remaining": 220_000_000-chain_spent,
                    "chain_reason": chain_reason, "block_number": web3.eth.block_number,
                    "fills": observation["fills"], "fill_cost_usd": observation["fill_cost_usd"]})
        if scenario == "reconciliation":
            from nerya.trading.reconciliation import reconcile_local

            baseline = make(1)
            receipt = authorize(baseline); assert receipt.status == 1
            execute("ALLOW: fill before fault injection", baseline, receipt, "filled")
            clean = reconcile_local(cfg.paths, account_id="mandate_paper")
            assert not clean.issues, "Baseline must reconcile before injecting a fault"
            with closing(connect(cfg.paths.db)) as con:
                position = con.execute("SELECT position_id, size_base FROM positions WHERE account_id=? AND closed_at IS NULL", ("mandate_paper",)).fetchone()
                assert position is not None
                # Deliberate test fault in the isolated local projection only.
                con.execute("UPDATE positions SET size_base=size_base+0.25 WHERE position_id=?", (position["position_id"],))
                con.commit()
            detected = _halt_demo_on_drift(cfg)
            assert any(i["kind"] == "position_fill_drift" for i in detected["issues"])
            cfg = load_config(cfg.paths.root)
            assert cfg.kill_switch(), "Stop must survive reloading persisted configuration"
            next_plan = make(2, size=90, cost=91_000_000)
            receipt = authorize(next_plan); assert receipt.status == 1
            execute("DENY: persisted stop after reconciliation drift", next_plan, receipt)
            assert "kill_switch_enabled" in results[-1]["result"]["risk_decision"]["reasons"]
            # A repeated request after reloading cannot clear the stop either.
            cfg = load_config(cfg.paths.root)
            execute("DENY: retry after reloading stopped workspace", next_plan, resume=True)
            assert "kill_switch_enabled" in results[-1]["result"]["risk_decision"]["reasons"]
            reconciliation = {"fault_injected": True, "injected_delta_base": 0.25,
                "baseline_report_id": clean.report_id, "report": detected,
                "halt_persisted": cfg.kill_switch(), "scope": "isolated_demo_workspace",
                "automatic_resume": False, "blocked_attempts": 2}
        if scenario in ("suite", "allowed", "tamper", "replay"):
            allowed = make(1)
            receipt = authorize(allowed); assert receipt.status == 1
            execute("ALLOW: signed and anchored action", allowed, receipt, "filled")
        if scenario in ("suite", "market"):
            forbidden = make(2, policy_override={"market": hash_text("mock:ETH/USDT"), "nonce": 3})
            receipt = authorize(forbidden); assert receipt.status == 0
            execute("DENY: user changes allowed market to ETH; BTC request stops", forbidden, receipt)
        if scenario in ("suite", "fees"):
            fees = make(3, size=99, cost=99_000_000)
            receipt = authorize(fees); assert receipt.status == 1
            execute("DENY: fees and slippage exceed signed ceiling", fees, receipt)
        if scenario in ("suite", "long"):
            long = make(4, policy_override={"nonce": 2, "allowLong": False})
            receipt = authorize(long); assert receipt.status == 0
            execute("DENY: long opening prohibited", long, receipt)
        if scenario in ("suite", "tamper"):
            tampered = deepcopy(allowed); tampered.sizing.fixed_usd = 777
            execute("DENY: plan changed after signing", tampered)
        if scenario in ("suite", "replay"):
            execute("DENY: replay through resume path", allowed, resume=True)
        if scenario in ("suite", "revoke"):
            revoked = make(5, size=80, cost=81_000_000)
            receipt = authorize(revoked); assert receipt.status == 1
            revoke_receipt = transact(contract.functions.revoke(tuple(policy[n] for n, _ in POLICY_FIELDS)))
            assert revoke_receipt.status == 1
            revocation_tx = Web3.to_hex(revoke_receipt.transactionHash)
            execute("DENY: user revoked previously anchored policy", revoked, receipt)
        if scenario == "custom":
            custom = make(1, size=options["amount"], cost=options["ceiling"] * 1_000_000,
                          market=options["request_market"], policy_override={
                              "market": hash_text(options["allowed_market"]),
                              "maxCost": options["max_cost"] * 1_000_000,
                              "budget": options["budget"] * 1_000_000, "allowLong": options["allow_long"]})
            receipt = authorize(custom)
            execute("Custom policy and action", custom, receipt, expected=None)

        events = contract.events.ActionAuthorized.get_logs(from_block=0)
        report = {"environment": "ephemeral local Anvil; paper execution; synthetic market data",
                  "public_testnet": False, "human_wallet_approval": False,
                  "signing": "isolated demo keys in SecretVault; actual ECDSA, automated test owner",
                  "settings": settings, "domain": d, "cases": results,
                  "revocation_tx": revocation_tx,
                  "budget_steps": budget_steps, "reconciliation": reconciliation,
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
<p>撤销交易：<code>{html.escape(report['revocation_tx'] or '—')}</code></p><p><a href="evidence.json">完整证据 JSON：签名、Typed Data、交易收据、合约事件与运行日志</a></p>
<details><summary>查看逐例结果</summary><pre>{html.escape(json.dumps(results, ensure_ascii=False, indent=2))}</pre></details></html>"""
        (output / "report.html").write_text(page, encoding="utf-8")
        return {"report": str(output / "report.html"), "evidence": str(output / "evidence.json"),
                "cases": len(results), "public_testnet": False}
    finally:
        process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill(); process.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="New directory; never an existing workspace")
    parser.add_argument("--publish-dashboard", action="store_true", help="Publish public demo fields to the local dashboard")
    parser.add_argument("--scenario", choices=sorted(SCENARIOS), default="suite", help="Isolated scenario to run")
    args = parser.parse_args()
    summary = run_demo(args.output.resolve(), {"scenario": args.scenario})
    if args.publish_dashboard:
        from .mandate_demo_export import publish
        summary["dashboard_snapshot"] = str(publish(Path(summary["evidence"])))
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
