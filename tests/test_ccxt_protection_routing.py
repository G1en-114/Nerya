"""Real CCXT feature tables and request builders; no network or real credentials."""
import json
import socket

import ccxt
import pytest
import nerya.agent  # noqa: F401
from nerya.connectors.ccxt_adapter import CcxtConnector
from nerya.connectors.cex_base import CEXCredentials

pytestmark=pytest.mark.smoke

@pytest.fixture(autouse=True)
def offline(monkeypatch):
    def denied(*args,**kwargs): raise AssertionError('NETWORK_FORBIDDEN')
    monkeypatch.setattr(socket.socket,'connect',denied)
    monkeypatch.setattr(socket,'create_connection',denied)

def adapter(venue,spot=False):
    client=getattr(ccxt,venue)()
    symbol='BTC/USDT' if spot else 'BTC/USDT:USDT'
    market={'id':'BTCUSDT','symbol':symbol,'base':'BTC','quote':'USDT','settle':None if spot else 'USDT',
        'baseId':'BTC','quoteId':'USDT','settleId':None if spot else 'USDT','type':'spot' if spot else 'swap',
        'spot':spot,'swap':not spot,'future':False,'option':False,'contract':not spot,'linear':not spot,
        'inverse':False,'contractSize':1,'precision':{'price':0.1,'amount':0.001},'limits':{},
        'info':{'orderTypes':['MARKET','LIMIT','STOP_MARKET','TAKE_PROFIT_MARKET','STOP','TAKE_PROFIT']}}
    client.set_markets([market])
    client.load_markets=lambda *a,**k:client.markets
    conn=CcxtConnector(exchange_id=venue,live=True,credentials=CEXCredentials(api_key='fixture',api_secret='fixture'))
    conn._client=client
    return conn,client,'VENUE:'+symbol

@pytest.mark.parametrize('venue,spot,side,expected',[
    ('bybit',False,'buy','attached'),('okx',False,'sell','attached'),
    ('bitget',False,'buy','attached'),('bingx',False,'sell','attached'),
    ('phemex',False,'buy','attached'),('bitmart',False,'sell','standalone'),
    ('kucoinfutures',False,'buy','attached'),('kucoinfutures',False,'sell','standalone'),
    ('hyperliquid',False,'buy','standalone'),('binanceusdm',False,'buy','standalone'),
    ('gate',False,'sell','standalone'),('htx',False,'buy','standalone'),
    ('krakenfutures',False,'buy','standalone'),('bitget',True,'buy','local'),
    ('bitmex',False,'buy','standalone'),('deribit',False,'sell','standalone'),
    ('binance',True,'buy','local'),('mexc',True,'buy','local'),('bybit',True,'buy','local'),
])
def test_market_specific_protection_routes(venue,spot,side,expected):
    conn,_,market=adapter(venue,spot)
    assert conn.protection_capabilities(market,order_type='market',side=side,legs=['stop_loss','take_profit'])=={
        'stop_loss':expected,'take_profit':expected}

@pytest.mark.parametrize('venue',['bybit','okx','bitget','bingx','kucoinfutures'])
@pytest.mark.parametrize('order_type',['market','limit'])
def test_attached_params_become_actual_venue_fields(venue,order_type):
    conn,client,market=adapter(venue)
    sent=[]
    def create(symbol,kind,side,amount,price,params):
        builder=client.create_contract_order_request if venue=='kucoinfutures' else client.create_order_request
        request=builder(symbol,kind,side,amount,price,params)
        sent.append(request)
        return {'id':'entry','status':'open','amount':amount,'filled':0,'symbol':symbol}
    client.create_order=create
    conn.place_order(market=market,side='buy',order_type=order_type,size=1,price=50000 if order_type=='limit' else None,
        stop_loss=49000,take_profit=52000,reference_price=50000)
    request=sent[0]
    if venue=='bybit':
        assert request['stopLoss']=='49000' and request['takeProfit']=='52000'
        assert request['tpslMode']=='Partial' and request['side']=='Buy'
    elif venue=='okx':
        assert request['attachAlgoOrds'][0]['slTriggerPx']=='49000'
        assert request['attachAlgoOrds'][0]['tpTriggerPx']=='52000'
    elif venue=='bitget':
        assert request['presetStopLossPrice']=='49000' and request['presetStopSurplusPrice']=='52000'
    elif venue=='bingx':
        assert json.loads(request['stopLoss'])['stopPrice']==49000
        assert json.loads(request['takeProfit'])['stopPrice']==52000
    else:
        assert request['triggerStopDownPrice']=='49000' and request['triggerStopUpPrice']=='52000'

@pytest.mark.parametrize('venue',['binanceusdm','gate'])
@pytest.mark.parametrize('kind',['stop_loss','take_profit'])
def test_standalone_native_exit_has_opposite_side_and_trigger(venue,kind):
    conn,client,market=adapter(venue)
    sent=[]
    def create(symbol,otype,side,amount,price,params):
        sent.append(client.create_order_request(symbol,otype,side,amount,price,params))
        return {'id':'exit','status':'open','amount':amount,'filled':0,'symbol':symbol}
    client.create_order=create
    conn.place_order(market=market,side='sell',order_type='stop',size=1,trigger_price=49000 if kind=='stop_loss' else 52000,
        reduce_only=True,protection_kind=kind,reference_price=50000)
    req=sent[0]
    if venue=='binanceusdm':
        assert req['type']==('STOP_MARKET' if kind=='stop_loss' else 'TAKE_PROFIT_MARKET')
        assert req['side']=='SELL' and req['reduceOnly'] is True
    else:
        assert req['initial']['reduce_only'] is True
        assert req['trigger']['rule']==(2 if kind=='stop_loss' else 1)

def test_unsupported_hard_protection_fails_before_entry():
    from nerya.core.errors import TradingError
    conn,client,market=adapter('mexc',True)
    client.create_order=lambda *a,**kw:pytest.fail('unprotected entry placed')
    with pytest.raises(TradingError,match='cannot host'):
        conn.place_order(market=market,side='buy',order_type='market',size=1,stop_loss=49000,protection_mode='hard_exchange')

def test_binance_entry_does_not_leak_attached_params():
    conn,client,market=adapter('binanceusdm')
    params=[]
    client.create_order=lambda *args:params.append(args[-1]) or {'id':'entry','amount':1,'filled':0}
    ack=conn.place_order(market=market,side='buy',order_type='market',size=1,stop_loss=49000,take_profit=52000,managed_protection=True)
    assert 'stopLoss' not in params[0] and 'takeProfit' not in params[0]
    assert ack.raw['nerya_protection_routes']=={'stop_loss':'standalone','take_profit':'standalone'}


def native_workspace(tmp_path,monkeypatch):
    from copy import deepcopy
    from nerya.core import yaml_io
    from nerya.core.config import Config,DEFAULT_CONFIG
    from nerya.core.paths import WorkspacePaths
    from nerya.trading.position_book import PositionBook
    from nerya.trading.order_intents import ProtectionRule,StopLossSpec,TakeProfitSpec
    from nerya.trading.protection_store import activate_protection
    data=deepcopy(DEFAULT_CONFIG);data['runtime']['live_trading_enabled']=True;data['runtime']['mock_mode']=False
    cfg=Config(paths=WorkspacePaths(root=tmp_path),data=data)
    yaml_io.dump(tmp_path/'nerya.yml',data)
    yaml_io.dump(cfg.paths.accounts_file,{'accounts':[{'id':'live','venue':'binanceusdm','exchange':'binanceusdm','mode':'live',
        'live_trading_enabled':True,'status':'active','permissions':{'read_balances':True,'place_order':True,'cancel_order':True}}]})
    monkeypatch.setenv('NERYA_VAULT_PASSPHRASE','native-test-placeholder')
    conn,client,market=adapter('binanceusdm')
    sent=[];rows={};cancel_calls=[]
    def create(symbol,otype,side,amount,price,params):
        sent.append(dict(params))
        oid='native-'+str(len(sent))
        row={'id':oid,'clientOrderId':params.get('clientOrderId'),'symbol':symbol,'side':side,'amount':amount,
             'filled':0,'status':'open','average':None}
        rows[oid]=row
        return dict(row)
    def fetch(oid,symbol,params=None):
        if params and params.get('clientOrderId'):
            return next(dict(r) for r in rows.values() if r['clientOrderId']==params['clientOrderId'])
        return dict(rows[oid])
    def cancel(oid,symbol,params=None):
        cancel_calls.append((oid,params))
        if rows[oid]['status']!='closed': rows[oid]['status']='canceled'
        return dict(rows[oid])
    client.create_order=create;client.fetch_order=fetch;client.cancel_order=cancel
    client.fetch_ticker=lambda sym:{'last':50000,'bid':49999,'ask':50001}
    class Registry:
        def get(self,*args):return conn
    monkeypatch.setattr('nerya.connectors.ConnectorRegistry',lambda **kwargs:Registry())
    book=PositionBook(cfg.paths)
    pos=book.apply_fill(account_id='live',strategy_id='s1',market=market,side='buy',price=50000,size_base=1,source='live')
    rule=activate_protection(cfg,ProtectionRule(account_id='live',strategy_id='s1',market=market,position_id=pos.position_id,
        side='long',mode='hybrid',stop_loss=StopLossSpec(type='pct',value=.02),take_profit=TakeProfitSpec(type='pct',value=.04),
        native={'routes':{'stop_loss':'standalone','take_profit':'standalone'}}))
    return cfg,conn,book,rule,sent,rows,cancel_calls

def test_native_exits_resize_restart_and_oco(tmp_path,monkeypatch):
    from nerya.trading.executors.orchestrator import ExecutorOrchestrator
    from nerya.trading.protection_store import ProtectionStore
    cfg,conn,book,rule,sent,rows,cancels=native_workspace(tmp_path,monkeypatch)
    orch=ExecutorOrchestrator(cfg)
    orch.run_once()
    assert len(sent)==2 and all(p['reduceOnly'] for p in sent)
    assert sent[0]['stopLossPrice']=='49000.00' or float(sent[0]['stopLossPrice'])==49000
    assert float(sent[1]['takeProfitPrice'])==52000
    orch.close();orch=ExecutorOrchestrator(cfg);orch.run_once()
    assert len(sent)==2
    # More entry fills: cancel old quantities before replacing them.
    book.apply_fill(account_id='live',strategy_id='s1',market=rule.market,side='buy',price=50000,size_base=.5,source='live')
    orch.run_once();orch.run_once()
    assert len(sent)==4 and len(cancels)==2
    assert rows['native-3']['amount']==1.5
    rows['native-4'].update(status='closed',filled=1.5,average=52000)
    orch.run_once();orch.run_once()
    assert rows['native-3']['status']=='canceled'
    assert book.get_share(account_id='live',strategy_id='s1',market=rule.market) is None
    assert len(sent)==4
    assert ProtectionStore(cfg.paths).get(rule.protection_id).status in ('released','triggered')

def test_ambiguous_native_submission_is_adopted_without_replay(tmp_path,monkeypatch):
    from nerya.trading.executors.orchestrator import ExecutorOrchestrator
    cfg,conn,book,rule,sent,rows,cancels=native_workspace(tmp_path,monkeypatch)
    original=conn.client.create_order
    def timeout_once(*args):
        result=original(*args)
        if len(sent)==1:raise TimeoutError('response lost after venue acceptance')
        return result
    conn.client.create_order=timeout_once
    orch=ExecutorOrchestrator(cfg);orch.run_once();orch.run_once();orch.run_once()
    assert len(sent)==2
    from nerya.trading.order_tracker import OrderTracker
    active=OrderTracker(cfg.paths).active_orders()
    assert len(active)==2 and all(o.exchange_order_id for o in active)

def test_pending_native_generation_recovers_before_first_send(tmp_path,monkeypatch):
    from nerya.trading.protection_store import ProtectionStore
    from nerya.trading.executors.orchestrator import ExecutorOrchestrator
    cfg,conn,book,rule,sent,rows,cancels=native_workspace(tmp_path,monkeypatch)
    rule.native['generations']=[{'size':1,'entry_price':50000,'levels':{'stop_loss':49000,'take_profit':52000},
        'executors':{'stop_loss':'exc_recover_sl','take_profit':'exc_recover_tp'},'retired':False}]
    ProtectionStore(cfg.paths).upsert(rule)
    orch=ExecutorOrchestrator(cfg);orch.run_once();orch.run_once()
    assert len(sent)==2

def test_phemex_attached_request_is_native(monkeypatch):
    conn,client,market=adapter('phemex')
    sent=[]
    client.privatePostGOrders=lambda req:sent.append(req) or {'data':{'orderID':'entry','symbol':'BTCUSDT'}}
    conn.place_order(market=market,side='sell',order_type='limit',size=1,price=50000,stop_loss=51000,take_profit=48000)
    assert sent[0]['stopLossRp']=='51000' and sent[0]['takeProfitRp']=='48000'
    assert sent[0]['side']=='Sell'

def test_hyperliquid_native_exits_have_unique_ids_and_correct_trigger_types():
    conn,client,market=adapter('hyperliquid')
    client.markets['BTC/USDT:USDT']['baseId']='0'
    client.check_required_credentials=lambda *a:None
    client.sign_l1_action=lambda *a,**kw:{}
    sent=[]
    def create(symbol,otype,side,amount,price,params):
        sent.append(client.create_orders_request([{'symbol':symbol,'type':otype,'side':side,'amount':amount,'price':price,'params':params}]))
        return {'id':'order-'+str(len(sent)),'amount':amount,'filled':0}
    client.create_order=create
    conn.place_order(market=market,side='buy',order_type='market',size=1,reference_price=50000,
        client_order_id='nerya-entry',stop_loss=49000,take_profit=52000,managed_protection=True)
    for kind,price in [('stop_loss',49000),('take_profit',52000)]:
        conn.place_order(market=market,side='sell',order_type='stop',size=1,trigger_price=price,
            reference_price=50000,client_order_id='nerya-'+kind,protection_kind=kind,reduce_only=True)
    orders=[request['action']['orders'][0] for request in sent]
    assert len({order['c'] for order in orders})==3
    assert orders[0]['b'] and not orders[0]['r']
    assert orders[1]['t']['trigger']['tpsl']=='sl' and orders[1]['r']
    assert orders[2]['t']['trigger']['tpsl']=='tp' and orders[2]['r']


def test_cancel_native_rule_removes_venue_legs(tmp_path,monkeypatch):
    from nerya.trading.executors.orchestrator import ExecutorOrchestrator
    from nerya.trading.protection_store import ProtectionStore
    cfg,conn,book,rule,sent,rows,cancels=native_workspace(tmp_path,monkeypatch)
    orch=ExecutorOrchestrator(cfg);orch.run_once()
    orch.cancel(rule.executor_id)
    assert len(cancels)==2 and all(row['status']=='canceled' for row in rows.values())
    assert ProtectionStore(cfg.paths).get(rule.protection_id).status=='released'

def test_filled_algo_receipt_fetches_actual_child_order():
    conn,client,market=adapter('binanceusdm')
    calls=[]
    def fetch(oid,symbol,params=None):
        calls.append((oid,params))
        if params:return {'id':'algo','status':'closed','filled':0,'info':{'actualOrderId':'child'}}
        return {'id':'child','status':'closed','amount':1,'filled':1,'average':49000}
    client.fetch_order=fetch
    ack=conn.get_order(market=market,order_id='algo',query_params={'trigger':True})
    assert ack.filled==1 and ack.avg_price==49000 and calls[-1]==('child',None)

def test_closed_trigger_without_trade_evidence_is_not_reported_filled():
    conn,client,market=adapter('binanceusdm')
    client.fetch_order=lambda *a,**kw:{'id':'algo','status':'closed','filled':0,'info':{'algoStatus':'TRIGGERED'}}
    assert conn.get_order(market=market,order_id='algo',query_params={'trigger':True}).status=='new'

@pytest.mark.parametrize('venue',['bitmart','krakenfutures','bitmex','deribit'])
@pytest.mark.parametrize('kind',['stop_loss','take_profit'])
@pytest.mark.parametrize('side',['buy','sell'])
def test_additional_perpetual_native_trigger_builders(venue,kind,side):
    conn,client,market=adapter(venue);sent=[]
    if venue in ('bitmart','krakenfutures'):
        fn=client.create_swap_order_request if venue=='bitmart' else client.create_order_request
        client.create_order=lambda s,t,d,a,p,k:sent.append(fn(s,t,d,a,p,k)) or {'id':'exit'}
    elif venue=='bitmex':
        client.privatePostOrder=lambda req:sent.append(req) or {'orderID':'exit','symbol':'BTCUSDT'}
    else:
        fn=lambda req:sent.append(req) or {'result':{'order':{'order_id':'exit','instrument_name':'BTCUSDT'}}}
        client.privateGetBuy=fn;client.privateGetSell=fn
    conn.place_order(market=market,side=side,order_type='stop',size=1,trigger_price=49000,
        protection_kind=kind,reduce_only=True,reference_price=50000)
    req=sent[0]
    if venue=='bitmart':
        assert req['type']==kind and req['side']==(2 if side=='buy' else 3)
    elif venue=='krakenfutures':
        assert req['orderType']==('stp' if kind=='stop_loss' else 'take_profit') and req['reduceOnly'] is True
    elif venue=='bitmex':
        assert req['ordType']==('Stop' if kind=='stop_loss' else 'MarketIfTouched')
        assert 'ReduceOnly' in req['execInst']
    else:
        assert req['type']==('stop_market' if kind=='stop_loss' else 'take_market') and req['reduce_only'] is True

@pytest.mark.parametrize('kind',['stop_loss','take_profit'])
def test_htx_native_exits_use_numeric_client_id_and_algo_kind(kind):
    conn,client,market=adapter('htx');sent=[]
    def create(symbol,otype,side,amount,price,params):
        sent.append(client.create_contract_order_request(symbol,otype,side,amount,price,params))
        return {'id':'exit','filled':0}
    client.create_order=create
    conn.place_order(market=market,side='sell',order_type='stop',size=1,trigger_price=49000,
        protection_kind=kind,reduce_only=True,client_order_id='nerya-tp-sl',reference_price=50000)
    assert sent[0]['type']==('sl' if kind=='stop_loss' else 'tp')
    assert isinstance(sent[0]['algo_client_order_id'],int)
    assert conn.protection_query_params(market,kind)=={'stopLoss' if kind=='stop_loss' else 'takeProfit':True}

def test_native_cancel_timeout_does_not_spawn_replacement_or_local_exit(tmp_path,monkeypatch):
    from nerya.trading.executors.orchestrator import ExecutorOrchestrator
    cfg,conn,book,rule,sent,rows,cancels=native_workspace(tmp_path,monkeypatch)
    orch=ExecutorOrchestrator(cfg);orch.run_once()
    def fail(*a,**k):raise TimeoutError('cancel outcome unknown')
    conn.client.cancel_order=fail
    conn.client.fetch_ticker=lambda sym:{'last':48000,'bid':48000,'ask':48000}
    orch.run_once();orch.run_once()
    assert len(sent)==2
    assert not any(r.executor_id.startswith('exc_exit_') for r in orch.list_active())
    assert orch.get(rule.executor_id).state=='working'

def test_direct_adapter_refuses_unmanaged_deferred_protection():
    from nerya.core.errors import TradingError
    conn,client,market=adapter('binanceusdm')
    client.create_order=lambda *a,**k:pytest.fail('unmanaged naked entry')
    with pytest.raises(TradingError,match='unmanaged'):
        conn.place_order(market=market,side='buy',order_type='market',size=1,stop_loss=49000)

def test_real_fill_path_arms_deferred_exits_in_same_turn(tmp_path,monkeypatch):
    from nerya.trading.executors.orchestrator import ExecutorOrchestrator
    from nerya.trading.order_intents import OrderCandidate,ProtectionRule,StopLossSpec,TakeProfitSpec
    cfg,conn,book,old_rule,sent,rows,cancels=native_workspace(tmp_path,monkeypatch)
    from nerya.trading.protection_store import ProtectionStore
    ProtectionStore(cfg.paths).set_status(old_rule.protection_id,'released')
    original=conn.client.create_order
    def create(*args):
        result=original(*args)
        if args[2]=='buy':
            rows[result['id']].update(filled=args[3],average=50000,status='closed')
            return dict(rows[result['id']])
        return result
    conn.client.create_order=create
    candidate=OrderCandidate(account_id='live',strategy_id='s2',market=old_rule.market,side='buy',
        order_type='market',size_base=.5,notional_usd=25000,meta={'mark_price':50000})
    rule=ProtectionRule(account_id='live',strategy_id='s2',market=old_rule.market,side='long',
        stop_loss=StopLossSpec(type='pct',value=.02),take_profit=TakeProfitSpec(type='pct',value=.04))
    orch=ExecutorOrchestrator(cfg)
    entry=orch.create_market_order(candidate=candidate,protection=rule)
    orch.step_executor(entry)
    assert len(sent)==3
    assert 'stopLoss' not in sent[0] and 'stopLossPrice' in sent[1] and 'takeProfitPrice' in sent[2]
    assert rows['native-2']['amount']==.5 and rows['native-3']['amount']==.5

@pytest.mark.parametrize('venue',['binanceusdm','okx','htx'])
def test_venue_order_id_encoding_is_stable_and_venue_valid(venue):
    conn,_,_=adapter(venue)
    value=conn.venue_client_order_id('nerya-12345678-0')
    assert value==conn.venue_client_order_id('nerya-12345678-0')
    if venue=='okx': assert value.isalnum() and len(value)<=32
    if venue=='htx': assert value.isdigit() and int(value)<2**63

def test_native_stop_also_cancels_remaining_entry_when_share_is_flat(tmp_path,monkeypatch):
    from nerya.trading.executors.orchestrator import ExecutorOrchestrator
    from nerya.trading.order_tracker import OrderTracker
    cfg,conn,book,rule,sent,rows,cancels=native_workspace(tmp_path,monkeypatch)
    orch=ExecutorOrchestrator(cfg);orch.run_once()
    tracker=OrderTracker(cfg.paths)
    entry=tracker.register(client_order_id='remaining-entry',account_id='live',strategy_id='s1',
        market=rule.market,side='buy',order_type='limit',size_base=.5,price=49000)
    tracker.mark_submitted(entry.order_id,exchange_order_id='remaining')
    rows['remaining']={'id':'remaining','symbol':'BTC/USDT:USDT','status':'open','filled':0,'amount':.5,'side':'buy'}
    rows['native-1'].update(status='closed',filled=1,average=49000)
    orch.run_once();orch.run_once();orch.run_once()
    assert rows['remaining']['status']=='canceled'
    assert rows['native-2']['status']=='canceled'
    assert book.get_share(account_id='live',strategy_id='s1',market=rule.market) is None
    assert len(sent)==2
