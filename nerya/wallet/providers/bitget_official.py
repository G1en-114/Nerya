"""Current Bitget quote/confirm/make-order protocol with local standard signing."""
import base64
from ..errors import WalletPolicyDenied,WalletQuoteError,WalletTransportError
from ..protocol import WalletQuote
from ..adapter_contract import finite


def call(provider,action,params,*,payload=None):
    args=[action]
    for key,value in params.items():
        if value is not None:args.extend(['--'+key.replace('_','-'),str(value)])
    if payload is not None:args.append('--json-stdin')
    doc=provider._run_python_skill(args,**({'input_doc':payload} if payload is not None else {}))
    if doc.get('error_code') not in (0,'0',None):raise WalletQuoteError('Bitget rejected request: '+str(doc.get('msg') or ''))
    if doc.get('status') in (-1,'-1'):raise WalletTransportError('Bitget request failed')
    return doc.get('data') or {}


def terms(provider,chain,token_in,token_out,amount_in,slippage_bps,receiver=None):
    from .bitget import _BITGET_CHAINS
    code=_BITGET_CHAINS.get(chain)
    if not code:raise WalletPolicyDenied('unsupported Bitget chain')
    address=provider.config.get('wallet_address')
    if not address:raise WalletPolicyDenied('configure Bitget wallet_address')
    if receiver and (receiver!=address if chain=='solana' else receiver.lower()!=address.lower()):
        raise WalletPolicyDenied('Bitget receiver differs from configured wallet')
    symbols=provider.config.get('token_symbols') or {}
    def asset(token):
        native=token.lower() in ('native','eth','bnb','sol')
        if native:return '',{'eth':'ETH','bnb':'BNB','sol':'SOL'}.get(code,'NATIVE')
        symbol=symbols.get(token)
        if not symbol:
            data=call(provider,'token-info',{'chain':code,'contract':token})
            symbol=data.get('symbol') or (data.get('info') or {}).get('symbol')
        if not symbol:raise WalletQuoteError('Bitget token symbol unavailable')
        return token,symbol
    ti,si=asset(token_in);to,so=asset(token_out)
    return dict(from_address=address,from_chain=code,from_symbol=si,from_contract=ti,from_amount=str(amount_in),
        to_chain=code,to_symbol=so,to_contract=to,to_address=address,slippage=str(slippage_bps/10000))


def first_quote(provider,request):
    params=terms(provider,**request)
    data=call(provider,'quote',params)
    quotes=data.get('quoteResults') or []
    if not quotes:raise WalletQuoteError('Bitget returned no routes')
    route=quotes[0]
    expected=finite(route.get('outAmount'),'outAmount',positive=True)
    minimum=finite(route.get('minAmount'),'minAmount',positive=True)
    if minimum>expected:raise WalletQuoteError('Bitget minimum exceeds quote')
    return params,route,expected,minimum


def quote(provider,**request):
    params,route,expected,minimum=first_quote(provider,request)
    return WalletQuote(provider=provider.id,**request,expected_out=expected,min_out=minimum,
        extra={'market':(route.get('market') or {}).get('id'),'minimum_output':'enforced','real_quote':True})


def balance(provider,chain,address,token):
    from .self_custody import SelfCustodyWallet
    # Use public RPC for exact balances (batch-v2 shape may vary by asset class).
    result=SelfCustodyWallet(rpc_urls=provider.config.get('rpc_urls') or {}).get_balance(chain=chain,address=address,token=token)
    result.provider=provider.id
    return result


def swap(provider,*,chain,token_in,token_out,amount_in,slippage_bps,receiver,**kw):
    from .self_custody import SelfCustodyWallet
    from ...connectors.evm_native import EVM_CHAIN_IDS,EVMNative
    from ...connectors.solana_native import _pubkey_from_signer,_sign_solana_v0_tx,_read_shortvec_u16
    from ..amounts import to_base_units
    from ..token_info import token_decimals
    from eth_account import Account
    import base58
    request=dict(chain=chain,token_in=token_in,token_out=token_out,amount_in=amount_in,slippage_bps=slippage_bps)
    finite(kw.get('min_out'),'approved min_out',positive=True)
    params,route,_,_=first_quote(provider,request)
    address=params['from_address']
    if receiver and (receiver!=address if chain=='solana' else receiver.lower()!=address.lower()):raise WalletPolicyDenied('Bitget receiver mismatch')
    if chain!='solana':
        rpc=(provider.config.get('rpc_urls') or {}).get(chain)
        if not rpc:raise WalletPolicyDenied('Bitget EVM execution requires chain RPC')
        EVMNative(chain=chain,chain_id=EVM_CHAIN_IDS[chain],rpc_url=rpc)._verify_chain_id()
    signer=SelfCustodyWallet(workspace=provider.workspace,signer_ref=provider.config.get('signer_ref') or '',rpc_urls=provider.config.get('rpc_urls'))
    key=signer._resolve_signer_key()
    try:
        owner=_pubkey_from_signer(key) if chain=='solana' else Account.from_key(key).address
        if (owner!=address if chain=='solana' else owner.lower()!=address.lower()):raise WalletPolicyDenied('Bitget signer mismatch')
        market=route.get('market') or {}
        selected={**params,'market':market.get('id'),'protocol':market.get('protocol') or route.get('protocol')}
        if not selected['market'] or not selected['protocol']:raise WalletQuoteError('Bitget route identity unavailable')
        confirmation=call(provider,'confirm',{**selected,'features':'user_gas'})
        confirmed_quote=confirmation.get('quoteResult') or {}
        minimum=finite(confirmed_quote.get('minAmount'),'confirmed minAmount',positive=True)
        if minimum<float(kw.get('min_out') or 0):raise WalletPolicyDenied('Bitget confirmed minimum below approved floor')
        ref=str(confirmation.get('orderId') or '')
        if not ref:raise WalletQuoteError('Bitget confirm returned no orderId')
        order=call(provider,'make-order',{**selected,'order_id':ref})
        txs=order.get('txs') or []
        if not txs:raise WalletQuoteError('Bitget order contains no transactions')
        # Standard same-chain transactions only; gasless/typed-data authority
        # requests need a dedicated adapter and are rejected before any signing.
        prepared=[];native_value=0
        for item in txs:
            if item.get('function')=='signTypeData' or item.get('msgs') or (item.get('deriveTransaction') or {}).get('msgs'):
                raise WalletPolicyDenied('Bitget gasless/typed message signing requires a dedicated adapter')
            if chain=='solana':
                inner=item.get('data') if isinstance(item.get('data'),dict) else item
                source=inner.get('source') or (item.get('deriveTransaction') or {}).get('source') or {}
                encoded=inner.get('serializedTx') or source.get('serializedTransaction') or (item.get('data') if isinstance(item.get('data'),str) else '')
                if int(item.get('chainId') or (item.get('deriveTransaction') or {}).get('chainId') or 501)!=501:
                    raise WalletPolicyDenied('Bitget transaction chain mismatch')
                prepared.append(('solana',base64.b64encode(base58.b58decode(encoded)).decode()))
            else:
                derive=item.get('deriveTransaction') or item.get('data') or {}
                if not isinstance(derive,dict):raise WalletPolicyDenied('unsupported Bitget transaction format')
                cid=int(item.get('chainId') or derive.get('chainId') or 0)
                if cid!=EVM_CHAIN_IDS.get(chain):raise WalletPolicyDenied('Bitget transaction chain mismatch')
                from decimal import Decimal
                def integer(v):return int(str(v),16) if str(v).startswith('0x') else int(v or 0)
                data=item.get('data') if isinstance(item.get('data'),str) else derive.get('calldata') or derive.get('data')
                raw_value=derive.get('value') or item.get('value') or 0
                value=int(Decimal(str(raw_value))*10**18) if '.' in str(raw_value) else integer(raw_value)
                native_value+=value
                if not data or not str(data).startswith('0x'):raise WalletPolicyDenied('Bitget calldata unavailable')
                tx=dict(chainId=cid,to=item.get('to') or derive.get('to'),data=data,value=value,
                    nonce=integer(derive.get('nonce')),gas=integer(derive.get('gasLimit')))
                if derive.get('supportEIP1559') or derive.get('maxFeePerGas'):
                    tx.update(type=2,maxFeePerGas=integer(derive.get('maxFeePerGas')),
                              maxPriorityFeePerGas=integer(derive.get('maxPriorityFeePerGas')))
                else:
                    gp=str(derive.get('gasPrice') or '0')
                    tx['gasPrice']=(int(Decimal(gp)*(10**18 if Decimal(gp)<1 else 10**9)) if '.' in gp else integer(gp))
                prepared.append(('evm',tx))
        native_in=token_in.lower() in ('eth','bnb','native')
        if native_value>(to_base_units(amount_in,18) if native_in else 0):raise WalletPolicyDenied('Bitget native value exceeds approved input')
        hashes=[]
        for item,(kind,tx) in zip(txs,prepared):
            if kind=='solana':
                raw=base64.b64decode(_sign_solana_v0_tx(tx,key));_,off=_read_shortvec_u16(raw,0)
                item['sig']=base58.b58encode(raw).decode();hashes.append(base58.b58encode(raw[off:off+64]).decode())
            else:
                if tx['data'].startswith('0x095ea7b3'):
                    approved=int(tx['data'][-64:],16)
                    if tx['to'].lower()!=token_in.lower() or approved>to_base_units(amount_in,token_decimals(provider.config,chain,token_in)):
                        raise WalletPolicyDenied('Bitget allowance exceeds approved input')
                signed=Account.sign_transaction(tx,key)
                item['sig']='0x'+signed.raw_transaction.hex().removeprefix('0x')
                hashes.append('0x'+signed.hash.hex().removeprefix('0x'))
        if prepared[-1][0]=='evm' and prepared[-1][1]['data'].startswith('0x095ea7b3'):
            raise WalletPolicyDenied('Bitget returned allowance only without swap transaction')
        tx={'tx_hash':hashes[-1],'execution_ref':ref,'chain':chain,'owner':owner,'token_out':token_out,'tx_hashes':hashes}
        if kw.get('on_broadcast'):kw['on_broadcast'](tx)
        try:call(provider,'send',{},payload={'orderId':ref,'txs':txs})
        except Exception as exc:raise WalletTransportError('Bitget send outcome requires order reconciliation') from exc
        from ..confirmation import read_transaction
        result=read_transaction(provider.id,provider.config,request,tx)
        result.extra.update(execution_ref=ref,transaction=tx)
        return result
    finally:key=''
