"""Operator CLI for testnet evidence anchors."""

from __future__ import annotations

import os

from .._common import _add_ws, _client, _print
from ...trading.chain_evidence import (
    anchor_decision, decision_evidence, evidence_hash, verify_anchor,
)


def _run(args) -> int:
    paths = _client(args.workspace, getattr(args, "profile", None)).config.paths
    try:
        if args.action == "prepare":
            evidence = decision_evidence(paths, args.strategy_id, args.session_id)
            _print({"record_hash": evidence_hash(evidence), "evidence": evidence})
            return 0
        rpc_url = os.environ.get(args.rpc_url_env, "").strip()
        if not rpc_url:
            raise ValueError("RPC URL environment variable is empty")
        if args.action == "anchor":
            result = anchor_decision(paths, args.strategy_id, args.session_id,
                                     chain=args.chain, rpc_url=rpc_url,
                                     signer_ref=args.signer_ref)
        else:
            result = verify_anchor(paths, args.strategy_id, args.session_id,
                                   chain=args.chain, rpc_url=rpc_url)
        _print(result)
        return 0 if result.get("verified", True) else 1
    except Exception as exc:
        # RPC URLs and private keys may be embedded in transport errors.
        _print({"ok": False, "error": type(exc).__name__,
                "detail": "chain evidence operation failed; check local configuration and journal"})
        return 1


def register(sub) -> None:
    actions = sub.add_parser("chain-evidence", help="Anchor a persisted risk decision on an EVM testnet")
    actions = actions.add_subparsers(dest="action", required=True)
    for action in ("prepare", "anchor", "verify"):
        p = actions.add_parser(action)
        _add_ws(p)
        p.add_argument("--strategy-id", required=True)
        p.add_argument("--session-id", required=True)
        if action != "prepare":
            p.add_argument("--chain", choices=("sepolia", "base-sepolia"), required=True)
            p.add_argument("--rpc-url-env", default="NERYA_TESTNET_RPC_URL")
        if action == "anchor":
            p.add_argument("--signer-ref", required=True, help="vault:// ref with chain_audit scope")
        p.set_defaults(func=_run)
