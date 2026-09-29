"""Operator-only helpers for wallet Policy requests and vault-signed Actions.

This exports public JSON only. It does not broadcast or enable live trading.
"""
from __future__ import annotations

import argparse
import json
from decimal import Decimal
from pathlib import Path
import time

from nerya.core.config import load_config
from nerya.security.mandates import (
    MandateDenied, digest, domain, hash_text, plan_hash, scope_hash, sign, typed_data, verify,
)
from nerya.security.secrets import SecretVault
from nerya.trading.mandate_runtime import MandateContext, prepare
from nerya.trading.order_intents import SizingPolicy, TradeEntry, TradePlan


def units(text: str) -> int:
    value = Decimal(text) * 1_000_000
    if not value.is_finite() or value <= 0 or value != value.to_integral_value() or value > 2**53 - 1:
        raise ValueError("Use a positive amount with at most 6 decimals, within safe wallet integer range")
    return int(value)


def export_request(args) -> dict:
    cfg = load_config(args.workspace)
    settings = cfg.get("trading.signed_mandates", {})
    d = domain(chain_id=settings["chain_id"], verifier=settings["verifier"], workspace=settings["workspace"])
    now = int(time.time())
    if not 1 <= args.ttl <= 86400 or not 0 <= args.nonce <= 2**53 - 1:
        raise ValueError("TTL must be 1..86400 seconds; nonce must be a safe unsigned integer")
    if args.command == "policy":
        p = {"owner": settings["accounts"][args.account], "agent": args.agent,
             "scope": scope_hash(args.account, args.strategy), "market": hash_text(args.market),
             "maxCost": units(args.max_cost), "budget": units(args.budget),
             "validAfter": now, "validUntil": now + args.ttl, "nonce": args.nonce,
             "allowLong": args.allow_long}
        if p["budget"] < p["maxCost"]:
            raise ValueError("Budget must cover the single-action ceiling")
        return {"policy_typed_data": typed_data(d, "Policy", p),
                "review_context": {"account": args.account, "strategy": args.strategy, "market": args.market}}

    signed_policy = json.loads(args.signed_policy.read_text(encoding="utf-8-sig"))
    raw = json.loads(args.plan.read_text(encoding="utf-8-sig"))
    plan = TradePlan(**{**raw, "sizing": SizingPolicy(**raw["sizing"]), "entry": TradeEntry(**raw.get("entry", {}))})
    if signed_policy["domain"] != d:
        raise MandateDenied("domain_mismatch")
    p = signed_policy["policy"]
    verify(d, "Policy", p, signed_policy["policy_signature"], settings["accounts"][plan.account_id])
    a = {"policyHash": digest(d, "Policy", p), "planHash": plan_hash(plan),
         "market": hash_text(plan.market), "cost": units(args.cost_ceiling),
         "opensLong": plan.action == "open_position" and plan.side == "long",
         "nonce": args.nonce, "validUntil": min(now + args.ttl, p["validUntil"])}
    if not args.agent_key_ref.startswith("vault://"):
        raise ValueError("Agent key must be a vault:// reference")
    vault = SecretVault.open(cfg.paths.vault_enc)
    signature = sign(d, "Action", a, vault.resolve(args.agent_key_ref[8:], required_scope="mandate:sign"))
    plan.meta["signed_mandate"] = {"policy": p, "policy_signature": signed_policy["policy_signature"],
                                  "action": a, "action_signature": signature}
    result = prepare(cfg, plan)
    if not isinstance(result, MandateContext):
        raise MandateDenied("signed_action_failed_preflight")
    return {"plan": plan.asdict(), "action_typed_data": typed_data(d, "Action", a),
            "policy_typed_data": typed_data(d, "Policy", p)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("policy", "action"):
        sub = commands.add_parser(command)
        sub.add_argument("--workspace", type=Path, required=True)
        sub.add_argument("--output", type=Path, required=True)
        sub.add_argument("--ttl", type=int, default=900)
        sub.add_argument("--nonce", type=int, required=True)
        if command == "policy":
            for name in ("account", "strategy", "market", "agent", "max-cost", "budget"):
                sub.add_argument(f"--{name}", required=True)
            sub.add_argument("--allow-long", action="store_true", help="Explicitly permit new long openings")
        else:
            sub.add_argument("--signed-policy", type=Path, required=True)
            sub.add_argument("--plan", type=Path, required=True)
            sub.add_argument("--cost-ceiling", required=True)
            sub.add_argument("--agent-key-ref", required=True)
    args = parser.parse_args()
    if args.output.exists(): parser.error("Output already exists; choose a new filename")
    try:
        request = export_request(args)
        with args.output.open("x", encoding="utf-8") as stream:
            json.dump(request, stream, ensure_ascii=False, indent=2)
    except Exception as exc:
        # Do not echo provider errors or any private signing material.
        parser.error(f"Request export failed ({type(exc).__name__}); check configuration, public payload and vault scope")
    print(f"Exported public signing request: {args.output}")


if __name__ == "__main__":
    main()
