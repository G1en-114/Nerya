"""CDP Server Wallet v2 quotes and execution using an existing EOA."""
import asyncio
import uuid
from concurrent.futures import ThreadPoolExecutor
from ..errors import WalletPolicyDenied,WalletDependencyError,WalletQuoteError,WalletTransportError
from ..protocol import WalletQuote,WalletSwapResult
from ..amounts import to_base_units,to_base_units_ceil


def run_sync(factory):
    try:asyncio.get_running_loop()
    except RuntimeError:return asyncio.run(factory())
    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(lambda:asyncio.run(factory())).result()


def _client(provider):
    try:from cdp import CdpClient
    except ImportError as exc:raise WalletDependencyError('coinbase',['pip:cdp-sdk>=1'],'Install current cdp-sdk') from exc
    return CdpClient(api_key_id=provider.api_key_name,api_key_secret=provider.api_private_key,
        wallet_secret=provider.config.get('wallet_secret') or None,max_network_retries=0)


def _request(provider,chain,token_in,token_out,amount_in):
    from ...connectors.evm_native import EVMNative,EVM_CHAIN_IDS
    if chain not in ('base','ethereum'):raise WalletPolicyDenied('CDP v2 swaps support base and ethereum')
    owner=provider._configured_address()
    if not owner:raise WalletPolicyDenied('CDP v2 needs an existing wallet_address')
    rpc=(provider.config.get('rpc_urls') or {}).get(chain)
    if not rpc:raise WalletPolicyDenied('CDP v2 needs chain RPC for decimals and receipts')
    conn=EVMNative(chain=chain,chain_id=EVM_CHAIN_IDS[chain],rpc_url=rpc)
    def token(value):return '0x'+'e'*40 if value.lower() in ('native','eth') else value
    ti,to=token(token_in),token(token_out)
    di=18 if ti.lower()=='0x'+'e'*40 else conn.get_erc20_decimals(ti)
    do=18 if to.lower()=='0x'+'e'*40 else conn.get_erc20_decimals(to)
    return owner,ti,to,di,do


def quote_or_swap(provider,*,chain,token_in,token_out,amount_in,slippage_bps,execute=False,receiver=None,**kw):
    owner,ti,to,di,do=_request(provider,chain,token_in,token_out,amount_in)
    if receiver and receiver.lower()!=owner.lower():raise WalletPolicyDenied('CDP receiver differs from selected account')
    if execute and not provider.config.get('wallet_secret'):raise WalletPolicyDenied('CDP wallet_secret is required to execute')
    if execute:
        from ..adapter_contract import finite
        finite(kw.get('min_out'),'approved min_out',positive=True)
    raw=to_base_units(amount_in,di)
    async def run():
        async with _client(provider) as client:
            q=await client.evm.create_swap_quote(from_token=ti,to_token=to,from_amount=str(raw),network=chain,
                taker=owner,slippage_bps=slippage_bps)
            if not getattr(q,'liquidity_available',False):raise WalletQuoteError('CDP swap liquidity unavailable')
            if q.from_token.lower()!=ti.lower() or q.to_token.lower()!=to.lower() or int(q.from_amount)!=raw or q.network!=chain:
                raise WalletQuoteError('CDP quote identity mismatch')
            expected=int(q.to_amount)/(10**do);minimum=int(q.min_to_amount)/(10**do)
            if not execute:
                return WalletQuote(provider=provider.id,chain=chain,token_in=token_in,token_out=token_out,
                    amount_in=float(amount_in),expected_out=expected,min_out=minimum,slippage_bps=slippage_bps,
                    extra={'quote_id':q.quote_id,'minimum_output':'enforced','decimals_in':di,'decimals_out':do})
            if int(q.min_to_amount)<to_base_units_ceil(kw.get('min_out') or 0,do):raise WalletPolicyDenied('CDP minimum below approved floor')
            key=str(uuid.uuid5(uuid.NAMESPACE_URL,'nerya:cdp:'+str(kw.get('execution_id') or uuid.uuid4())))
            submitted=await q.execute(idempotency_key=key)
            tx_hash=str(getattr(submitted,'transaction_hash','') or '')
            if not tx_hash:raise WalletTransportError('CDP submitted result has no EOA hash; execution outcome unknown')
            tx={'tx_hash':tx_hash,'chain':chain,'owner':owner,'token_out':to}
            if kw.get('on_broadcast'):kw['on_broadcast'](tx)
            from ..confirmation import read_transaction
            return read_transaction(provider.id,provider.config,dict(chain=chain,token_out=to,amount_in=amount_in),tx)
    return run_sync(run)
