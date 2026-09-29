"""No network: real ECDSA signatures, fake chain reads, actual paper pipeline."""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import time

import pytest

pytest.importorskip("eth_account")
from eth_account import Account

from nerya.core import jsonl, yaml_io
from nerya.core.config import Config, DEFAULT_CONFIG
from nerya.core.paths import WorkspacePaths
from nerya.security.mandates import (
    MandateDenied, cost_units, digest, domain, hash_text, plan_hash, scope_hash, sign, validate_envelope,
)
from nerya.trading import mandate_runtime
from nerya.trading.order_intents import OrderCandidate, SizingPolicy, TradePlan
from nerya.trading.submit import submit_trade_plan

pytestmark = pytest.mark.smoke
REAL_CHECK_ANCHOR = mandate_runtime.check_anchor


@pytest.fixture
def harness(tmp_path, monkeypatch):
    owner, agent = Account.create(), Account.create()
    cfg = Config(paths=WorkspacePaths(root=tmp_path), data=deepcopy(DEFAULT_CONFIG))
    cfg.data.setdefault("trading", {})["signed_mandates"] = {
        "accounts": {"paper_main": owner.address}, "chain_id": 31337,
        "verifier": "0x" + "12" * 20, "workspace": hash_text(str(tmp_path)),
        "rpc_url": "http://unused.invalid", "runtime_code_hash": "0x" + "34" * 32,
    }
    yaml_io.dump(tmp_path / "nerya.yml", cfg.data)
    yaml_io.dump(cfg.paths.accounts_file, {"accounts": [{
        "id": "paper_main", "exchange": "mock", "venue": "mock", "mode": "paper",
        "status": "active", "initial_balance_usd": 10000,
        "permissions": {"read_balances": True, "place_order": True, "cancel_order": True},
    }]})
    yaml_io.dump(cfg.paths.strategy("s1") / "strategy.yml", {
        "id": "s1", "status": "paper", "account_id": "paper_main",
        "markets": ["mock:BTC/USDT", "mock:ETH/USDT"], "paper_trading_enabled": True,
        "live_trading_enabled": False,
    })
    yaml_io.dump(cfg.paths.strategy("s1") / "limits.yml", {
        "allowed_markets": ["mock:BTC/USDT", "mock:ETH/USDT"], "min_confidence": 0,
        "max_stale_seconds": 60, "approval_threshold_usd": 0,
    })
    d = domain(chain_id=31337, verifier="0x" + "12" * 20, workspace=hash_text(str(tmp_path)))
    now = int(time.time())
    policy = {"owner": owner.address, "agent": agent.address,
              "scope": scope_hash("paper_main", "s1"), "market": hash_text("mock:BTC/USDT"),
              "maxCost": 110_000_000, "budget": 220_000_000,
              "validAfter": now - 10, "validUntil": now + 3600, "nonce": 1, "allowLong": True}

    def make(*, size=100, market="mock:BTC/USDT", nonce=1, cost=101_000_000, policy_override=None, **kwargs):
        plan = TradePlan(strategy_id="s1", account_id="paper_main", market=market,
                         sizing=SizingPolicy(method="fixed_usd", fixed_usd=size), confidence=1,
                         source="strategy_runtime", **kwargs)
        p = {**policy, **(policy_override or {})}
        a = {"policyHash": digest(d, "Policy", p), "planHash": plan_hash(plan),
             "market": hash_text(market), "cost": cost,
             "opensLong": plan.action == "open_position" and plan.side == "long",
             "nonce": nonce, "validUntil": p["validUntil"]}
        plan.meta["signed_mandate"] = {"policy": p, "action": a,
            "policy_signature": sign(d, "Policy", p, owner.key),
            "action_signature": sign(d, "Action", a, agent.key)}
        return plan

    monkeypatch.setattr(mandate_runtime, "check_anchor", lambda *args: {
        "chain_id": 31337, "block_number": 1, "block_hash": "0x" + "ab" * 32,
        "block_timestamp": int(time.time()),
    })
    return cfg, make, d, owner, agent


def submit(cfg, plan):
    return submit_trade_plan(cfg, plan, market_snapshot={"price": 100, "age_s": 0, "source": "test"})


def forbid_executor(monkeypatch):
    def fail(*args, **kwargs):
        pytest.fail("DENY reached the executor")
    monkeypatch.setattr("nerya.trading.submit.ExecutorOrchestrator.create_market_order", fail)


def test_signed_paper_order_fills_and_preserves_public_evidence(harness):
    cfg, make, *_ = harness
    out = submit(cfg, make())
    assert out["status"] == "filled", out
    assert out["mandate_decision"]["executor_called"] is True
    assert out["mandate_decision"]["resolved_cost_micro_usd"] > 100_000_000
    records = jsonl.read_all(cfg.paths.journal("mandates"))
    assert records[-1]["executor_id"] == out["executor_id"]
    assert records[-1]["action_hash"] == out["mandate_decision"]["action_hash"]


@pytest.mark.parametrize("case,reason", [
    ("missing", "missing_or_invalid_mandate"), ("policy_tamper", "invalid_policy_signature"),
    ("action_tamper", "invalid_action_signature"), ("plan_tamper", "plan_tampered"),
    ("market", "market_not_allowed"), ("cost", "action_cost_exceeded"),
    ("fees", "resolved_cost_exceeds_signed_ceiling"), ("expired", "mandate_expired_or_not_yet_valid"),
    ("long", "long_opening_not_allowed"), ("wrong_agent", "invalid_action_signature"),
    ("wrong_owner", "untrusted_owner"), ("scope", "scope_mismatch"),
])
def test_denials_never_create_executor(harness, monkeypatch, case, reason):
    cfg, make, d, owner, agent = harness
    plan = make()
    e = plan.meta["signed_mandate"]
    if case == "missing": plan.meta.clear()
    elif case == "policy_tamper": e["policy"]["budget"] += 1
    elif case == "action_tamper": e["action"]["cost"] += 1
    elif case == "plan_tamper": plan.sizing.fixed_usd = 500
    elif case == "market": plan = make(market="mock:ETH/USDT")
    elif case == "cost": plan = make(cost=111_000_000)
    elif case == "fees": plan = make(cost=100_000_000)
    elif case == "expired": plan = make(policy_override={"validUntil": int(time.time()) - 1})
    elif case == "long": plan = make(policy_override={"allowLong": False})
    elif case == "wrong_agent": e["action_signature"] = sign(d, "Action", e["action"], owner.key)
    elif case == "wrong_owner": cfg.data["trading"]["signed_mandates"]["accounts"]["paper_main"] = agent.address
    elif case == "scope": plan = make(policy_override={"scope": scope_hash("other", "s1")})
    forbid_executor(monkeypatch)
    out = submit(cfg, plan)
    assert out["execution_blocker"] == f"mandate:{reason}", out
    assert out["mandate_decision"]["executor_called"] is False
    assert jsonl.read_all(cfg.paths.journal("mandates"))[-1]["decision"] == "DENY"


def test_chain_failure_and_revocation_fail_closed(harness, monkeypatch):
    cfg, make, *_ = harness
    forbid_executor(monkeypatch)
    for reason in ("anchor_unavailable", "mandate_revoked", "action_not_anchored"):
        def reject(*args): raise MandateDenied(reason)
        monkeypatch.setattr(mandate_runtime, "check_anchor", reject)
        assert submit(cfg, make(size=10 + len(reason)))["execution_blocker"] == f"mandate:{reason}"


def test_existing_kill_switch_cannot_be_overridden_by_signatures(harness, monkeypatch):
    cfg, make, *_ = harness
    cfg.data["runtime"]["kill_switch"] = True
    forbid_executor(monkeypatch)
    out = submit(cfg, make())
    assert "kill_switch_enabled" in out["risk_decision"]["reasons"]


def test_existing_operator_approval_is_not_replaced_by_signatures(harness, monkeypatch):
    cfg, make, *_ = harness
    cfg.data["trading"]["strategy_orders"] = {"auto_approve_escalations": False}
    limits = cfg.paths.strategy("s1") / "limits.yml"
    data = yaml_io.load(limits); data["approval_threshold_usd"] = 1; yaml_io.dump(limits, data)
    forbid_executor(monkeypatch)
    assert submit(cfg, make())["status"] == "pending_approval"


def test_runtime_budget_and_nonce_are_durable_and_atomic(harness):
    cfg, make, *_ = harness
    plan = make()
    ctx = mandate_runtime.prepare(cfg, plan)
    candidate = OrderCandidate(account_id="paper_main", strategy_id="s1", market=plan.market,
                               side="buy", notional_usd=100, size_base=1, order_type="market")
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(lambda _: mandate_runtime.consume(cfg, plan, candidate, ctx), range(2)))
    assert sum(o.get("decision") == "ALLOW" for o in outcomes) == 1
    assert sum(o.get("execution_blocker") == "mandate:action_replayed" for o in outcomes) == 1
    # Reconstruct context like a restarted process; same nonce still refused.
    assert mandate_runtime.consume(cfg, plan, candidate, mandate_runtime.prepare(cfg, plan))["status"] == "rejected"
    second = make(nonce=2)
    assert mandate_runtime.consume(cfg, second, candidate, mandate_runtime.prepare(cfg, second))["decision"] == "ALLOW"
    third = make(nonce=3)
    assert mandate_runtime.consume(cfg, third, candidate, mandate_runtime.prepare(cfg, third))["execution_blocker"] == "mandate:session_budget_exceeded"


def test_buy_to_reduce_short_is_not_misclassified_as_long(harness):
    cfg, make, *_ = harness
    p = make(action="reduce_position", side="short", policy_override={"allowLong": False})
    assert p.buy_or_sell == "buy"
    assert isinstance(mandate_runtime.prepare(cfg, p), mandate_runtime.MandateContext)


@pytest.mark.parametrize("field,value", [("chainId", 1), ("salt", "0x" + "ff" * 32), ("verifyingContract", "0x" + "56" * 20)])
def test_cross_domain_replay_is_rejected(harness, field, value):
    _, make, d, owner, _ = harness
    with pytest.raises(MandateDenied, match="invalid_policy_signature"):
        validate_envelope({**d, field: value}, make().meta["signed_mandate"], owner=owner.address, now=int(time.time()))


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), -1, True])
def test_nonfinite_cost_is_rejected(bad):
    with pytest.raises(MandateDenied): cost_units(bad, 0)


def test_unenrolled_account_keeps_existing_behavior(harness):
    cfg, make, *_ = harness
    cfg.data["trading"].pop("signed_mandates")
    yaml_io.dump(cfg.paths.root / "nerya.yml", cfg.data)
    plan = make(); plan.meta.clear()
    assert submit(cfg, plan)["status"] == "filled"


def test_unsupported_route_cannot_bypass_enrollment(harness, monkeypatch):
    cfg, make, d, _, agent = harness
    plan = make(); plan.action = "attach_protection"
    e = plan.meta["signed_mandate"]; e["action"]["planHash"] = plan_hash(plan); e["action"]["opensLong"] = False
    e["action_signature"] = sign(d, "Action", e["action"], agent.key)
    forbid_executor(monkeypatch)
    assert submit(cfg, plan)["execution_blocker"] == "mandate:unsupported_plan"


def test_approval_resume_cannot_replay_claimed_action(harness, monkeypatch):
    cfg, make, *_ = harness
    plan = make()
    assert submit(cfg, plan)["status"] == "filled"
    forbid_executor(monkeypatch)
    out = submit_trade_plan(cfg, plan, resume=True,
        market_snapshot={"price": 100, "age_s": 0, "source": "test"})
    assert out["execution_blocker"] == "mandate:action_replayed"


@pytest.mark.parametrize("case", ["revoke", "tamper", "live", "kill_switch"])
def test_executor_rechecks_after_authorization(harness, monkeypatch, case):
    cfg, make, *_ = harness
    from nerya.trading.executors.orchestrator import ExecutorOrchestrator
    original = ExecutorOrchestrator.create_market_order

    def intercept(self, **kwargs):
        if case == "revoke":
            def revoked(*args): raise MandateDenied("mandate_revoked")
            monkeypatch.setattr(mandate_runtime, "check_anchor", revoked)
        elif case == "tamper":
            kwargs["candidate"].size_base *= 10
        elif case == "live":
            data = yaml_io.load(cfg.paths.accounts_file)
            data["accounts"][0]["mode"] = "live"
            yaml_io.dump(cfg.paths.accounts_file, data)
        elif case == "kill_switch":
            cfg.data["runtime"]["kill_switch"] = True
            yaml_io.dump(cfg.paths.root / "nerya.yml", cfg.data)
        return original(self, **kwargs)

    def no_fill(*args, **kwargs): pytest.fail("Revoked/tampered request reached fill")
    monkeypatch.setattr(ExecutorOrchestrator, "create_market_order", intercept)
    monkeypatch.setattr("nerya.trading.executors.market_order.MarketOrderExecutor._paper_resolve", no_fill)
    monkeypatch.setattr("nerya.trading.executors.market_order.MarketOrderExecutor._submit_live", no_fill)
    out = submit(cfg, make())
    assert out["status"] in ("failed", "rejected"), out
    rows = jsonl.read_all(cfg.paths.journal("mandates"))
    denial = next(r for r in rows if r.get("stage") == "execution_boundary_denied")
    assert denial["order_submitted"] is False


def test_direct_executor_creation_requires_claim(harness, monkeypatch):
    cfg, _, *_ = harness
    from contextlib import closing
    from nerya.trading.executors.orchestrator import ExecutorOrchestrator
    candidate = OrderCandidate(account_id="paper_main", strategy_id="s1", market="mock:BTC/USDT",
        side="buy", notional_usd=100, size_base=1, order_type="market", plan_id="unsigned-plan",
        meta={"mark_price": 100})
    def no_fill(*args, **kwargs): pytest.fail("Direct executor bypassed authorization")
    monkeypatch.setattr("nerya.trading.executors.market_order.MarketOrderExecutor._paper_resolve", no_fill)
    with closing(ExecutorOrchestrator(cfg)) as orchestrator:
        executor = orchestrator.create_market_order(candidate=candidate, plan_id="unsigned-plan")
        run = orchestrator.run_until_terminal(executor)
        assert run.state in ("failed", "rejected")


def test_boundary_claim_cannot_be_started_twice(harness):
    cfg, make, *_ = harness
    plan = make()
    candidate = OrderCandidate(account_id="paper_main", strategy_id="s1", market=plan.market,
        side="buy", notional_usd=100, size_base=1, order_type="market", plan_id=plan.plan_id,
        meta={"signed_mandate": plan.meta["signed_mandate"]})
    assert mandate_runtime.consume(cfg, plan, candidate, mandate_runtime.prepare(cfg, plan))["decision"] == "ALLOW"
    assert mandate_runtime.execution_blocker(cfg.paths, candidate, "first") is None
    assert mandate_runtime.execution_blocker(cfg.paths, candidate, "recovered") == "mandate:execution_already_started"


@pytest.mark.parametrize("scenario,reason", [
    ("valid", None), ("wrong_chain", "anchor_chain_mismatch"),
    ("wrong_code", "anchor_code_mismatch"), ("wrong_workspace", "anchor_workspace_mismatch"),
    ("revoked", "mandate_revoked"), ("missing", "action_not_anchored"),
    ("transport", "anchor_unavailable"),
])
def test_rpc_verification_is_pinned_and_fail_closed(harness, monkeypatch, scenario, reason):
    import httpx
    from eth_abi import encode
    from eth_utils import keccak
    cfg, make, d, *_ = harness
    settings = deepcopy(cfg.data["trading"]["signed_mandates"])
    settings["rpc_url"] = "https://rpc.invalid/private-credential"
    settings["runtime_code_hash"] = "0x" + keccak(b"contract").hex()
    env = make().meta["signed_mandate"]
    ph, ah = digest(d, "Policy", env["policy"]), digest(d, "Action", env["action"])
    selectors = {keccak(text=s)[:4].hex(): s for s in (
        "workspace()", "revoked(bytes32)", "authorized(bytes32,bytes32)")}
    calls = []
    def handle(request):
        import json
        if scenario == "transport": raise httpx.ConnectError("private-credential", request=request)
        call = json.loads(request.content); calls.append(call)
        method, params = call["method"], call["params"]
        if method == "eth_chainId": value = hex(1 if scenario == "wrong_chain" else 31337)
        elif method == "eth_getBlockByNumber": value = {"number": "0x123", "hash": "0x" + "ef" * 32, "timestamp": hex(int(time.time()))}
        elif method == "eth_getCode":
            assert params[1] == "0x123"
            value = "0x" + (b"changed" if scenario == "wrong_code" else b"contract").hex()
        else:
            assert method == "eth_call" and params[1] == "0x123"
            signature = selectors[params[0]["data"][2:10]]
            if signature == "workspace()":
                result = bytes.fromhex(("00" * 32) if scenario == "wrong_workspace" else settings["workspace"][2:])
                value = "0x" + encode(["bytes32"], [result]).hex()
            else:
                result = scenario == "revoked" if signature.startswith("revoked") else scenario != "missing"
                value = "0x" + encode(["bool"], [result]).hex()
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": value})
    original = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda **kwargs: original(transport=httpx.MockTransport(handle)))
    if reason:
        with pytest.raises(MandateDenied, match=reason) as exc:
            REAL_CHECK_ANCHOR(settings, ph, ah)
        assert "private-credential" not in str(exc.value)
    else:
        evidence = REAL_CHECK_ANCHOR(settings, ph, ah)
        assert evidence["block_number"] == 0x123
        assert len(calls) == 6


def test_operator_wallet_request_and_vault_action_roundtrip(harness, tmp_path):
    import json
    from types import SimpleNamespace
    from scripts.mandate_request import export_request
    from nerya.security.secrets import SecretVault
    cfg, make, d, owner, agent = harness
    args = SimpleNamespace(command="policy", workspace=cfg.paths.root, ttl=900, nonce=100,
        account="paper_main", strategy="s1", market="mock:BTC/USDT", agent=agent.address,
        max_cost="110", budget="220", allow_long=True)
    request = export_request(args)
    p = request["policy_typed_data"]["message"]
    # Simulates the wallet's EIP-712 signature; never passes owner key to CLI.
    signed_path = tmp_path / "signed-policy.json"
    signed_path.write_text(json.dumps({"domain": d, "policy": p, "policy_signature": sign(d, "Policy", p, owner.key)}), encoding="utf-8")
    plan = make(); plan.meta.clear()
    plan_path = tmp_path / "plan.json"
    plan_path.write_text(json.dumps(plan.asdict()), encoding="utf-8")
    vault = SecretVault.open(cfg.paths.vault_enc)
    vault.put(name="agent", value=agent.key.hex(), kind="evm_private_key", scope=["mandate:sign"])
    args = SimpleNamespace(command="action", workspace=cfg.paths.root, ttl=300, nonce=1,
        signed_policy=signed_path, plan=plan_path, cost_ceiling="101", agent_key_ref="vault://agent")
    result = export_request(args)
    env = result["plan"]["meta"]["signed_mandate"]
    validate_envelope(d, env, owner=owner.address, now=int(time.time()))
    assert agent.key.hex() not in json.dumps(result)
    assert owner.key.hex() not in json.dumps(result)


def test_operator_cli_requires_scoped_vault_key(harness, tmp_path):
    import json
    from types import SimpleNamespace
    from scripts.mandate_request import export_request
    from nerya.security.secrets import SecretVault
    from nerya.core.errors import SecretAccessDenied
    cfg, make, d, _, agent = harness
    plan = make(); env = plan.meta.pop("signed_mandate")
    signed_path, plan_path = tmp_path / "policy.json", tmp_path / "plan.json"
    signed_path.write_text(json.dumps({"domain": d, "policy": env["policy"], "policy_signature": env["policy_signature"]}), encoding="utf-8")
    plan_path.write_text(json.dumps(plan.asdict()), encoding="utf-8")
    SecretVault.open(cfg.paths.vault_enc).put(name="agent", value=agent.key.hex(), kind="evm_private_key", scope=["unrelated"])
    args = SimpleNamespace(command="action", workspace=cfg.paths.root, ttl=300, nonce=1,
        signed_policy=signed_path, plan=plan_path, cost_ceiling="101", agent_key_ref="vault://agent")
    with pytest.raises(SecretAccessDenied): export_request(args)
