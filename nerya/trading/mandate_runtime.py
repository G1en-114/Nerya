"""Opt-in signed authorization at the trade-plan boundary.

v1 intentionally supports only synchronous mock-venue paper market orders.
Unsupported routes (including wallets, live trading, protection and delayed
orders) fail closed on enrolled accounts. No existing RiskGate/ApprovalGate is
bypassed. RPC reads never sign or broadcast transactions.
"""

from __future__ import annotations

import json
import sqlite3
import time
from copy import deepcopy
from contextlib import closing
from dataclasses import dataclass
from typing import Any

from ..core import jsonl
from ..core.time import now_iso


def _audit(config, plan, decision: dict) -> None:
    jsonl.append(config.paths.journal("mandates"), {
        "ts": now_iso(), "plan_id": plan.plan_id, "account_id": plan.account_id,
        "strategy_id": plan.strategy_id, **decision,
    })


def _rejection(config, plan, reason: str, **evidence) -> dict:
    decision = {"decision": "DENY", "reason": reason, "executor_called": False, **evidence}
    _audit(config, plan, decision)
    return {"status": "rejected", "plan_id": plan.plan_id,
            "execution_blocker": f"mandate:{reason}", "mandate_decision": decision}


@dataclass
class MandateContext:
    settings: dict
    envelope: dict
    domain: dict
    original_hash: str


def _candidate_hash(candidate) -> str:
    from ..security.mandates import hash_text
    value = candidate.asdict()
    for key in ("reservation_id", "executor_id", "client_order_id"):
        value.pop(key, None)
    return hash_text(json.dumps(value, sort_keys=True, allow_nan=False, separators=(",", ":")))


def prepare(config, plan) -> MandateContext | dict | None:
    """Configuration, not caller metadata, determines required authorization."""
    settings = config.get("trading.signed_mandates", {})
    envelope = (plan.meta or {}).get("signed_mandate")
    if not settings and envelope is None:
        return None
    if not isinstance(settings, dict) or not isinstance(settings.get("accounts", {}), dict):
        return _rejection(config, plan, "invalid_operator_configuration")
    owner = settings.get("accounts", {}).get(plan.account_id)
    if owner is None:
        return _rejection(config, plan, "account_not_enrolled") if envelope is not None else None
    try:
        from ..security.mandates import (
            MandateDenied, domain, hash_text, plan_hash, scope_hash, validate_envelope,
        )
        from .accounts import get_account_profile

        d = domain(chain_id=settings["chain_id"], verifier=settings["verifier"], workspace=settings["workspace"])
        p, a, _, _ = validate_envelope(d, envelope, owner=owner, now=int(time.time()))
        original_hash = plan_hash(plan)
        if p["scope"].lower() != scope_hash(plan.account_id, plan.strategy_id):
            raise MandateDenied("scope_mismatch")
        if a["planHash"].lower() != original_hash:
            raise MandateDenied("plan_tampered")
        if a["market"].lower() != hash_text(plan.market):
            raise MandateDenied("market_mismatch")
        opens_long = plan.action == "open_position" and plan.side == "long"
        if a["opensLong"] != opens_long:
            raise MandateDenied("action_direction_mismatch")
        profile = get_account_profile(config.paths, plan.account_id)
        # Explicitly bounded prototype: never silently fall through into a
        # wallet, live connector, protection or asynchronous execution route.
        if profile.mode != "paper" or profile.venue != "mock":
            raise MandateDenied("paper_mock_only")
        if (plan.action not in ("open_position", "close_position", "reduce_position")
                or plan.side not in ("long", "short")
                or plan.entry.order_type != "market" or plan.protection is not None
                or plan.sizing.method not in ("fixed_usd", "fixed_base")
                or plan.entry.time_in_force != "gtc"
                or set(plan.meta or {}) - {"signed_mandate"}):
            raise MandateDenied("unsupported_plan")
        return MandateContext(deepcopy(settings), deepcopy(envelope), d, original_hash)
    except ImportError:
        return _rejection(config, plan, "mandate_dependencies_unavailable")
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        reason = str(exc) if isinstance(exc, MandateDenied) else "invalid_mandate_configuration_or_payload"
        return _rejection(config, plan, reason)


def check_anchor(settings: dict, policy_hash: str, action_hash: str) -> dict:
    """Read one pinned block. An unavailable/untrusted chain always fails closed.

    The operator pins chain, verifier address, deployed runtime-code hash and
    workspace salt. RPC is a trusted read dependency in this prototype; this
    function is not a light client / independent consensus proof.
    """
    import httpx
    from eth_abi import encode, decode
    from eth_utils import keccak
    from ..security.mandates import MandateDenied

    try:
        with httpx.Client(timeout=5, trust_env=False) as client:
            def rpc(method, params):
                response = client.post(settings["rpc_url"], json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
                response.raise_for_status()
                value = response.json()
                if value.get("error") or "result" not in value:
                    raise MandateDenied("anchor_rpc_error")
                return value["result"]

            if int(rpc("eth_chainId", []), 16) != settings["chain_id"]:
                raise MandateDenied("anchor_chain_mismatch")
            block = rpc("eth_getBlockByNumber", ["latest", False])
            tag = block["number"]
            code = bytes.fromhex(rpc("eth_getCode", [settings["verifier"], tag])[2:])
            if not code or "0x" + keccak(code).hex() != settings["runtime_code_hash"].lower():
                raise MandateDenied("anchor_code_mismatch")

            def read(signature, kinds=(), values=(), result_type="bool"):
                data = keccak(text=signature)[:4] + encode(list(kinds), list(values))
                raw = rpc("eth_call", [{"to": settings["verifier"], "data": "0x" + data.hex()}, tag])
                return decode([result_type], bytes.fromhex(raw[2:]))[0]

            if read("workspace()", result_type="bytes32").hex() != settings["workspace"][2:].lower():
                raise MandateDenied("anchor_workspace_mismatch")
            ph, ah = bytes.fromhex(policy_hash[2:]), bytes.fromhex(action_hash[2:])
            if read("revoked(bytes32)", ("bytes32",), (ph,)):
                raise MandateDenied("mandate_revoked")
            if not read("authorized(bytes32,bytes32)", ("bytes32", "bytes32"), (ph, ah)):
                raise MandateDenied("action_not_anchored")
            return {"chain_id": settings["chain_id"], "verifier": settings["verifier"],
                    "block_number": int(tag, 16), "block_hash": block["hash"],
                    "block_timestamp": int(block["timestamp"], 16)}
    except MandateDenied:
        raise
    except Exception:
        # URLs can contain credentials. Never return raw transport exceptions.
        raise MandateDenied("anchor_unavailable") from None


def consume(config, plan, candidate, ctx: MandateContext) -> dict:
    """Verify immediately before reservation/executor creation, atomically claim.

    No refund/retry is automatic after claiming: crash/uncertain outcome retains
    the nonce and full signed cost. Use a fresh, explicitly signed action.
    """
    from ..security.mandates import MandateDenied, cost_units, validate_envelope, plan_hash
    from .accounts import get_account_profile
    from .executors.market_order import _PAPER_FEE_BPS, _PAPER_SLIPPAGE_BPS

    evidence: dict[str, Any] = {}
    try:
        if config.get("trading.signed_mandates", {}) != ctx.settings:
            raise MandateDenied("configuration_changed")
        profile = get_account_profile(config.paths, plan.account_id)
        if profile.mode != "paper" or profile.venue != "mock":
            raise MandateDenied("paper_mock_only")
        if plan_hash(plan) != ctx.original_hash:
            raise MandateDenied("plan_changed_during_validation")
        p, a, ph, ah = validate_envelope(ctx.domain, ctx.envelope,
            owner=ctx.settings["accounts"][plan.account_id], now=int(time.time()))
        evidence = {"policy_hash": ph, "action_hash": ah, "plan_hash": ctx.original_hash}
        # Include the actual simulator's fee and slippage, not just the budget
        # checker's possibly lower estimate. This is a cost ceiling, not P&L.
        fee = max(candidate.estimated_fee_usd, candidate.notional_usd * _PAPER_FEE_BPS / 10000)
        estimated = cost_units(candidate.notional_usd, fee, _PAPER_SLIPPAGE_BPS)
        if estimated <= 0 or estimated > a["cost"]:
            raise MandateDenied("resolved_cost_exceeds_signed_ceiling")
        evidence["resolved_cost_micro_usd"] = estimated
        evidence["signed_ceiling_micro_usd"] = a["cost"]
        anchor = check_anchor(ctx.settings, ph, ah)
        # Expiry is checked against both runtime time and the observed chain.
        validate_envelope(ctx.domain, ctx.envelope,
            owner=ctx.settings["accounts"][plan.account_id],
            now=max(int(time.time()), anchor["block_timestamp"]))
        evidence["anchor"] = anchor
        db = config.paths.db.with_name("mandates.sqlite")
        db.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(db, timeout=10)) as con:
            con.execute("CREATE TABLE IF NOT EXISTS claims (policy_hash TEXT, nonce TEXT, action_hash TEXT UNIQUE, cost TEXT, plan_id TEXT UNIQUE, candidate_hash TEXT, envelope TEXT, started INTEGER DEFAULT 0, PRIMARY KEY(policy_hash, nonce))")
            con.execute("BEGIN IMMEDIATE")
            if con.execute("SELECT 1 FROM claims WHERE policy_hash=? AND nonce=?", (ph, str(a["nonce"]))).fetchone():
                raise MandateDenied("action_replayed")
            used = sum(int(row[0]) for row in con.execute("SELECT cost FROM claims WHERE policy_hash=?", (ph,)))
            if used + a["cost"] > p["budget"]:
                raise MandateDenied("session_budget_exceeded")
            con.execute("INSERT INTO claims VALUES(?,?,?,?,?,?,?,0)",
                (ph, str(a["nonce"]), ah, str(a["cost"]), plan.plan_id,
                 _candidate_hash(candidate), json.dumps(ctx.envelope)))
            con.commit()
        decision = {"decision": "ALLOW", "stage": "authorization_consumed", **evidence,
                    "signed_envelope": ctx.envelope}
        _audit(config, plan, decision)
        return decision
    except (MandateDenied, sqlite3.Error, ValueError, TypeError, KeyError) as exc:
        reason = str(exc) if isinstance(exc, MandateDenied) else "mandate_state_unavailable"
        return _rejection(config, plan, reason, **evidence)


def execution_blocker(paths, candidate, executor_id: str) -> str | None:
    """Recheck persisted authorization at the actual paper fill boundary.

    Covers executor recovery/direct creation, not only the initial submit call.
    A claim is single-use even if the process crashes before recording a fill.
    """
    from ..core.config import load_config

    try:
        config = load_config(paths.root)
        settings = config.get("trading.signed_mandates", {})
        envelope_present = "signed_mandate" in (candidate.meta or {})
        if not settings and not envelope_present:
            return None
        if not isinstance(settings, dict) or not isinstance(settings.get("accounts", {}), dict):
            return "mandate:invalid_operator_configuration"
        owner = settings.get("accounts", {}).get(candidate.account_id)
        if owner is None:
            return "mandate:account_not_enrolled" if envelope_present else None
        from ..security.mandates import MandateDenied, domain, scope_hash, validate_envelope
        from .accounts import get_account_profile

        profile = get_account_profile(paths, candidate.account_id)
        if config.kill_switch() or not profile.can_place_order:
            raise MandateDenied("execution_disabled")
        if profile.mode != "paper" or profile.venue != "mock" or candidate.order_type != "market":
            raise MandateDenied("paper_mock_only")
        db = paths.db.with_name("mandates.sqlite")
        if not db.is_file():
            raise MandateDenied("unclaimed_action")
        with closing(sqlite3.connect(db, timeout=10)) as con:
            con.row_factory = sqlite3.Row
            con.execute("BEGIN IMMEDIATE")
            row = con.execute("SELECT * FROM claims WHERE plan_id=?", (candidate.plan_id,)).fetchone()
            if row is None or row["candidate_hash"] != _candidate_hash(candidate):
                raise MandateDenied("unclaimed_or_modified_candidate")
            if row["started"]:
                raise MandateDenied("execution_already_started")
            d = domain(chain_id=settings["chain_id"], verifier=settings["verifier"], workspace=settings["workspace"])
            env = json.loads(row["envelope"])
            p, _, ph, ah = validate_envelope(d, env, owner=owner, now=int(time.time()))
            if p["scope"].lower() != scope_hash(candidate.account_id, candidate.strategy_id):
                raise MandateDenied("scope_mismatch")
            anchor = check_anchor(settings, ph, ah)
            validate_envelope(d, env, owner=owner, now=max(int(time.time()), anchor["block_timestamp"]))
            con.execute("UPDATE claims SET started=1 WHERE plan_id=?", (candidate.plan_id,))
            con.commit()
        jsonl.append(paths.journal("mandates"), {
            "ts": now_iso(), "stage": "execution_boundary_allowed", "executor_id": executor_id,
            "plan_id": candidate.plan_id, "policy_hash": ph, "action_hash": ah, "anchor": anchor,
        })
        return None
    except Exception as exc:
        # Never expose RPC credentials, raw signatures, config or DB errors.
        reason = str(exc) if type(exc).__name__ == "MandateDenied" else "execution_verification_unavailable"
        jsonl.append(paths.journal("mandates"), {
            "ts": now_iso(), "stage": "execution_boundary_denied", "decision": "DENY",
            "executor_id": executor_id, "plan_id": candidate.plan_id, "reason": reason,
            "order_submitted": False,
        })
        return f"mandate:{reason}"
