"""Nerya EIP-712 delegation prototype; not an AP2 wire implementation.

Only public payloads/signatures are returned. Production signing material must
be resolved by the operator from SecretVault, never supplied by an agent tool.
Costs use integer micro-USD; the signed cost is a conservative authorization
ceiling, not a reported execution cost.
"""

from __future__ import annotations

import json
import math
from decimal import Decimal, ROUND_CEILING
from typing import Any

from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak, to_checksum_address


class MandateDenied(ValueError):
    pass


POLICY_FIELDS = [
    ("owner", "address"), ("agent", "address"), ("scope", "bytes32"),
    ("market", "bytes32"), ("maxCost", "uint256"), ("budget", "uint256"),
    ("validAfter", "uint256"), ("validUntil", "uint256"),
    ("nonce", "uint256"), ("allowLong", "bool"),
]
ACTION_FIELDS = [
    ("policyHash", "bytes32"), ("planHash", "bytes32"), ("market", "bytes32"),
    ("cost", "uint256"), ("opensLong", "bool"), ("nonce", "uint256"),
    ("validUntil", "uint256"),
]
DOMAIN_FIELDS = [
    ("name", "string"), ("version", "string"), ("chainId", "uint256"),
    ("verifyingContract", "address"), ("salt", "bytes32"),
]


def _validate(payload: dict, fields: list[tuple[str, str]]) -> None:
    if not isinstance(payload, dict) or set(payload) != {n for n, _ in fields}:
        raise MandateDenied("invalid_fields")
    for name, kind in fields:
        value = payload[name]
        if kind == "uint256":
            if type(value) is not int or not 0 <= value < 2**256:
                raise MandateDenied("invalid_integer")
        elif kind == "bool":
            if type(value) is not bool:
                raise MandateDenied("invalid_boolean")
        elif kind == "bytes32":
            if not isinstance(value, str) or len(value) != 66 or not value.startswith("0x"):
                raise MandateDenied("invalid_hash")
            try:
                bytes.fromhex(value[2:])
            except ValueError:
                raise MandateDenied("invalid_hash") from None
        elif kind == "address":
            try:
                valid = isinstance(value, str) and len(value) == 42 and int(value[2:], 16) != 0
                valid = valid and value.startswith("0x") and bool(to_checksum_address(value))
            except (ValueError, TypeError):
                valid = False
            if not valid:
                raise MandateDenied("invalid_address")
        elif not isinstance(value, str):
            raise MandateDenied("invalid_string")


def domain(*, chain_id: int, verifier: str, workspace: str) -> dict:
    value = {"name": "Nerya Mandates", "version": "1", "chainId": chain_id,
             "verifyingContract": verifier, "salt": workspace}
    _validate(value, DOMAIN_FIELDS)
    if chain_id == 0:
        raise MandateDenied("invalid_chain")
    return value


def typed_data(domain_data: dict, kind: str, payload: dict) -> dict:
    fields = {"Policy": POLICY_FIELDS, "Action": ACTION_FIELDS}.get(kind)
    if fields is None:
        raise MandateDenied("invalid_kind")
    _validate(domain_data, DOMAIN_FIELDS)
    if domain_data["name"] != "Nerya Mandates" or domain_data["version"] != "1":
        raise MandateDenied("invalid_domain")
    _validate(payload, fields)
    return {
        "types": {"EIP712Domain": [{"name": n, "type": t} for n, t in DOMAIN_FIELDS],
                  kind: [{"name": n, "type": t} for n, t in fields]},
        "primaryType": kind, "domain": dict(domain_data), "message": dict(payload),
    }


def digest(domain_data: dict, kind: str, payload: dict) -> str:
    message = encode_typed_data(full_message=typed_data(domain_data, kind, payload))
    return "0x" + keccak(b"\x19" + message.version + message.header + message.body).hex()


def sign(domain_data: dict, kind: str, payload: dict, private_key: str) -> str:
    message = encode_typed_data(full_message=typed_data(domain_data, kind, payload))
    return "0x" + bytes(Account.sign_message(message, private_key).signature).hex()


def verify(domain_data: dict, kind: str, payload: dict, signature: str, expected: str) -> None:
    try:
        raw = bytes.fromhex(signature.removeprefix("0x"))
        # Match the contract: reject malleable/high-s signatures and non-27/28 v.
        order = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
        if len(raw) != 65 or raw[64] not in (27, 28) or not 0 < int.from_bytes(raw[32:64], "big") <= order // 2:
            raise ValueError()
        recovered = Account.recover_message(
            encode_typed_data(full_message=typed_data(domain_data, kind, payload)), signature=raw,
        )
        if recovered.lower() != expected.lower():
            raise ValueError()
    except (ValueError, TypeError, AttributeError, OverflowError):
        raise MandateDenied(f"invalid_{kind.lower()}_signature") from None


def hash_text(value: str) -> str:
    return "0x" + keccak(text=value).hex()


def scope_hash(account_id: str, strategy_id: str) -> str:
    return hash_text(json.dumps([account_id, strategy_id], ensure_ascii=True, separators=(",", ":")))


def plan_hash(plan: Any) -> str:
    """Bind the complete submitted plan except the signature envelope itself.

    v1 uses Python's deterministic JSON encoding. Wallets sign the exported
    EIP-712 planHash, with the original plan supplied alongside for inspection;
    this is not advertised as a general cross-language JSON canonicalization.
    """
    value = plan.asdict()
    value["meta"].pop("signed_mandate", None)
    try:
        raw = json.dumps(value, sort_keys=True, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
    except (ValueError, TypeError):
        raise MandateDenied("invalid_plan") from None
    return hash_text(raw)


def cost_units(notional: float, fee: float, slippage_bps: float = 0) -> int:
    values = [notional, fee, slippage_bps]
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 for v in values):
        raise MandateDenied("invalid_cost")
    n, f, s = (Decimal(str(v)) for v in values)
    return int(((n + f) * (1 + s / 10000) * 1_000_000).to_integral_value(rounding=ROUND_CEILING))


def validate_envelope(domain_data: dict, envelope: dict, *, owner: str, now: int) -> tuple[dict, dict, str, str]:
    if not isinstance(envelope, dict) or set(envelope) != {"policy", "policy_signature", "action", "action_signature"}:
        raise MandateDenied("missing_or_invalid_mandate")
    p, a = envelope["policy"], envelope["action"]
    _validate(p, POLICY_FIELDS)
    _validate(a, ACTION_FIELDS)
    if p["owner"].lower() != owner.lower():
        raise MandateDenied("untrusted_owner")
    verify(domain_data, "Policy", p, envelope["policy_signature"], owner)
    verify(domain_data, "Action", a, envelope["action_signature"], p["agent"])
    ph = digest(domain_data, "Policy", p)
    ah = digest(domain_data, "Action", a)
    if a["policyHash"].lower() != ph:
        raise MandateDenied("policy_hash_mismatch")
    if not p["validAfter"] <= now < p["validUntil"] or not now < a["validUntil"] <= p["validUntil"]:
        raise MandateDenied("mandate_expired_or_not_yet_valid")
    if p["maxCost"] <= 0 or p["budget"] < p["maxCost"] or a["cost"] <= 0:
        raise MandateDenied("invalid_budget")
    if a["market"].lower() != p["market"].lower():
        raise MandateDenied("market_not_allowed")
    if a["opensLong"] and not p["allowLong"]:
        raise MandateDenied("long_opening_not_allowed")
    if a["cost"] > p["maxCost"]:
        raise MandateDenied("action_cost_exceeded")
    return p, a, ph, ah
