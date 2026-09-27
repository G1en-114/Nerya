import socket
from types import SimpleNamespace
import pytest
from nerya.wallet import swap_approval,execution_state
from test_wallet_swap_approval import _config,_payload,FakeProvider

pytestmark=pytest.mark.smoke

@pytest.fixture(autouse=True)
def offline(monkeypatch):
    def denied(*a,**kw):raise AssertionError('NETWORK_DISABLED')
    monkeypatch.setattr(socket.socket,'connect',denied)

def test_broadcast_timeout_reconcile_uses_known_signature_without_resending(tmp_path,monkeypatch):
    cfg=_config(tmp_path);provider=FakeProvider();sent=[]
    def swap(**kw):
        sent.append(True)
        kw['on_broadcast']({'tx_hash':'sig','chain':'solana','owner':'owner','token_out':'mint'})
        raise TimeoutError('connection lost after send')
    provider.swap=swap
    from nerya.wallet.confirmation import read_transaction
    from nerya.connectors.solana_native import SolanaNative
    provider.get_execution_status=lambda **kw:read_transaction('byreal',{},**kw)
    monkeypatch.setattr(SolanaNative,'_rpc',lambda *a:{'value':[{'confirmationStatus':'finalized','err':None}]})
    monkeypatch.setattr(SolanaNative,'transaction_output',lambda *a:100)
    monkeypatch.setattr(swap_approval,'build_provider',lambda *a,**kw:provider)
    request,_=swap_approval.prepare_swap(cfg,_payload())
    with pytest.raises(TimeoutError):
        swap_approval.execute_frozen_swap(cfg,request=request,approved_quote={'min_out':99},approval_id_value='recover')
    assert execution_state.read(cfg,'recover')['transaction']['tx_hash']=='sig'
    out=swap_approval.reconcile_execution(cfg,'recover')
    assert out['status']=='confirmed' and out['result']['amount_out']==100
    swap_approval.execute_frozen_swap(cfg,request=request,approved_quote={'min_out':99},approval_id_value='recover')
    assert len(sent)==1

def test_approval_rejects_unknown_wallet_binding(tmp_path):
    cfg=_config(tmp_path)
    from nerya.wallet.errors import WalletPolicyDenied
    with pytest.raises(WalletPolicyDenied,match='unknown wallet_id'):
        swap_approval.normalize_swap_request(cfg,{**_payload(),'wallet_id':'wrong-wallet'})

def test_okx_evm_signed_swap_checks_floor_and_uses_observed_token_transfer(tmp_path,monkeypatch):
    from eth_account import Account
    from nerya.wallet.providers.okx_os import OkxOsWallet
    from nerya.wallet.receipts import TRANSFER_TOPIC
    from nerya.connectors.evm_native import EVMNative
    key='11'*32;owner=Account.from_key(key).address
    token='0x'+'2'*40;router='0x'+'3'*40
    p=OkxOsWallet(api_key='test',api_secret='test',api_passphrase='test',config={'signer_ref':'vault://test','rpc_urls':{'ethereum':'http://test'}})
    monkeypatch.setattr(p,'_signer_wallet',lambda:SimpleNamespace(_resolve_signer_key=lambda:key))
    requests=[]
    def get(path,params):
        requests.append((path,params))
        return {'data':[{'routerResult':{'toTokenAmount':'2000000'},'tx':{'from':owner,'to':router,'data':'0x1234','value':'1000000000000000000','gas':'300000','minReceiveAmount':'1980000'}}]}
    monkeypatch.setattr(p,'_signed_get',get)
    sent=[]
    def send(self,**kw):
        sent.append(kw)
        return {'tx_hash':'tx','confirmed':True,'receipt':{'logs':[{'address':token,'topics':[TRANSFER_TOPIC,'0x'+'0'*64,'0x'+owner[2:].lower().rjust(64,'0')],'data':hex(1990000)}]}}
    monkeypatch.setattr(EVMNative,'send_raw_transaction',send)
    monkeypatch.setattr(EVMNative,'get_erc20_decimals',lambda *a:6)
    out=p.swap(chain='ethereum',token_in='ETH',token_out=token,amount_in=1,decimals_out=6,min_out=1.98,live=True)
    assert out.ok and out.amount_out==1.99 and out.extra['amount_out_source']=='receipt'
    assert requests[0][0]=='/api/v6/dex/aggregator/swap'
    assert requests[0][1]['slippagePercent']=='0.5'
    assert sent[0]['value']==10**18

def test_unknown_decimals_rejects_before_okx_quote_request(monkeypatch):
    from nerya.wallet.providers.okx_os import OkxOsWallet
    from nerya.wallet.errors import WalletQuoteError
    p=OkxOsWallet(api_key='test',api_secret='test',api_passphrase='test')
    monkeypatch.setattr(p,'_signed_get',lambda *a:pytest.fail('requested quote with guessed decimals'))
    with pytest.raises(WalletQuoteError,match='decimals'):
        p.quote(chain='solana',token_in='mint1',token_out='mint2',amount_in=1)


def test_prebroadcast_refusal_does_not_poison_next_approval(tmp_path,monkeypatch):
    from nerya.wallet.errors import WalletPolicyDenied
    cfg=_config(tmp_path);provider=FakeProvider()
    monkeypatch.setattr(swap_approval,'build_provider',lambda *a,**kw:provider)
    request,quote=swap_approval.prepare_swap(cfg,_payload())
    original=provider.swap
    def refuse(**kw):
        raise WalletPolicyDenied('minimum below approved floor')
    provider.swap=refuse
    with pytest.raises(WalletPolicyDenied):
        swap_approval.execute_frozen_swap(cfg,request=request,approved_quote=quote,approval_id_value='refused')
    assert execution_state.read(cfg,'refused')['status']=='failed'
    provider.swap=original
    result=swap_approval.execute_frozen_swap(cfg,request=request,approved_quote=quote,approval_id_value='fresh')
    assert result['ok']


def test_native_output_is_transaction_specific_and_excludes_reverted_calls():
    from nerya.wallet.receipts import native_received
    owner='0x'+'1'*40;router='0x'+'2'*40
    trace={'type':'CALL','from':owner,'to':router,'value':'0x0','calls':[
        {'type':'CALL','from':router,'to':owner,'value':hex(10**18)},
        {'type':'DELEGATECALL','from':router,'to':owner,'value':hex(10**18)},
        {'type':'CALL','from':router,'to':owner,'value':hex(10**19),'error':'revert','calls':[
            {'type':'CALL','from':router,'to':owner,'value':hex(10**19)}]},
    ]}
    calls=[]
    conn=SimpleNamespace(_rpc=lambda method,args:calls.append(method) or trace)
    assert native_received(conn,'tx',owner)==1
    assert calls==['debug_traceTransaction']
    conn._rpc=lambda *a:None
    assert native_received(conn,'tx',owner) is None


def test_okx_native_output_uses_trace_and_normalizes_token_address(monkeypatch):
    from eth_account import Account
    from nerya.wallet.providers.okx_os import OkxOsWallet
    from nerya.connectors.evm_native import EVMNative
    key='11'*32;owner=Account.from_key(key).address
    p=OkxOsWallet(api_key='test',api_secret='test',api_passphrase='test',config={'signer_ref':'vault://test','rpc_urls':{'ethereum':'http://test'}})
    monkeypatch.setattr(p,'_signer_wallet',lambda:SimpleNamespace(_resolve_signer_key=lambda:key))
    def request(path,params):
        assert params['toTokenAddress']=='0x'+'e'*40
        return {'data':[{'routerResult':{'toTokenAmount':str(2*10**18)},
            'tx':{'to':'0x'+'2'*40,'from':owner,'value':'0','data':'0x1234'}}]}
    monkeypatch.setattr(p,'_signed_get',request)
    # Native-to-native is not a real route; isolate only native output accounting.
    monkeypatch.setattr(EVMNative,'send_raw_transaction',lambda *a,**kw:{'confirmed':True,'tx_hash':'tx','receipt':{}})
    monkeypatch.setattr(EVMNative,'_rpc',lambda *a:{'type':'CALL','from':'0x'+'2'*40,'to':owner,'value':hex(2*10**18)})
    result=p.swap(chain='ethereum',token_in='ETH',token_out='native',amount_in=1,live=True,min_out=1.9)
    assert result.ok and result.amount_out==2 and result.extra['amount_out_source']=='transaction_trace'


def test_allowance_confirmation_cannot_be_booked_as_swap(tmp_path,monkeypatch):
    from nerya.connectors.evm_native import EVMNative
    cfg=_config(tmp_path)
    request=swap_approval.normalize_swap_request(cfg,{**_payload(),'chain':'bsc','token_in':'USDT','token_out':'BNB'})
    execution_state.write(cfg,'approval-only',status='submitted',request=request,
        transaction={'tx_hash':'approve-tx','phase':'approval','chain':'bsc'})
    from nerya.wallet.providers.self_custody import SelfCustodyWallet
    monkeypatch.setattr(swap_approval,'build_provider',lambda *a,**kw:SelfCustodyWallet(config={'rpc_urls':{'bsc':'http://test'}}))
    monkeypatch.setattr(EVMNative,'_rpc',lambda *a:{'status':'0x1','logs':[]})
    result=swap_approval.reconcile_execution(cfg,'approval-only')
    assert result['status']=='failed' and result['error']=='allowance_only_requires_fresh_swap_approval'
