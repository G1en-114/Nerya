"""One-command GWDC hard-requirement setup for a Nerya workspace.

Competition hard requirements this script serves:

1. Kiln — HTTP calls to the NPU LLM ``gpt-oss-120b`` (OpenAI-compatible API).
2. Blockchain — mandate/decision anchoring on a public testnet with real
   ``tx_hash`` evidence (``python -m nerya.cli.app chain-evidence anchor``).

Subcommands
-----------
kiln       Store the ``sk-bk-...`` API key in the workspace vault and switch
           every LLM tier to Kiln's ``gpt-oss-120b`` endpoint.
chain-key  Generate (or import) a testnet signer, store it under the
           ``chain_audit`` vault scope, print the address to fund from a
           Sepolia faucet.
chain-check Read-only RPC probe: chain id + signer balance, no signatures.

Examples
--------
    python scripts/setup_gwdc_infra.py kiln --workspace <root> --api-key sk-bk-...
    python scripts/setup_gwdc_infra.py chain-key --workspace <root>
    python scripts/setup_gwdc_infra.py chain-check --workspace <root> \
        --rpc-url https://ethereum-sepolia-rpc.publicnode.com
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

KILN_BASE_URL = "https://api.bricksum.com/v1"
KILN_MODEL = "gpt-oss-120b"
PUBLIC_SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com"


def _config(workspace: str):
    from copy import deepcopy

    from nerya.core.config import Config, DEFAULT_CONFIG
    from nerya.core.paths import WorkspacePaths

    return Config(paths=WorkspacePaths(root=Path(workspace)), data=deepcopy(DEFAULT_CONFIG))


def _load_yaml(path: Path) -> dict:
    from nerya.core import yaml_io

    return yaml_io.load(path, default={}) or {}


def _dump_yaml(path: Path, doc: dict) -> None:
    from nerya.core import yaml_io

    yaml_io.dump(path, doc)


def cmd_kiln(args) -> int:
    """Store the Kiln key and rewire every tier to gpt-oss-120b."""
    cfg = _config(args.workspace)
    from nerya.security.secrets import SecretVault

    vault = SecretVault.open(cfg.paths.vault_enc)
    vault.put(
        name="llm_kiln_provider",
        value=args.api_key,
        kind="llm_provider_key",
        scope=["llm"],
        owner="operator",
    )
    print("[kiln] key stored as vault://llm_kiln_provider (scope=llm)")

    config_path = cfg.paths.config
    doc = _load_yaml(config_path)
    llm = doc.setdefault("llm", {})
    providers = llm.setdefault("providers", {})
    providers["kiln"] = {
        "base_url": KILN_BASE_URL,
        "provider_key_ref": "vault://llm_kiln_provider",
    }
    for tier_name, tier in (llm.get("tiers") or {}).items():
        tier["provider"] = "kiln"
        tier["model"] = KILN_MODEL
        routes = tier.get("routes")
        if isinstance(routes, list) and routes:
            for route in routes:
                if isinstance(route, dict):
                    route["provider"] = "kiln"
                    route["model"] = KILN_MODEL
    _dump_yaml(config_path, doc)
    print(f"[kiln] {config_path.name} updated: all tiers -> kiln/{KILN_MODEL} @ {KILN_BASE_URL}")
    print("[kiln] restart the API (nerya serve) and re-run a demo flow to generate real call logs.")
    return 0


def cmd_chain_key(args) -> int:
    cfg = _config(args.workspace)
    from eth_account import Account

    from nerya.security.secrets import SecretVault

    vault = SecretVault.open(cfg.paths.vault_enc)
    if args.import_key:
        acct = Account.from_key(args.import_key)
        name = "chain_audit_sepolia_imported"
    else:
        acct = Account.create()
        name = "chain_audit_sepolia_team3"
    vault.put(
        name=name,
        value=acct.key.hex(),
        kind="chain_signer",
        scope=["chain_audit"],
        owner="operator",
    )
    print(f"[chain] signer stored as vault://{name} (scope=chain_audit)")
    print(f"[chain] address: {acct.address}")
    print("[chain] fund it from a Sepolia faucet, then anchor:")
    print("        set NERYA_TESTNET_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com")
    print("        python -m nerya.cli.app chain-evidence anchor --workspace <root> "
          "--strategy-id <id> --session-id <id> --chain sepolia "
          f"--signer-ref vault://{name}")
    return 0


def cmd_chain_check(args) -> int:
    cfg = _config(args.workspace)
    rpc_url = args.rpc_url or PUBLIC_SEPOLIA_RPC

    def rpc(method: str, params: list):
        request = urllib.request.Request(
            rpc_url,
            data=json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": 1}).encode(),
            headers={"Content-Type": "application/json", "User-Agent": "nerya-gwdc-infra/1.0"},
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read())

    chain_id = rpc("eth_chainId", [])
    print(f"[chain] {rpc_url} -> chainId {chain_id.get('result')} (sepolia expects 0xaa36a7)")
    from nerya.security.secrets import SecretVault

    vault = SecretVault.open(cfg.paths.vault_enc)
    try:
        key = vault.resolve("chain_audit_sepolia_team3", required_scope="chain_audit")
        from eth_account import Account

        address = Account.from_key(key).address
        balance = rpc("eth_getBalance", [address, "latest"])
        wei = int(balance.get("result") or "0", 16)
        print(f"[chain] signer {address} balance: {wei / 10**18:.6f} ETH")
        if wei == 0:
            print("[chain] ZERO balance — fund from a faucet before anchoring.")
            return 1
        return 0
    except Exception as exc:
        print(f"[chain] no stored signer readable: {type(exc).__name__}")
        return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("kiln", help="store the Kiln key and switch all tiers to gpt-oss-120b")
    p.add_argument("--workspace", required=True)
    p.add_argument("--api-key", required=True, help="sk-bk-... from the Kiln console")
    p.set_defaults(func=cmd_kiln)

    p = sub.add_parser("chain-key", help="generate/import a Sepolia signer into the vault")
    p.add_argument("--workspace", required=True)
    p.add_argument("--import-key", default=None, help="optional existing 0x private key")
    p.set_defaults(func=cmd_chain_key)

    p = sub.add_parser("chain-check", help="read-only RPC probe: chain id and signer balance")
    p.add_argument("--workspace", required=True)
    p.add_argument("--rpc-url", default=None)
    p.set_defaults(func=cmd_chain_check)

    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
