"""Versioned JSON contract shared by external wallet and DEX adapters."""
import math
import time
from .errors import WalletQuoteError, WalletTransportError
from .protocol import WalletQuote, WalletSwapResult

VERSION=1
ACTUAL_SOURCES={'receipt','transaction_meta','transaction_trace'}


def finite(value, label, *, positive=False):
    try:number=float(value)
    except (TypeError,ValueError) as exc:raise WalletQuoteError(f'{label} must be numeric') from exc
    if not math.isfinite(number) or number<0 or (positive and number<=0):
        raise WalletQuoteError(f'{label} must be finite and '+('positive' if positive else 'non-negative'))
    return number


def parse_quote(provider, request, doc):
    if not isinstance(doc,dict) or doc.get('ok') is False or doc.get('synthetic'):
        raise WalletQuoteError('adapter did not return an executable quote')
    if doc.get('expires_at') is not None and finite(doc['expires_at'],'expires_at')<=time.time():
        raise WalletQuoteError('adapter quote has expired')
    for key in ('chain','token_in','token_out'):
        if key in doc and doc[key]!=request[key]:raise WalletQuoteError('adapter quote asset mismatch')
    expected=finite(doc.get('expected_out'),'expected_out',positive=True)
    minimum=finite(doc.get('min_out'),'min_out',positive=True)
    if minimum>expected:raise WalletQuoteError('minimum output exceeds expected output')
    if 'amount_in' in doc and finite(doc['amount_in'],'amount_in')!=float(request['amount_in']):
        raise WalletQuoteError('adapter quote amount mismatch')
    return WalletQuote(provider=provider,chain=request['chain'],token_in=request['token_in'],token_out=request['token_out'],
        amount_in=float(request['amount_in']),expected_out=expected,min_out=minimum,slippage_bps=int(request['slippage_bps']),
        price_impact_bps=int(finite(doc.get('price_impact_bps',0),'price_impact_bps')),
        gas_cost_usd=finite(doc.get('gas_cost_usd',0),'gas_cost_usd'),
        extra={k:doc[k] for k in ('quote_id','expires_at','minimum_output','decimals_in','decimals_out') if k in doc})


def parse_result(provider, request, doc, *, on_broadcast=None):
    if not isinstance(doc,dict):raise WalletTransportError('adapter result must be an object')
    for key in ('chain','token_out'):
        if key in doc and doc[key]!=request[key]:raise WalletTransportError('adapter execution identity mismatch; reconcile existing send')
    status=str(doc.get('status') or ('confirmed' if doc.get('confirmed') is True else 'submitted'))
    if status not in {'submitted','unknown','confirmed','failed'}:raise WalletTransportError('invalid adapter execution status')
    tx_hash=str(doc.get('tx_hash') or '')
    ref=str(doc.get('execution_ref') or '')
    transaction={'tx_hash':tx_hash,'execution_ref':ref,'chain':request['chain'],
        'owner':doc.get('owner') or doc.get('receiver') or request.get('receiver') or '',
        'token_out':request['token_out']}
    if on_broadcast and (tx_hash or ref):on_broadcast(transaction)
    try:actual=finite(doc.get('amount_out',0),'amount_out')
    except WalletQuoteError as exc:raise WalletTransportError('adapter execution amount invalid; reconcile existing send') from exc
    source=str(doc.get('amount_out_source') or 'unknown')
    confirmed=doc.get('confirmed') is True and status=='confirmed'
    ok=confirmed and doc.get('ok') is not False and source in ACTUAL_SOURCES and actual>0 and bool(tx_hash)
    return WalletSwapResult(provider=provider,chain=request['chain'],ok=ok,tx_hash=tx_hash,
        amount_in=float(request['amount_in']),amount_out=actual if ok else 0,
        reason=str(doc.get('reason') or ''),extra={'status':status if ok or status=='failed' else 'submitted' if tx_hash or ref else 'unknown',
            'confirmed':confirmed,'amount_out_source':source,'execution_ref':ref,'transaction':transaction})
