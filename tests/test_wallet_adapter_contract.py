"""Cross-provider acceptance at the public wallet interface; no live sends."""
import socket
import sys
from pathlib import Path
from types import SimpleNamespace
import pytest
from nerya.wallet.protocol import WalletSwapResult
from nerya.wallet.errors import WalletPolicyDenied,WalletQuoteError
from nerya.wallet.registry import build_provider,register_wallet_provider,list_providers

pytestmark=pytest.mark.smoke

@pytest.fixture(autouse=True)
def offline(monkeypatch):
    def deny(*a,**kw):raise AssertionError('NETWORK_DISABLED')
    monkeypatch.setattr(socket.socket,'connect',deny)
    monkeypatch.setattr(socket,'create_connection',deny)


def test_external_process_contract_and_status(tmp_path):
    adapter=tmp_path/'adapter.py'
    adapter.write_text('''import json,sys
x=json.load(sys.stdin);p=x['payload'];c=x['command']
if c=='describe': out={'swap_chains':['base'],'minimum_output':'enforced','receipt_polling':True}
elif c=='quote':out={'expected_out':2,'min_out':1.98}
elif c=='swap':out={'status':'submitted','execution_ref':p['execution_id'],'owner':'owner'}
elif c=='get_execution_status':out={'status':'confirmed','confirmed':True,'tx_hash':'tx','amount_out':2,'amount_out_source':'receipt'}
else:out={}
print(json.dumps({'protocol_version':1,**out}))
''')
    p=build_provider('external',{'command':[sys.executable,str(adapter)],'chains':['base']},workspace=tmp_path)
    request=dict(chain='base',token_in='a',token_out='b',amount_in=1,slippage_bps=50)
    assert p.quote(**request).expected_out==2
    events=[]
    result=p.swap(**request,live=True,min_out=1.98,execution_id='one',on_broadcast=events.append)
    assert not result.ok and result.extra['execution_ref']=='one'
    assert events[0]['execution_ref']=='one'
    recovered=p.get_execution_status(request=request,transaction=events[0])
    assert recovered.ok and recovered.amount_out==2


def test_workspace_plugin_registration_isolated_and_disposable(tmp_path):
    from nerya.harness.extensions import ExtensionHost
    from nerya.core.paths import WorkspacePaths
    from nerya.wallet.providers.external import ExternalWallet
    from nerya.wallet.errors import WalletProviderNotFound
    class Plugin:
        name='test-wallet';requires=('paths',)
        def setup(self,ctx):
            ctx.register_wallet_provider('custom_dex',lambda cfg,**kw:ExternalWallet(id='custom_dex',config=cfg),metadata={'label':'Custom DEX'})
    host=ExtensionHost(services={'paths':WorkspacePaths(tmp_path)})
    assert host.use(Plugin())
    assert build_provider('custom_dex',workspace=tmp_path).id=='custom_dex'
    assert any(x['id']=='custom_dex' for x in list_providers(workspace=tmp_path))
    with pytest.raises(WalletProviderNotFound):build_provider('custom_dex',workspace=tmp_path/'other')
    host.teardown()
    with pytest.raises(WalletProviderNotFound):build_provider('custom_dex',workspace=tmp_path)
    with pytest.raises(ValueError):register_wallet_provider('byreal',lambda:None,workspace=tmp_path)


def test_metamask_and_self_custody_share_configurable_v2_route(tmp_path,monkeypatch):
    from nerya.connectors.bsc_native import BSCNative
    cfg={'signer_ref':'vault://test','rpc_urls':{'base':'http://base'},'dex_routes':{'base':{
        'type':'evm_v2','router':'0x'+'1'*40,'wrapped_native':'0x'+'2'*40,'native_symbol':'ETH'}}}
    seen=[]
    def quote(self,**kw):
        seen.append((self.chain,self.chain_id,self.router,self.wbnb,kw))
        return dict(amount_out=2,amount_out_min=1.99,amount_out_min_wei=199,path=[kw['token_in'],kw['token_out']],gas_price_gwei=1)
    monkeypatch.setattr(BSCNative,'quote_swap',quote)
    for name in ('self_custody','metamask'):
        p=build_provider(name,cfg,workspace=tmp_path)
        q=p.quote(chain='base',token_in='ETH',token_out='0x'+'3'*40,amount_in=1)
        assert q.chain=='base' and q.provider==name
    assert len(seen)==2 and all(x[:4]==('base',8453,'0x'+'1'*40,'0x'+'2'*40) for x in seen)


def test_binance_real_cli_quote_identity_and_unsupported_absolute_floor(monkeypatch):
    from nerya.wallet.providers.binance_agentic import BinanceAgenticWallet
    from nerya.wallet.providers import binance_cli
    p=BinanceAgenticWallet(config={'wallet_address':'owner'});calls=[]
    def call(provider,args):
        calls.append(args)
        return {'addresses':[{'binanceChainId':'CT_501','address':'owner'}]} if args[0]=='wallet' else {'toCoinAmount':'2','slippage':0.005}
    monkeypatch.setattr(binance_cli,'call',call)
    q=p.quote(chain='solana',token_in='SOL',token_out='mint',amount_in=1,slippage_bps=25)
    assert q.expected_out==2 and calls[-1][-1]=='0.25'
    assert not p.capabilities().swap.supported
    with pytest.raises(WalletPolicyDenied,match='absolute minimum'):p.swap(chain='solana',token_in='SOL',token_out='mint',amount_in=1,live=True,min_out=1.9)


def test_coinbase_v2_executes_checked_quote_and_records_hash(tmp_path,monkeypatch):
    from nerya.wallet.providers.coinbase import CoinbaseWallet
    from nerya.wallet.providers import coinbase_v2
    from nerya.connectors.evm_native import EVMNative
    from nerya.wallet.receipts import TRANSFER_TOPIC
    token='0x'+'2'*40;owner='0x'+'1'*40;calls=[]
    class Quote:
        liquidity_available=True;quote_id='q';from_token='0x'+'e'*40;to_token=token
        from_amount=str(10**18);to_amount='2000000';min_to_amount='1990000';network='base'
        async def execute(self,**kw):calls.append(kw);return SimpleNamespace(transaction_hash='tx')
    class Client:
        evm=None
        async def __aenter__(self):self.evm=self;return self
        async def __aexit__(self,*a):pass
        async def create_swap_quote(self,**kw):return Quote()
    monkeypatch.setattr(coinbase_v2,'_client',lambda p:Client())
    monkeypatch.setattr(EVMNative,'get_erc20_decimals',lambda *a:6)
    receipt={'status':'0x1','logs':[{'address':token,'topics':[TRANSFER_TOPIC,'0x'+'0'*64,'0x'+owner[2:].rjust(64,'0')],'data':hex(2_000_000)}]}
    monkeypatch.setattr(EVMNative,'_rpc',lambda *a:receipt)
    p=CoinbaseWallet(config={'backend':'cdp_v2','wallet_address':owner,'wallet_secret':'fixed-test','rpc_urls':{'base':'http://base'}})
    q=p.quote(chain='base',token_in='ETH',token_out=token,amount_in=1)
    assert q.min_out==1.99
    events=[]
    result=p.swap(chain='base',token_in='ETH',token_out=token,amount_in=1,live=True,min_out=1.98,execution_id='approval',on_broadcast=events.append)
    assert result.ok and result.amount_out==2 and events[0]['tx_hash']=='tx'
    assert calls[0]['idempotency_key']
    with pytest.raises(WalletPolicyDenied,match='minimum'):p.swap(chain='base',token_in='ETH',token_out=token,amount_in=1,live=True,min_out=2.01)
    assert len(calls)==1


def test_bitget_current_cli_quote_and_confirm_floor(monkeypatch):
    from nerya.wallet.providers.bitget import BitgetWalletSkill
    p=BitgetWalletSkill(config={'wallet_address':'owner','token_symbols':{'mint':'MEME'}})
    calls=[]
    def run(args,**kw):
        calls.append(args)
        return {'error_code':0,'data':{'quoteResults':[{'market':{'id':'router','protocol':'v1'},'outAmount':'2','minAmount':'1.99'}]}}
    monkeypatch.setattr(p,'_run_python_skill',run)
    q=p.quote(chain='solana',token_in='SOL',token_out='mint',amount_in=1,slippage_bps=50)
    assert q.expected_out==2 and q.min_out==1.99
    assert calls[0][0]=='quote' and '--action' not in calls[0]
    assert calls[0][calls[0].index('--slippage')+1]=='0.005'


@pytest.mark.parametrize('bad',[float('nan'),float('inf'),-1,0])
def test_common_quote_contract_rejects_invalid_amount(bad):
    from nerya.wallet.adapter_contract import parse_quote
    with pytest.raises(WalletQuoteError):parse_quote('external',dict(chain='base',token_in='a',token_out='b',amount_in=1,slippage_bps=50),{'expected_out':bad,'min_out':1})


def test_bitget_solana_confirm_build_sign_send_and_recover(monkeypatch):
    import base58
    from nacl.signing import SigningKey
    from nerya.wallet.providers.bitget import BitgetWalletSkill
    from nerya.wallet.providers import bitget_official
    from nerya.wallet.providers.self_custody import SelfCustodyWallet
    from nerya.connectors.solana_native import _pubkey_from_signer,SolanaNative
    key='11'*32;sk=SigningKey(bytes.fromhex(key));owner=_pubkey_from_signer(key)
    message=bytes([128,1,0,1,2])+bytes(sk.verify_key)+bytes(range(32))+bytes(32)+bytes([0,0])
    encoded=base58.b58encode(bytes([1])+bytes(64)+message).decode();calls=[];events=[]
    p=BitgetWalletSkill(config={'wallet_address':owner,'signer_ref':'vault://test','token_symbols':{'mint':'MEME'}})
    def call(provider,action,params,*,payload=None):
        calls.append(action)
        if action=='quote':return {'quoteResults':[{'market':{'id':'router','protocol':'v1'},'outAmount':'2','minAmount':'1.99'}]}
        if action=='confirm':return {'orderId':'ref','quoteResult':{'outAmount':'2','minAmount':'1.99'}}
        if action=='make-order':return {'txs':[{'chainId':501,'data':encoded}]}
        if action=='send':
            assert events and events[-1]['execution_ref']=='ref'
            raw=base58.b58decode(payload['txs'][0]['sig'])
            sk.verify_key.verify(message,raw[1:65])
            return {}
        if action=='get-order-details':return {'details':{'status':'success','toTxId':events[-1]['tx_hash']}}
        raise AssertionError(action)
    monkeypatch.setattr(bitget_official,'call',call)
    monkeypatch.setattr(SelfCustodyWallet,'_resolve_signer_key',lambda self:key)
    monkeypatch.setattr(SolanaNative,'_rpc',lambda *a:{'value':[{'confirmationStatus':'confirmed','err':None}]})
    monkeypatch.setattr(SolanaNative,'transaction_output',lambda *a:2)
    result=p.swap(chain='solana',token_in='SOL',token_out='mint',amount_in=1,live=True,min_out=1.98,on_broadcast=events.append)
    assert result.ok and result.amount_out==2 and calls==['quote','confirm','make-order','send']
    recovered=p.get_execution_status(request=dict(chain='solana',token_out='mint',amount_in=1),transaction=events[0])
    assert recovered.ok and calls[-1]=='get-order-details'


def test_evm_v2_exact_approval_and_selected_router(monkeypatch):
    from eth_account import Account
    from nerya.wallet.providers.evm_v2 import EvmV2Wallet
    from nerya.wallet.receipts import TRANSFER_TOPIC
    key='11'*32;owner=Account.from_key(key).address
    token_in='0x'+'2'*40;token_out='0x'+'3'*40;router='0x'+'4'*40;calls=[]
    receipt={'status':'0x1','logs':[{'address':token_out,'topics':[TRANSFER_TOPIC,'0x'+'0'*64,'0x'+owner[2:].lower().rjust(64,'0')],'data':hex(2_000_000)}]}
    conn=SimpleNamespace(chain='base',router=router,quote_swap=lambda **kw:dict(amount_in_wei=1_000_000,amount_out_min_wei=1_990_000,path=[token_in,token_out],amount_out=2),
        get_erc20_decimals=lambda t:6,get_erc20_allowance=lambda *a:0,
        approve=lambda **kw:calls.append(('approve',kw)) or {'confirmed':True},
        swap=lambda **kw:calls.append(('swap',kw)) or {'tx_hash':'tx','confirmed':True,'receipt':receipt})
    p=EvmV2Wallet(config={'chain':'base','native_symbol':'ETH'})
    monkeypatch.setattr(p,'_resolve_signer_key',lambda:key)
    monkeypatch.setattr(p,'_bsc_connector',lambda **kw:conn)
    result=p.swap(chain='base',token_in=token_in,token_out=token_out,amount_in=1,live=True,min_out=1.999)
    assert result.ok and result.chain=='base'
    assert calls[0][1]['amount']==1_000_000 and calls[0][1]['spender']==router
    assert calls[1][1]['amount_out_min_wei']==1_999_000 and not calls[1][1]['native_in']


def test_provider_execution_ref_recovers_without_private_methods(tmp_path,monkeypatch):
    from test_wallet_swap_approval import _config,FakeProvider,_payload
    from nerya.wallet import swap_approval
    p=FakeProvider();sent=[]
    def swap(**kw):
        sent.append(True);kw['on_broadcast']({'execution_ref':'order-1','chain':'solana'})
        return WalletSwapResult(provider='byreal',chain='solana',ok=False,extra={'execution_ref':'order-1','status':'submitted'})
    p.swap=swap
    p.get_execution_status=lambda **kw:WalletSwapResult(provider='byreal',chain='solana',ok=True,tx_hash='tx',amount_out=100,extra={'confirmed':True,'amount_out_source':'transaction_meta'})
    monkeypatch.setattr(swap_approval,'build_provider',lambda *a,**kw:p)
    cfg=_config(tmp_path);request,quote=swap_approval.prepare_swap(cfg,_payload())
    result=swap_approval.execute_frozen_swap(cfg,request=request,approved_quote=quote,approval_id_value='ref-test')
    assert result['status']=='submitted'
    recovered=swap_approval.reconcile_execution(cfg,'ref-test')
    assert recovered['status']=='confirmed' and len(sent)==1


def test_adapter_skill_discovery_scripts_and_references(tmp_path):
    import importlib.util
    from nerya.skills.registry import SkillRegistry
    from nerya.workspace.manager import _DEFAULT_ENABLED_SKILLS
    skill=Path(__file__).parents[1]/'nerya/skills/builtin/adapter'
    entry=SkillRegistry.load_builtin().get('adapter')
    assert entry.manifest.id=='adapter' and 'adapter' in _DEFAULT_ENABLED_SKILLS
    for part in (skill/'SKILL.md').read_text().split('](')[1:]:
        link=part.split(')',1)[0]
        if link.startswith('references/'):assert (skill/link).is_file()
    assert not (skill.parent/'onchain-adapter').exists()
    assert 'onchain-adapter' not in SkillRegistry.load_builtin().by_id
    spec=importlib.util.spec_from_file_location('validate_wallet_contract',skill/'scripts/validate_contract.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    request=dict(chain='base',token_in='a',token_out='b',amount_in=1,slippage_bps=50)
    good=module.run(kind='quote',request=request,response={'protocol_version':1,'expected_out':2,'min_out':1.99})
    assert good['ok']
    bad=module.run(kind='quote',request=request,response={'protocol_version':1,'expected_out':2})
    assert not bad['ok']


def test_external_candles_preserve_units_window_and_reject_invalid_ohlc(monkeypatch):
    from nerya.wallet.providers.external import ExternalWallet
    provider=ExternalWallet(config={'adapter_candles':True})
    doc={'chain':'base','token':'mint','price_currency':'USD','candles':[
        dict(ts=t,open=1,high=2,low=.5,close=1.5,volume=3) for t in (300,200,200,100)]}
    monkeypatch.setattr(provider,'_invoke',lambda *a:doc)
    rows=provider.get_token_klines(chain='base',token='mint',start=150,end=250)
    assert len(rows)==1 and rows[0]['ts']==200 and rows[0]['price_currency']=='USD'
    assert rows[0]['_envelope']['mode']=='live'
    doc['candles'][0]['high']=.1
    with pytest.raises(WalletPolicyDenied,match='high/low'):provider.get_token_klines(chain='base',token='mint')


def test_unknown_custodial_success_remains_pending():
    from nerya.wallet.adapter_contract import parse_result
    request=dict(chain='base',token_out='mint',amount_in=1)
    result=parse_result('external',request,dict(ok=True,tx_hash='tx',amount_out=99))
    assert not result.ok and result.amount_out==0 and result.extra['status']=='submitted'


def test_adapter_expired_quote_and_false_confirmation_rejected():
    from nerya.wallet.adapter_contract import parse_quote,parse_result
    request=dict(chain='base',token_in='a',token_out='b',amount_in=1,slippage_bps=50)
    with pytest.raises(WalletQuoteError,match='expired'):parse_quote('external',request,dict(expected_out=2,min_out=1.9,expires_at=1))
    result=parse_result('external',request,dict(ok=False,status='confirmed',confirmed=True,tx_hash='tx',amount_out=2,amount_out_source='receipt'))
    assert not result.ok


def test_control_plane_saves_custom_provider_and_public_config(tmp_path):
    from test_wallet_swap_approval import _config
    from nerya.api.routes_wallet import routes
    from nerya.wallet.providers.external import ExternalWallet
    from nerya.wallet.bindings import resolve_binding
    cfg=_config(tmp_path)
    dispose=register_wallet_provider('custom_dex',lambda config,**kw:ExternalWallet(id='custom_dex',config=config),workspace=tmp_path,
        metadata={'credential_fields':[{'name':'rpc_url','sensitive':False}]})
    try:
        handler=next(fn for method,path,fn in routes() if path=='/wallet/configure')
        result=handler(SimpleNamespace(config=cfg),dict(provider='custom_dex',wallet_id='custom_wallet',config={'rpc_url':'http://localhost:9999'}))
        assert result['ok'],result
        wid,name,config=resolve_binding(cfg,{'wallet_id':'custom_wallet'})
        assert (wid,name)==('custom_wallet','custom_dex') and config['rpc_url']=='http://localhost:9999'
        result=handler(SimpleNamespace(config=cfg),dict(provider='coinbase',wallet_id='cdp',config={'backend':'cdp_v2','wallet_address':'owner','rpc_urls':{'base':'http://base'}}))
        assert result['ok']
        assert resolve_binding(cfg,{'wallet_id':'cdp'})[2]['backend']=='cdp_v2'
    finally:dispose()


def test_evm_bitget_exact_allowance_and_eip1559_signing(monkeypatch):
    from nerya.wallet.providers.bitget import BitgetWalletSkill
    from nerya.wallet.providers import bitget_official
    from nerya.wallet.providers.self_custody import SelfCustodyWallet
    from nerya.connectors.evm_native import EVMNative
    from eth_account import Account
    key='11'*32;owner=Account.from_key(key).address;token='0x'+'2'*40;output='0x'+'3'*40;router='0x'+'4'*40
    p=BitgetWalletSkill(config={'wallet_address':owner,'signer_ref':'vault://fixed','token_symbols':{token:'USDC',output:'MEME'},'rpc_urls':{'base':'http://base'}})
    calls=[];events=[]
    approve='0x095ea7b3'+router[2:].rjust(64,'0')+hex(1_000_000)[2:].rjust(64,'0')
    txs=[{'chainId':8453,'to':to,'data':data,'deriveTransaction':dict(nonce=i,gasLimit=200000,value='0',supportEIP1559=True,maxFeePerGas='2000000000',maxPriorityFeePerGas='1000000000')}
         for i,(to,data) in enumerate(((token,approve),(router,'0x1234')))]
    def call(provider,action,params,*,payload=None):
        calls.append(action)
        if action=='quote':return {'quoteResults':[{'market':{'id':'router','protocol':'v1'},'outAmount':2,'minAmount':1.99}]}
        if action=='confirm':return {'orderId':'ref','quoteResult':{'minAmount':1.99}}
        if action=='make-order':return {'txs':txs}
        if action=='send':
            assert events and len(payload['txs'])==2
            assert all(Account.recover_transaction(item['sig'])==owner for item in payload['txs'])
            return {}
    monkeypatch.setattr(bitget_official,'call',call)
    monkeypatch.setattr(SelfCustodyWallet,'_resolve_signer_key',lambda self:key)
    monkeypatch.setattr(EVMNative,'_verify_chain_id',lambda self:None)
    monkeypatch.setattr(EVMNative,'get_erc20_decimals',lambda *a:6)
    monkeypatch.setattr(EVMNative,'_rpc',lambda *a:None)
    result=p.swap(chain='base',token_in=token,token_out=output,amount_in=1,live=True,min_out=1.98,on_broadcast=events.append)
    assert not result.ok and result.extra['status']=='submitted'
    assert calls==['quote','confirm','make-order','send'] and len(events[0]['tx_hashes'])==2
    calls.clear();txs[0]['data']='0x095ea7b3'+router[2:].rjust(64,'0')+'f'*64
    with pytest.raises(WalletPolicyDenied,match='allowance'):p.swap(chain='base',token_in=token,token_out=output,amount_in=1,live=True,min_out=1.98)
    assert 'send' not in calls


def test_new_chain_external_strategy_approval_through_process_and_recovery(tmp_path,monkeypatch):
    from test_wallet_strategy_execution import setup
    from test_wallet_swap_approval import _approve
    from nerya.core import yaml_io
    from nerya.wallet import swap_approval
    from nerya.trading.order_intents import TradePlan,SizingPolicy
    from nerya.trading.submit import submit_trade_plan
    from nerya.trading.position_book import PositionBook
    from contextlib import closing
    cfg,_,_=setup(tmp_path,monkeypatch)
    adapter=tmp_path/'dex.py'
    adapter.write_text('''import json,sys
x=json.load(sys.stdin);c=x['command']
if c=='describe':o={'swap_chains':['arbitrum'],'minimum_output':'enforced','receipt_polling':True}
elif c=='quote':o={'expected_out':50,'min_out':49.5}
elif c=='swap':o={'status':'submitted','execution_ref':'dex-order','owner':'owner'}
else:o={'status':'confirmed','confirmed':True,'tx_hash':'tx','amount_out':50,'amount_out_source':'receipt'}
print(json.dumps({'protocol_version':1,**o}))
''')
    cfg.data['wallet']={'providers':{'meme_wallet':{'provider':'external','config':{
        'command':[sys.executable,str(adapter)],'chains':['arbitrum'],
        'funding_tokens':{'arbitrum':{'token':'0x'+'1'*40,'symbol':'USDC'}}}}}}
    market='ONCHAIN:arbitrum:0x'+'2'*40
    path=cfg.paths.strategy('s1')/'strategy.yml';doc=yaml_io.load(path);doc['markets']=[market];yaml_io.dump(path,doc)
    path=cfg.paths.strategy('s1')/'limits.yml';doc=yaml_io.load(path);doc['allowed_markets']=[market];yaml_io.dump(path,doc)
    monkeypatch.setattr(swap_approval,'build_provider',build_provider)
    out=submit_trade_plan(cfg,TradePlan(strategy_id='s1',account_id='meme',market=market,action='open_position',side='long',
        sizing=SizingPolicy(method='fixed_usd',fixed_usd=100),confidence=1,source='strategy_runtime'))
    assert out['status']=='pending_approval'
    assert out['wallet_swap']['token_in']=='0x'+'1'*40
    _approve(cfg,out['approval_id'])
    state=swap_approval.reconcile_execution(cfg,out['approval_id'])
    assert state['status']=='confirmed'
    with closing(PositionBook(cfg.paths)) as book:
        assert book.get_share(account_id='meme',strategy_id='s1',market=market).size_share_base==50
    swap_approval.reconcile_execution(cfg,out['approval_id'])
    with closing(PositionBook(cfg.paths)) as book:
        assert book.get_share(account_id='meme',strategy_id='s1',market=market).size_share_base==50
