"""Durable, one-shot operator approval for live wallet swaps.

A wallet swap is a real-money side effect even though it is not a CEX
``TradeIntent``. Public requests therefore follow the same safety shape as
interactive orders:

1. validate and quote the exact swap request;
2. persist a frozen ``wallet_swap`` approval record in SQLite + JSONL;
3. show the record through the shared approval UI;
4. after approval, atomically claim the record and execute it once;
5. re-check runtime live controls and the approved quote floor immediately
   before calling the provider.

The approval id is the idempotency boundary. A duplicate callback or resume
attempt cannot invoke the provider again, including across API processes.
"""

from __future__ import annotations

import json
from contextlib import closing
import logging
import math
from pathlib import Path
import time
from typing import Any, Mapping

from ..core import jsonl
from ..core.config import Config
from ..core.ids import approval_id
from ..core.time import now_iso
from ..db.repositories import ApprovalRepository
from ..db.sqlite import connect
from .errors import (
    WalletDependencyError,
    WalletPolicyDenied,
    WalletQuoteError,
    WalletTransportError,
)
from .registry import build_provider, list_configured_providers

log = logging.getLogger(__name__)


def _meaningful_wallet_cfg(cfg: Mapping[str, Any]) -> bool:
    for key, value in dict(cfg or {}).items():
        if value in (None, "", [], {}):
            continue
        if key == "entry" and value in {
            "dist/nerya.js",
            "dist/index.js",
            "scripts/bitget-wallet-agent-api.py",
        }:
            continue
        if key == "chains":
            # Shipped by DEFAULT_CONFIG (deep-merged into every config),
            # so its presence does not mean the operator configured a
            # legacy block here; customized chain lists belong in
            # wallet.providers.<id> bindings.
            continue
        return True
    return False


def _wallet_cfg(config: Config, name: str) -> dict[str, Any]:
    from .bindings import resolve_binding
    return resolve_binding(config, {"provider":name})[2]


def normalize_swap_request(
    config: Config,
    payload: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Return the allow-listed, serialisable wallet swap request."""

    body = dict(payload or {})
    from .bindings import resolve_binding, binding_fingerprint
    wallet_id, provider, _ = resolve_binding(config, body)
    chain = str(body.get("chain") or "ethereum").strip().lower()
    chain = {'eth':'ethereum', 'sol':'solana', 'bnb':'bsc'}.get(chain, chain)
    token_in = str(body.get("token_in") or "").strip()
    token_out = str(body.get("token_out") or "").strip()
    if not chain:
        raise ValueError("chain is required")
    if not token_in or not token_out:
        raise ValueError("token_in and token_out are required")
    if (token_in == token_out if chain == "solana" else token_in.lower() == token_out.lower()):
        raise ValueError("token_in and token_out must differ")
    try:
        amount_in = float(body.get("amount_in") or 0.0)
    except (TypeError, ValueError) as exc:
        raise ValueError("amount_in must be numeric") from exc
    if not math.isfinite(amount_in) or amount_in <= 0:
        raise ValueError("amount_in must be a finite positive number")
    try:
        slippage_bps = int(body.get("slippage_bps") if body.get("slippage_bps") is not None else 50)
        if body.get('slippage_bps') is not None and float(body['slippage_bps']) != slippage_bps:
            raise ValueError('slippage_bps must be an integer')
    except (TypeError, ValueError) as exc:
        raise ValueError("slippage_bps must be an integer") from exc
    if not 0 <= slippage_bps <= 5_000:
        raise ValueError("slippage_bps must be between 0 and 5000")
    receiver = str(body.get("receiver") or "").strip()
    request = {
        "provider": provider, "wallet_id":wallet_id,
        "chain": chain, "token_in":token_in, "token_out":token_out,
        "amount_in":amount_in, "slippage_bps":slippage_bps, "receiver":receiver,
    }
    for key in ("account_id", "strategy_id", "market", "intent_id", "source", "side", "trigger_event_id", "plan_action"):
        if body.get(key) is not None:
            if not isinstance(body[key], str):
                raise ValueError(f'{key} must be a string')
            request[key] = body[key]
    if body.get('confidence') is not None:
        confidence = float(body['confidence'])
        if not math.isfinite(confidence) or not 0 <= confidence <= 1:
            raise ValueError('confidence must be finite and between 0 and 1')
        request['confidence'] = confidence
    for key in ("decimals_in", "decimals_out"):
        if body.get(key) is not None:
            value = int(body[key])
            if float(body[key]) != value or not 0 <= value <= 36:
                raise ValueError(f"{key} must be in [0,36]")
            request[key] = value
    request["wallet_fingerprint"] = binding_fingerprint(config,request)
    return request


def _provider(config: Config, request: Mapping[str, Any]):
    from .bindings import resolve_binding
    _, name, cfg = resolve_binding(config, request)
    return build_provider(
        name,
        cfg,
        workspace=Path(config.paths.root),
    )


def quote_swap(config: Config, request: Mapping[str, Any]) -> dict[str, Any]:
    """Fetch the quote that the operator will approve."""

    provider = _provider(config, request)
    result = provider.quote(
        chain=str(request["chain"]),
        token_in=str(request["token_in"]),
        token_out=str(request["token_out"]),
        amount_in=float(request["amount_in"]),
        slippage_bps=int(request["slippage_bps"]),
        **{k:request[k] for k in ("decimals_in","decimals_out") if k in request},
    )
    return result.to_dict()


def prepare_swap(
    config: Config,
    payload: Mapping[str, Any] | None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    request = normalize_swap_request(config, payload)
    quote = quote_swap(config, request)
    _validate_quote(quote)
    from .bindings import binding_fingerprint
    if binding_fingerprint(config,request)!=request['wallet_fingerprint']:
        raise WalletPolicyDenied('wallet changed during quote; request a fresh quote')
    return request, quote


def request_approval(
    config: Config,
    *,
    request: Mapping[str, Any],
    quote: Mapping[str, Any],
    actor_id: str,
    session_id: str = "",
    turn_id: str = "",
    tool_call_id: str = "",
) -> dict[str, Any]:
    """Persist and broadcast one frozen wallet swap approval."""

    from ..trading.locks import trading_lock
    key='wallet_approval:'+str(request.get('wallet_id') or request.get('provider'))
    with trading_lock(config.paths,key) as acquired:
        if not acquired:
            raise WalletPolicyDenied('another wallet approval request is being saved')
        return _request_approval_locked(config,request=request,quote=quote,actor_id=actor_id,
            session_id=session_id,turn_id=turn_id,tool_call_id=tool_call_id)


def _request_approval_locked(config,*,request,quote,actor_id,session_id='',turn_id='',tool_call_id=''):
    provider=_provider(config,request)
    caps=provider.capabilities() if callable(getattr(provider,'capabilities',None)) else None
    if caps is not None and (not caps.swap.supported or (caps.swap_chains and request['chain'] not in caps.swap_chains)):
        raise WalletPolicyDenied('provider does not support this live swap; no approval was created')
    if request.get('strategy_id'):
        with closing(connect(config.paths.db)) as con:
            for row in ApprovalRepository(con).list_pending():
                payload=_approval_payload(row)
                if float(payload.get('expires_at') or row.get('expires_at') or 0) <= time.time():
                    continue
                prior=payload.get('wallet_swap') or {}
                if prior.get('strategy_id')==request['strategy_id'] and prior.get('market')==request.get('market'):
                    return {'ok':True,'status':'pending_approval','approval_id':row['id'],'already_pending':True}

    _validate_quote(quote)
    expires_s = max(1.0, float(config.get("approvals.expire_seconds", 600)))
    aid = approval_id()
    created_at = time.time()
    actor = str(actor_id or "").strip() or "operator:http"
    frozen_request = dict(request)
    frozen_quote = dict(quote)
    record: dict[str, Any] = {
        "approval_id": aid,
        "kind": "wallet_swap",
        "state": "pending",
        "created_at": created_at,
        "expires_at": created_at + expires_s,
        "actor_id": actor,
        "approval_actor_id": actor,
        "source": "operator_http",
        "execution_mode": "live",
        "provider": frozen_request["provider"],
        "chain": frozen_request["chain"],
        "token_in": frozen_request["token_in"],
        "token_out": frozen_request["token_out"],
        "amount_in": frozen_request["amount_in"],
        "slippage_bps": frozen_request["slippage_bps"],
        "receiver": frozen_request.get("receiver") or "",
        "wallet_swap": frozen_request,
        "quote": frozen_quote,
        "risk": {
            "decision": "escalate",
            "reasons": ["wallet_live_side_effect_requires_operator_approval"],
        },
    }
    if session_id:
        record["session_id"] = str(session_id)
    if turn_id:
        record["turn_id"] = str(turn_id)
    if tool_call_id:
        record["tool_call_id"] = str(tool_call_id)

    con = connect(config.paths.db)
    try:
        ApprovalRepository(con).insert(
            id=aid,
            kind="wallet_swap",
            expires_s=expires_s,
            payload=record,
        )
    finally:
        con.close()
    jsonl.append(config.paths.approvals_pending, record)
    jsonl.append(
        config.paths.journal("wallet"),
        {
            "kind": "wallet.swap.approval_requested",
            "ts": now_iso(),
            "approval_id": aid,
            "actor_id": actor,
            "wallet_swap": frozen_request,
            "quote": frozen_quote,
        },
    )
    try:
        from ..trading.approval import _broadcast_approval

        _broadcast_approval(config, record)
    except Exception:
        pass
    return {
        "ok": True,
        "status": "pending_approval",
        "approval_id": aid,
        "execution_mode": "live",
        "wallet_swap": frozen_request,
        "quote": frozen_quote,
    }


def _float(value: object) -> float:
    try:
        number = float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0
    return number if math.isfinite(number) else 0.0


def _validate_quote(quote: Mapping[str, Any]) -> None:
    """Refuse to freeze an approval around a meaningless quote.

    Providers that fail to parse an aggregator/CLI response previously
    produced ``expected_out=0, min_out=0`` — and because the pre-trade
    floor check skips zero floors, such a quote approved a swap with NO
    slippage protection at all.
    """
    if (quote.get("extra") or {}).get("synthetic"):
        raise ValueError("synthetic quotes cannot authorize wallet execution")
    expiry=(quote.get('extra') or {}).get('expires_at')
    if expiry is not None and _float(expiry)<=time.time():
        raise WalletQuoteError('quote expired; request a fresh quote')
    expected_out = _float(quote.get("expected_out"))
    min_out = _float(quote.get("min_out"))
    if expected_out <= 0:
        raise ValueError(
            "quote has no positive expected_out — refusing to freeze an "
            f"approval around it (got expected_out={quote.get('expected_out')!r})"
        )
    if min_out <= 0 or min_out > expected_out:
        raise ValueError(
            "quote min_out must be positive and not exceed expected_out — "
            f"refusing to freeze an approval (min_out={min_out!r}, "
            f"expected_out={expected_out!r})"
        )


def execute_frozen_swap(
    config: Config,
    *,
    request: Mapping[str, Any],
    approved_quote: Mapping[str, Any],
    approval_id_value: str,
    expires_at: float | None = None,
) -> dict[str, Any]:
    """Execute a claimed swap after revalidating all live controls."""
    from ..trading.locks import trading_lock
    chain_key=str(request.get('chain') or '')
    # Serialize a chain across bindings: two wallet ids can share one signer.
    with trading_lock(config.paths,'wallet_send:'+chain_key) as acquired:
        if not acquired:
            return {'ok':False,'error':'wallet_execution_in_progress'}
        return _execute_locked(config,request=request,approved_quote=approved_quote,
            approval_id_value=approval_id_value,expires_at=expires_at)


def _execute_locked(config,*,request,approved_quote,approval_id_value,expires_at=None):

    if not config.live_trading_enabled():
        return {
            "ok": False,
            "error": "live_trading_disabled",
            "reason": "enable runtime.live_trading_enabled to run swaps",
        }
    if config.kill_switch():
        return {"ok": False, "error": "kill_switch_enabled"}
    if expires_at is not None and time.time() > float(expires_at):
        # The approval window is part of what the operator signed off on:
        # executing long after expiry would trade against stale prices.
        return {
            "ok": False,
            "error": "approval_expired",
            "approval_id": approval_id_value,
            "expires_at": float(expires_at),
            "reason": "request a fresh quote and approval",
        }

    frozen = normalize_swap_request(config, request)
    if request.get("wallet_fingerprint") and frozen["wallet_fingerprint"] != request["wallet_fingerprint"]:
        return {"ok":False,"error":"wallet_changed_requires_reapproval"}
    if frozen.get('account_id'):
        from ..trading.accounts import get_account_profile
        account=get_account_profile(config.paths,frozen['account_id'])
        if not account.is_real_money or not account.live_trading_enabled or not account.can_place_order:
            return {'ok':False,'error':'wallet_account_not_live_enabled'}
    from .strategy_execution import recheck_strategy
    recheck_strategy(config,frozen)
    from . import execution_state
    existing=execution_state.read(config,approval_id_value)
    if existing and existing.get('status') in ('submitting','submitted','unknown','confirmed'):
        return {'ok':existing['status']=='confirmed' and not (existing.get('result') or {}).get('approval_policy_breach'),'status':existing['status'],'already_submitted':True,
                'transaction':existing.get('transaction'),'result':existing.get('result')}
    for state_path in (config.paths.state/'wallet_swaps').glob('*.json'):
        prior=json.loads(state_path.read_text())
        other=prior.get('request') or {}
        if (prior.get('status') in ('submitting','submitted','unknown')
                and other.get('chain')==frozen['chain']):
            return {'ok':False,'error':'previous_wallet_transaction_unresolved','execution_id':prior.get('execution_id')}
    provider = _provider(config, frozen)
    caps=provider.capabilities() if callable(getattr(provider,'capabilities',None)) else None
    if caps is not None and (not caps.swap.supported or (caps.swap_chains and frozen['chain'] not in caps.swap_chains)):
        raise WalletPolicyDenied('provider does not support approved swap on this chain')
    current_quote = provider.quote(
        chain=frozen["chain"],
        token_in=frozen["token_in"],
        token_out=frozen["token_out"],
        amount_in=frozen["amount_in"],
        slippage_bps=frozen["slippage_bps"],
        **{k:frozen[k] for k in ("decimals_in","decimals_out") if k in frozen},
    ).to_dict()
    for field in ('chain','token_in','token_out'):
        if current_quote.get(field) != frozen[field]:
            raise WalletQuoteError('quote does not match frozen swap assets')
    if abs(_float(current_quote.get('amount_in'))-frozen['amount_in'])>max(1e-12,abs(frozen['amount_in'])*1e-12):
        raise WalletQuoteError('quote amount differs from approved input')
    approved_min_out = _float(approved_quote.get("min_out"))
    current_expected_out = _float(current_quote.get("expected_out"))
    if approved_min_out <= 0:
        # Defense in depth on top of _validate_quote at request time:
        # a zero floor means no slippage protection was ever approved.
        return {
            "ok": False,
            "error": "approval_quote_floor_missing",
            "approval_id": approval_id_value,
            "approved_min_out": approved_min_out,
            "reason": "the approved quote carried no enforceable min_out floor",
        }
    _validate_quote(current_quote)
    if current_expected_out < approved_min_out:
        return {
            "ok": False,
            "error": "quote_moved_requires_reapproval",
            "approval_id": approval_id_value,
            "approved_min_out": approved_min_out,
            "current_quote": current_quote,
        }
    from .bindings import binding_fingerprint
    if config.kill_switch() or not config.live_trading_enabled():
        return {'ok':False,'error':'live_controls_changed'}
    if binding_fingerprint(config,frozen) != frozen['wallet_fingerprint']:
        return {'ok':False,'error':'wallet_changed_requires_reapproval'}

    audit = {
        "kind": "wallet.swap.requested",
        "ts": now_iso(),
        "approval_id": approval_id_value,
        **frozen,
        "approved_quote": dict(approved_quote),
        "execution_quote": current_quote,
    }
    jsonl.append(config.paths.journal("wallet"), audit)
    kwargs: dict[str, Any] = {
        "chain": frozen["chain"],
        "token_in": frozen["token_in"],
        "token_out": frozen["token_out"],
        "amount_in": frozen["amount_in"],
        "slippage_bps": frozen["slippage_bps"],
        "receiver": frozen.get("receiver") or None,
        "live": True,
        **{k:frozen[k] for k in ("decimals_in","decimals_out") if k in frozen},
    }
    if approved_min_out > 0:
        kwargs["min_out"] = approved_min_out
    kwargs['execution_id']=approval_id_value
    from . import execution_state
    existing = execution_state.read(config,approval_id_value)
    if existing and existing.get("status") in {"submitting","submitted","unknown","confirmed"}:
        return {"ok":existing["status"]=="confirmed" and not (existing.get('result') or {}).get('approval_policy_breach'), "status":existing["status"],
                "already_submitted":True,"transaction":existing.get("transaction"),"result":existing.get("result")}
    execution_state.write(config,approval_id_value,status="submitting",request=frozen,approved_min_out=approved_min_out)
    kwargs["on_broadcast"] = execution_state.broadcast_callback(config,approval_id_value)
    try:
        result = provider.swap(**kwargs)
    except Exception as exc:
        state = execution_state.read(config,approval_id_value) or {}
        refused = isinstance(exc, (WalletPolicyDenied, WalletQuoteError, WalletDependencyError))
        status = 'submitted' if state.get('transaction') else 'failed' if refused else 'unknown'
        execution_state.write(config,approval_id_value,status=status,error=type(exc).__name__)
        raise
    result_doc = result.to_dict()
    amount_out = _float(result_doc.get("amount_out"))
    below_floor = (
        bool(result_doc.get("ok"))
        and approved_min_out > 0
        and amount_out > 0
        and amount_out < approved_min_out
    )
    if below_floor:
        result_doc['ok']=False
        result_doc["approval_policy_breach"] = {
            "approved_min_out": approved_min_out,
            "reported_amount_out": amount_out,
        }
    confirmed = (result_doc.get("extra") or {}).get("confirmed") is True
    actual = (result_doc.get("extra") or {}).get("amount_out_source") in {"receipt", "transaction_trace", "transaction_meta"}
    if confirmed and actual and amount_out<=0:
        below_floor=True
    observed_fill = confirmed and actual and amount_out > 0
    effective_ok = bool(result_doc.get("ok")) and observed_fill and not below_floor
    extra=result_doc.get('extra') or {}
    status = "confirmed" if observed_fill else "failed" if below_floor or extra.get('status')=='failed' else "submitted" if result_doc.get("tx_hash") or extra.get('execution_ref') else "unknown" if extra.get('status')=='unknown' else "failed"
    if 'reverted' in str(result_doc.get('reason') or '').lower():
        status='failed'
    execution_state.write(config,approval_id_value,status=status,result=result_doc)
    if observed_fill:
        from .strategy_execution import record_fill
        record_fill(config,frozen,result_doc,approval_id_value)
        execution_state.write(config,approval_id_value,booked=True)
    jsonl.append(
        config.paths.journal("wallet"),
        {
            **audit,
            "kind": "wallet.swap.result",
            "ok": effective_ok,
            "tx_hash": str(result_doc.get("tx_hash") or ""),
            "result": result_doc,
        },
    )
    return {
        "ok": effective_ok,
        "status": status,
        "approval_id": approval_id_value,
        "result": result_doc,
        "quote": current_quote,
        **(
            {"error": "execution_below_approved_min_out"}
            if below_floor
            else {}
        ),
    }


def reconcile_execution(config: Config, execution_id: str) -> dict[str, Any]:
    """Read an already broadcast transaction; never send it again."""
    from ..trading.locks import trading_lock
    from . import execution_state
    state=execution_state.read(config,execution_id) or {}
    chain=(state.get('request') or {}).get('chain','')
    with trading_lock(config.paths,'wallet_send:'+chain) as acquired:
        if not acquired:
            return {'ok':False,'status':'reconciling'}
        return _reconcile_locked(config,execution_id)


def _reconcile_locked(config,execution_id):
    from . import execution_state
    state=execution_state.read(config,execution_id)
    if not state:
        return {'ok':False,'error':'execution_not_found'}
    if state.get('status') in ('confirmed','failed'):
        if state.get('status')=='confirmed' and state.get('result'):
            from .strategy_execution import record_fill
            record_fill(config,state.get('request') or {},state['result'],execution_id)
            execution_state.write(config,execution_id,booked=True)
        return state
    request=state.get('request') or {}
    tx=state.get('transaction') or {}
    result=state.get('result') or {}
    tx_hash=tx.get('tx_hash') or result.get('tx_hash')
    if not tx_hash and not tx.get('execution_ref') and not (result.get('extra') or {}).get('execution_ref'):
        return {**state,'ok':False,'status':'unknown','reason':'broadcast identity unavailable; do not repeat swap'}
    from .bindings import binding_fingerprint
    if request.get('wallet_fingerprint') != binding_fingerprint(config,request):
        return {**state,'ok':False,'error':'wallet_changed_requires_review'}
    provider=_provider(config,request)
    transaction={**((result.get('extra') or {}).get('transaction') or {}),**tx,'tx_hash':tx_hash or ''}
    getter=getattr(provider,'get_execution_status',None)
    if not callable(getter):
        return {**state,'status':'submitted','reason':'provider does not implement get_execution_status'}
    result=getter(request=request,transaction=transaction).to_dict()
    extra=result.get('extra') or {}
    if extra.get('status')=='failed':
        return execution_state.write(config,execution_id,status='failed',error=result.get('reason'),result=result)
    from .adapter_contract import ACTUAL_SOURCES
    actual=_float(result.get('amount_out'))
    if not result.get('ok') or extra.get('confirmed') is not True or extra.get('amount_out_source') not in ACTUAL_SOURCES or actual<=0:
        return execution_state.write(config,execution_id,status='submitted',reason=result.get('reason'),result=result,
            transaction={**transaction,**(extra.get('transaction') or {}),'tx_hash':result.get('tx_hash') or tx_hash or ''})
    below_floor=actual < float(state.get('approved_min_out') or 0)
    if below_floor:
        result['ok']=False
        result['approval_policy_breach']={'approved_min_out':state['approved_min_out'],'reported_amount_out':actual}
    from .strategy_execution import record_fill
    record_fill(config,request,result,execution_id)
    return execution_state.write(config,execution_id,status='confirmed',result=result,booked=True,
        ok=not below_floor,error='execution_below_approved_min_out' if below_floor else '')


def reconcile_pending(config: Config) -> int:
    from . import execution_state
    count=0
    for path in (config.paths.state/'wallet_swaps').glob('*.json'):
        try:
            state=json.loads(path.read_text())
            if state.get('status')=='submitted' or (state.get('status')=='confirmed' and not state.get('booked')):
                reconcile_execution(config,state['execution_id'])
                count+=1
        except Exception:
            log.exception('wallet transaction reconciliation failed')
    return count


def _approval_payload(row: Mapping[str, Any] | None) -> dict[str, Any]:
    if not row:
        return {}
    raw = row.get("payload")
    if isinstance(raw, dict):
        return dict(raw)
    if isinstance(raw, str):
        try:
            decoded = json.loads(raw)
        except (TypeError, ValueError):
            return {}
        return dict(decoded) if isinstance(decoded, dict) else {}
    return {}


def _load_approved_record(config: Config, aid: str) -> dict[str, Any] | None:
    candidates: list[dict[str, Any]] = []
    for path in (config.paths.approvals_approved, config.paths.approvals_pending):
        if not path.exists():
            continue
        for record in jsonl.read_all(path):
            if record.get("approval_id") == aid or record.get("id") == aid:
                candidates.append(record)
    for record in candidates:
        if str(record.get("kind") or "") == "wallet_swap" and isinstance(
            record.get("wallet_swap"), dict
        ):
            return record
    con = connect(config.paths.db)
    try:
        row = ApprovalRepository(con).get(aid)
    finally:
        con.close()
    if not row:
        return None
    payload = _approval_payload(row)
    if not payload:
        return None
    payload["approval_id"] = aid
    payload["kind"] = str(row.get("kind") or payload.get("kind") or "")
    payload["state"] = str(row.get("state") or payload.get("state") or "")
    return payload


def _claim_resume(config: Config, aid: str) -> tuple[bool, dict[str, Any]]:
    con = connect(config.paths.db)
    try:
        repo = ApprovalRepository(con)
        row = repo.get(aid)
        if row is None or row.get('state')!='approved':
            return False, {**(row or {}),'payload':_approval_payload(row)}
        payload = _approval_payload(row)
        payload['resume_attempts'] = int(payload.get('resume_attempts') or 0)+1
        payload['resume_claimed_at'] = time.time()
        # Never reclaim a wallet send lease: the old process may have broadcast.
        cursor = con.execute("UPDATE approvals SET state='resuming',payload=? WHERE id=? AND state='approved'", (json.dumps(payload),aid))
        if cursor.rowcount == 1:
            return True, {}
        row = repo.get(aid) or {}
        return False, {**row, "payload": _approval_payload(row)}
    finally:
        con.close()


def _finish_resume(
    config: Config,
    aid: str,
    *,
    ok: bool,
    response_status: str | None,
    error: str | None = None,
) -> bool:
    con = connect(config.paths.db)
    try:
        return ApprovalRepository(con).finish_resume(
            aid,
            state="resumed" if ok else "resume_failed",
            intent_id=None,
            response_status=response_status,
            error=error,
        )
    finally:
        con.close()


def resume_approved(config: Config, aid: str) -> dict[str, Any]:
    """Atomically execute one approved wallet swap exactly once."""

    record = _load_approved_record(config, aid)
    if record is None:
        return {"ok": False, "error": "approval_not_found", "approval_id": aid}
    if str(record.get("kind") or "") != "wallet_swap":
        return {"ok": False, "error": "approval_kind_mismatch", "approval_id": aid}
    if str(record.get("state") or "").lower() != "approved":
        return {
            "ok": False,
            "error": "approval_not_approved",
            "approval_id": aid,
            "state": record.get("state"),
        }
    try:
        claimed, persisted = _claim_resume(config, aid)
    except Exception as exc:
        log.exception("wallet swap resume claim failed for %s", aid)
        return {
            "ok": False,
            "error": f"approval_resume_claim_failed:{exc}",
            "approval_id": aid,
        }
    if not claimed:
        state = str(persisted.get("state") or "")
        payload = persisted.get("payload") or {}
        if state in {"resuming", "resumed"}:
            return {
                "ok": True,
                "already_resumed": True,
                "resume_in_progress": state == "resuming",
                "approval_id": aid,
                "resume_status": payload.get("resume_status"),
            }
        return {
            "ok": False,
            "error": "resume_failed" if state == "resume_failed" else "approval_resume_not_claimed",
            "approval_id": aid,
            "state": state or None,
        }

    try:
        response = execute_frozen_swap(
            config,
            request=dict(record.get("wallet_swap") or {}),
            approved_quote=dict(record.get("quote") or {}),
            approval_id_value=aid,
            expires_at=record.get("expires_at"),
        )
    except (WalletDependencyError, WalletPolicyDenied) as exc:
        response = {
            "ok": False,
            "error": (
                "dependency_missing"
                if isinstance(exc, WalletDependencyError)
                else "policy_denied"
            ),
            "reason": str(exc),
        }
    except WalletTransportError as exc:
        # Provider backend outage (HTTP/RPC/CLI), not an operator-policy
        # block — classify it honestly for the approval UI.
        response = {
            "ok": False,
            "error": "provider_transport_error",
            "reason": str(exc),
        }
    except WalletQuoteError as exc:
        response = {
            "ok": False,
            "error": "quote_unavailable",
            "reason": str(exc),
        }
    except Exception as exc:  # pragma: no cover - provider failure boundary
        log.exception("wallet swap approval resume failed for %s", aid)
        _finish_resume(
            config,
            aid,
            ok=False,
            response_status="exception",
            error=str(exc),
        )
        jsonl.append(
            config.paths.journal("wallet"),
            {
                "kind": "wallet.swap.approval_resumed",
                "ts": now_iso(),
                "approval_id": aid,
                "ok": False,
                "error": str(exc),
            },
        )
        return {"ok": False, "error": f"resume_failed:{exc}", "approval_id": aid}

    # A returned response consumes the one-shot approval even when a late
    # safety check rejects execution. Retrying silently after an ambiguous
    # provider response is more dangerous than requiring a fresh approval.
    status = str(response.get("error") or response.get("status") or ("confirmed" if response.get("ok") else "rejected"))
    persisted = _finish_resume(
        config,
        aid,
        ok=True,
        response_status=status,
        error=None if response.get("ok") else status,
    )
    jsonl.append(
        config.paths.journal("wallet"),
        {
            "kind": "wallet.swap.approval_resumed",
            "ts": now_iso(),
            "approval_id": aid,
            "ok": bool(response.get("ok")),
            "status": status,
            "persisted": persisted,
        },
    )
    if not persisted:
        return {
            "ok": False,
            "error": "resume_state_persist_failed",
            "approval_id": aid,
            "resume_response": response,
        }
    return {
        "ok": bool(response.get("ok")),
        "approval_id": aid,
        "resume_response": response,
    }


__all__ = [
    "execute_frozen_swap",
    "normalize_swap_request",
    "prepare_swap",
    "quote_swap",
    "request_approval",
    "resume_approved",
]
