"""Offline acceptance probes. Real CCXT request builder; no live credentials."""
from pathlib import Path
import json
import socket
import sys
from unittest.mock import patch

import pytest
import ccxt
import nerya.agent
from nerya.connectors.ccxt_adapter import CcxtConnector
from nerya.connectors.cex_base import CEXCredentials
from nerya.sdk.trading_api import TradingAPI
from nerya.tools.native.trading import trade_intent_submit_handler
from nerya.tools.types import ToolCall
from nerya.trading.executors.orchestrator import ExecutorOrchestrator
from nerya.trading.position_book import PositionBook
from nerya.trading.protection_store import ProtectionStore

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
from test_strategy_order_auto_approval import _config, _intent_spec

pytestmark = pytest.mark.smoke


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def denied(*args, **kwargs):
        raise AssertionError('AUDIT_NETWORK_DISABLED')
    monkeypatch.setattr(socket.socket, 'connect', denied)
    monkeypatch.setattr(socket, 'create_connection', denied)


def connector(*, spot=False, contract_size=1.0):
    client = ccxt.bybit()
    symbol = 'BTC/USDT' if spot else 'BTC/USDT:USDT'
    market = {
        'id': 'BTCUSDT', 'symbol': symbol, 'base': 'BTC', 'quote': 'USDT',
        'baseId': 'BTC', 'quoteId': 'USDT', 'settle': None if spot else 'USDT',
        'settleId': None if spot else 'USDT', 'type': 'spot' if spot else 'swap',
        'spot': spot, 'swap': not spot, 'future': False, 'option': False,
        'contract': not spot, 'linear': not spot, 'inverse': False,
        'active': True, 'contractSize': contract_size,
        'precision': {'amount': 0.001, 'price': 0.1},
        'limits': {'amount': {'min': 0.001}, 'cost': {'min': 1}},
        'info': {},
    }
    client.set_markets([market])
    client.load_markets = lambda *a, **k: client.markets
    client.is_unified_enabled = lambda *a, **k: (False, True)
    captured = []
    def endpoint(name):
        def run(request):
            captured.append({'endpoint': name, 'request': dict(request)})
            return {'retCode': 0, 'result': {'orderId': 'audit-order'} if name == 'order/create' else {}}
        return run
    client.privatePostV5OrderCreate = endpoint('order/create')
    client.privatePostV5PositionTradingStop = endpoint('position/trading-stop')
    conn = CcxtConnector(exchange_id='bybit', live=True, credentials=CEXCredentials(api_key='audit-placeholder', api_secret='audit-placeholder'))
    conn._client = client
    return conn, captured, 'BYBIT:' + symbol


@pytest.mark.parametrize('protection', [{}, {'stop_loss': 49000}, {'stop_loss': 49000, 'take_profit': 52000}])
def test_bybit_open_order_preserves_entry_and_attaches_brackets(protection):
    conn, captured, market = connector()
    conn.place_order(market=market, side='buy', order_type='market', size=0.01, reference_price=50000, **protection)
    print('bybit_entry', json.dumps(captured))
    sent = captured[-1]
    assert sent['endpoint'] == 'order/create', 'entry was redirected to a position update'
    assert sent['request'].get('reduceOnly') is not True, 'entry became a reduce-only stop order'
    for src, dst in [('stop_loss','stopLoss'),('take_profit','takeProfit')]:
        if src in protection:
            assert float(sent['request'][dst]) == protection[src]


@pytest.mark.parametrize('order_type,extra', [('limit', {}), ('stop', {}), ('stop_limit', {}), ('stop_limit', {'triggerDirection': 'ascending'})])
def test_bybit_pending_order_builds_valid_request(order_type, extra):
    conn, captured, market = connector()
    conn.place_order(market=market, side='buy', order_type=order_type, size=0.01, price=49000 if order_type in {'limit','stop_limit'} else None, trigger_price=51000 if order_type != 'limit' else None, extra_params=extra, reference_price=50000)
    print('pending_order', json.dumps(captured))
    request = captured[-1]['request']
    assert request['orderType'] in {'Market', 'Limit'}
    if order_type == 'stop_limit':
        assert request.get('price') is not None


def test_spot_stop_keeps_trigger():
    conn, captured, market = connector(spot=True)
    conn.place_order(market=market, side='sell', order_type='stop', size=0.01, trigger_price=49000, reference_price=50000)
    print('spot_stop', json.dumps(captured))
    assert float(captured[-1]['request'].get('triggerPrice') or 0) == 49000


def test_contract_ack_returns_base_units():
    conn, captured, market = connector(contract_size=0.001)
    conn.client.create_order = lambda *a, **kw: {'id': 'audit-contract', 'amount': 100, 'filled': 100, 'average': 50000, 'status': 'closed'}
    ack = conn.place_order(market=market, side='buy', order_type='market', size=0.1, reference_price=50000)
    print('contract_ack', {'requested_base':0.1, 'reported_filled':ack.filled, 'reported_size':ack.size})
    assert ack.filled == pytest.approx(0.1)


def test_agent_bracket_keeps_limit_order(tmp_path):
    cfg = _config(tmp_path)
    spec = _intent_spec('strategy_agent')
    spec.update(order_type='limit', limit_price=49000, time_in_force='post_only', market_snapshot={'price':50000,'age_s':0}, protection={'stop_loss':{'type':'pct','value':0.01}})
    result = trade_intent_submit_handler(ToolCall(name='trade_intent_submit', arguments=spec, id='audit-agent'), config=cfg)
    assert not result.is_error, result
    out = result.content[0].data
    print('agent_limit', json.dumps({'status':out['status'], 'intent':out['intent'], 'order':out.get('order')}))
    assert out['intent']['order_type'] == 'limit'
    assert out['intent']['limit_price'] == 49000
    assert out['intent']['time_in_force'] == 'post_only'


def test_attach_protection_accepts_documented_side(tmp_path):
    cfg = _config(tmp_path)
    api = TradingAPI(config=cfg, skills=None)
    position = PositionBook(cfg.paths).apply_fill(account_id='paper_main', strategy_id='s1', market='mock:BTC/USDT', side='buy', price=50000, size_base=0.01, source='paper')
    api.attach_protection(strategy_id='s1', account_id='paper_main', position_id=position.position_id, market='mock:BTC/USDT', side='buy', stop_loss={'type':'price','value':49000})


def test_attach_protection_starts_executor(tmp_path):
    cfg = _config(tmp_path)
    book = PositionBook(cfg.paths)
    pos = book.apply_fill(account_id='paper_main', strategy_id='s1', market='mock:BTC/USDT', side='buy', price=50000, size_base=0.01, source='paper')
    api = TradingAPI(config=cfg, skills=None)
    out = api.attach_protection(strategy_id='s1', account_id='paper_main', position_id=pos.position_id, market=pos.market, side='long', stop_loss={'type':'price','value':49000})
    orch = ExecutorOrchestrator(cfg)
    active = orch.list_active()
    print('attached', {'response_status':out['status'], 'rule_status':out['rule']['status'], 'executors':len(active)})
    assert any(x.kind == 'position_protection' for x in active)


def test_agent_protected_close_keeps_sell_direction(tmp_path):
    cfg = _config(tmp_path)
    spec = _intent_spec('strategy_agent')
    spec.update(side='sell', plan_action='close_position', protection={'stop_loss':{'type':'price','value':49000}})
    captured = []
    def capture(config, plan, **kwargs):
        captured.append(plan)
        return {'status':'captured'}
    with patch('nerya.trading.submit.submit_trade_plan', capture):
        result = trade_intent_submit_handler(ToolCall(name='trade_intent_submit', arguments=spec, id='audit-close'), config=cfg)
    assert not result.is_error, result
    plan = captured[0]
    print('close_side', {'requested':'sell', 'position_side':plan.side, 'emitted_side':plan.buy_or_sell})
    assert plan.buy_or_sell == 'sell'


def test_agent_bare_close_preserves_action(tmp_path):
    cfg = _config(tmp_path)
    spec = _intent_spec('strategy_agent')
    spec.update(side='sell', plan_action='close_position')
    captured = []
    def capture(config, plan, **kwargs):
        captured.append(plan)
        return {'status':'captured'}
    with patch('nerya.trading.submit.submit_trade_plan', capture):
        result = trade_intent_submit_handler(ToolCall(name='trade_intent_submit', arguments=spec, id='audit-bare-close'), config=cfg)
    assert not result.is_error, result
    print('bare_close', {'requested_action':'close_position', 'actual_action':captured[0].action})
    assert captured[0].action == 'close_position'


def test_script_submit_intent_does_not_silently_drop_protection(tmp_path):
    from test_strategy_execution_modes import _trading
    trading = _trading(_config(tmp_path), mode='paper', account='paper_main')
    captured = []
    def capture(config, plan, **kwargs):
        captured.append(plan)
        return {'status':'captured'}
    with patch('nerya.trading.submit.submit_trade_plan', capture):
        trading.submit_intent(market='mock:BTC/USDT', side='buy', size=100, protection={'stop_loss':{'type':'price','value':49000}}, market_snapshot={'price':50000,'age_s':0})
    print('script_protection', {'plan_protection':str(captured[0].protection), 'meta_protection':captured[0].meta.get('protection')})
    assert captured[0].protection is not None


def test_pending_order_can_be_cancelled_via_sdk(tmp_path, monkeypatch):
    from nerya.trading.submit import submit_trade_intent
    from nerya.trading.executors.market_order import MarketOrderExecutor
    monkeypatch.setattr(MarketOrderExecutor, '_paper_mark_price', lambda *a, **kw: 50000.0)
    cfg = _config(tmp_path)
    spec = _intent_spec('strategy_runtime')
    spec.update(order_type='limit', limit_price=49000)
    out = submit_trade_intent(cfg, spec=spec, market_snapshot={'price':50000,'age_s':0})
    assert out.get('order_id'), out
    assert out['status'] == 'submitted', out
    api = TradingAPI(config=cfg, skills=None)
    canceled = api.cancel_order(strategy_id='s1', order_id=out['order_id'])
    print('cancel_new_order', {'submit_status':out['status'], 'cancel_result':canceled})
    assert canceled.get('ok') is True


@pytest.mark.parametrize('cancel_remaining', [False, True])
def test_partial_fill_keeps_soft_protection(tmp_path, monkeypatch, cancel_remaining):
    from test_round2_trading_fixes import _config as live_config, _account, _VenueStub, _make_partial_ack, _FakeRegistry
    from nerya.trading.order_intents import OrderCandidate, ProtectionRule, StopLossSpec
    from nerya.trading.order_tracker import OrderTracker
    monkeypatch.setenv('NERYA_VAULT_PASSPHRASE','audit-placeholder-passphrase')
    cfg = live_config(tmp_path, accounts=[_account('live_main','live')])
    stub = _VenueStub(place_ack=_make_partial_ack('audit-venue','audit-client',0.1))
    monkeypatch.setattr('nerya.connectors.ConnectorRegistry',lambda **kwargs:_FakeRegistry(stub))
    candidate = OrderCandidate(account_id='live_main', strategy_id='s1', market='fake:BTC/USDT', side='buy', order_type='limit', price=50000, size_base=0.2, notional_usd=10000)
    protection = ProtectionRule(account_id='live_main', strategy_id='s1', market=candidate.market, side='long', stop_loss=StopLossSpec(type='price', value=49000))
    orch = ExecutorOrchestrator(cfg)
    executor = orch.create_market_order(candidate=candidate, protection=protection)
    orch.step_executor(executor)
    if cancel_remaining:
        OrderTracker(cfg.paths).confirm_cancel(executor.run.order_ids[0])
        orch.step_executor(executor)
    position = PositionBook(cfg.paths).get_open(account_id='live_main', strategy_id='s1', market=candidate.market)
    assert position is not None and position.size_base == pytest.approx(0.1)
    rule = ProtectionStore(cfg.paths).get_for_position(position.position_id)
    print('partial_protection', {'canceled_remaining':cancel_remaining, 'executor_state':executor.run.state, 'position_size':position.size_base, 'rule_exists':rule is not None})
    assert rule is not None


def test_protection_only_closes_own_strategy_share(tmp_path, monkeypatch):
    from test_position_protection_executor import _config as protection_config
    from nerya.trading.order_intents import ProtectionRule, StopLossSpec
    from nerya.trading.executors.position_protection import PositionProtectionExecutor
    from nerya.trading.executors.market_order import MarketOrderExecutor
    cfg = protection_config(tmp_path)
    book = PositionBook(cfg.paths)
    pos = book.apply_fill(account_id='paper_main', strategy_id='s1', market='mock:BTC/USDT', side='buy', price=100, size_base=1, source='paper')
    book.apply_fill(account_id='paper_main', strategy_id='s2', market=pos.market, side='buy', price=100, size_base=2, source='paper')
    rule = ProtectionRule(account_id='paper_main', strategy_id='s1', position_id=pos.position_id, market=pos.market, side='long', stop_loss=StopLossSpec(type='price',value=95), status='armed')
    ProtectionStore(cfg.paths).upsert(rule)
    orch = ExecutorOrchestrator(cfg)
    executor = orch.create_position_protection(rule=rule, position_id=pos.position_id)
    monkeypatch.setattr(PositionProtectionExecutor,'_live_mark_price',lambda *a:90.0)
    monkeypatch.setattr(MarketOrderExecutor,'step',lambda self:False)
    orch.step_executor(executor)
    child = orch.get(executor.run.result_json['flatten_executor_id'])
    c = child.config_json['candidate']
    print('strategy_share_protection', {'protected_strategy':'s1','own_share':1,'other_share':2,'close_strategy':c['strategy_id'],'close_size':c['size_base']})
    assert c['strategy_id'] == 's1'
    assert c['size_base'] == pytest.approx(1.0)


@pytest.mark.parametrize('tif,expected',[('gtc', 'GTC'),('ioc','IOC'),('fok','FOK'),('post_only','PostOnly')])
def test_normal_limit_tif_maps_to_bybit(tif, expected):
    conn, captured, market = connector()
    conn.place_order(market=market, side='buy', order_type='limit', size=0.01, price=49000, time_in_force=tif)
    assert captured[-1]['request']['timeInForce'] == expected


def test_dashboard_order_cancel_reaches_venue(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from test_round2_trading_fixes import _config as live_config, _account, _VenueStub, _FakeRegistry
    from nerya.trading.order_intents import OrderCandidate
    from nerya.trading.order_tracker import OrderTracker
    from nerya.trading.order_polling import poll_active_live_orders
    from nerya.api.routes_control_plane import _orders_cancel
    monkeypatch.setenv('NERYA_VAULT_PASSPHRASE','audit-placeholder-passphrase')
    cfg = live_config(tmp_path, accounts=[_account('live_main','live')])
    stub = _VenueStub()
    canceled = []
    stub.cancel_order = lambda **kw: canceled.append(kw)
    registry = _FakeRegistry(stub)
    monkeypatch.setattr('nerya.connectors.ConnectorRegistry',lambda **kwargs:registry)
    orch = ExecutorOrchestrator(cfg)
    executor = orch.create_market_order(candidate=OrderCandidate(account_id='live_main', strategy_id='s1', market='fake:BTC/USDT', side='buy', order_type='limit', price=49000, size_base=0.01, notional_usd=490))
    orch.step_executor(executor)
    order_id = executor.run.order_ids[0]
    reply = _orders_cancel(SimpleNamespace(config=cfg), {'order_id':order_id})
    orch.run_once()
    poll_active_live_orders(cfg, registry=registry)
    order = OrderTracker(cfg.paths).get(order_id)
    print('dashboard_cancel', {'reply':reply,'venue_cancel_calls':len(canceled),'order_state':order.state})
    assert len(canceled) == 1


@pytest.mark.parametrize('endpoint', ['get', 'open', 'closed', 'trades'])
def test_contract_readback_uses_base_units(endpoint):
    conn, _, market = connector(contract_size=0.001)
    raw = {'id':'trade-1' if endpoint == 'trades' else 'venue-1', 'order':'venue-1',
           'symbol':'BTC/USDT:USDT', 'amount':100, 'filled':0 if endpoint == 'open' else 100,
           'average':50000, 'price':50000, 'status':'open' if endpoint == 'open' else 'closed'}
    conn.client.fetch_order = lambda *a, **k: raw
    conn.client.fetch_open_orders = lambda *a, **k: [raw]
    conn.client.fetch_closed_orders = lambda *a, **k: [raw]
    conn.client.fetch_my_trades = lambda *a, **k: [raw]
    if endpoint == 'get':
        ack = conn.get_order(market=market, order_id='venue-1')
    else:
        ack = getattr(conn, {'open':'fetch_open_orders','closed':'fetch_closed_orders','trades':'fetch_my_trades'}[endpoint])()[0]
    assert ack.size == pytest.approx(0.1)
    assert ack.filled == pytest.approx(0 if endpoint == 'open' else 0.1)
    assert ack.order_id == 'venue-1'


def test_bracket_prices_are_not_mistaken_for_exchange_order_ids():
    from nerya.connectors.ccxt_adapter import _extract_bracket_order_ids
    assert _extract_bracket_order_ids({'stopLoss':'49000','takeProfit':'52000'}) == {}


def test_agent_bracket_preserves_metadata_and_entry(tmp_path):
    cfg = _config(tmp_path)
    spec = _intent_spec('strategy_agent')
    spec.update(order_type='stop_limit', limit_price=51010, stop_price=51000, time_in_force='ioc',
        protection={'stop_loss':{'type':'price','value':49000}},
        meta={'connector_params':{'positionIdx':1}, 'leverage':3})
    captured=[]
    with patch('nerya.trading.submit.submit_trade_plan', lambda config,plan,**kw:captured.append(plan) or {'status':'captured'}):
        result=trade_intent_submit_handler(ToolCall(name='trade_intent_submit', arguments=spec,id='params'),config=cfg)
    assert not result.is_error
    plan=captured[0]
    assert plan.entry.order_type == 'stop_limit' and plan.entry.limit_price == 51010
    assert plan.entry.stop_price == 51000 and plan.entry.time_in_force == 'ioc'
    assert plan.meta['connector_params'] == {'positionIdx':1}


def test_replacing_protection_does_not_execute_old_or_other_strategy_rule(tmp_path, monkeypatch):
    from nerya.trading.executors.position_protection import PositionProtectionExecutor
    from nerya.trading.executors.market_order import MarketOrderExecutor
    cfg = _config(tmp_path)
    book=PositionBook(cfg.paths)
    pos=book.apply_fill(account_id='paper_main',strategy_id='s1',market='mock:BTC/USDT',side='buy',price=100,size_base=1,source='paper')
    book.apply_fill(account_id='paper_main',strategy_id='s2',market=pos.market,side='buy',price=100,size_base=2,source='paper')
    api=TradingAPI(config=cfg,skills=None)
    def attach(strategy, stop):
        return api.attach_protection(strategy_id=strategy,account_id='paper_main',position_id=pos.position_id,market=pos.market,side='long',stop_loss={'type':'price','value':stop})
    old=attach('s1',95)
    other=attach('s2',98)
    new=attach('s1',85)
    store=ProtectionStore(cfg.paths)
    assert store.get(old['protection_id']).status == 'released'
    assert store.get_for_position(pos.position_id,strategy_id='s1').protection_id == new['protection_id']
    monkeypatch.setattr(PositionProtectionExecutor,'_live_mark_price',lambda *args:90)
    monkeypatch.setattr(MarketOrderExecutor,'step',lambda self:False)
    orch=ExecutorOrchestrator(cfg)
    orch.run_once()
    exits=[r for r in orch.list_active() if r.kind=='market_order']
    assert len(exits)==1 and exits[0].strategy_id=='s2'
    assert exits[0].config_json['candidate']['size_base']==2
    assert orch.get(old['executor_id']).is_terminal


def test_protection_child_recovery_reuses_same_exit(tmp_path, monkeypatch):
    from test_position_protection_executor import _config as protection_config, _protection
    from nerya.trading.executors.position_protection import PositionProtectionExecutor
    from nerya.trading.executors.market_order import MarketOrderExecutor
    cfg=protection_config(tmp_path)
    orch, executor, rule=_protection(cfg)
    monkeypatch.setattr(PositionProtectionExecutor,'_live_mark_price',lambda *a:90.0)
    monkeypatch.setattr(MarketOrderExecutor,'step',lambda self:False)
    # Simulate a crash after the child persists but before the parent does.
    executor.prepare()
    executor.step()
    child=executor.run.result_json['flatten_executor_id']
    recovered=PositionProtectionExecutor(orch.get(executor.run.executor_id),cfg.paths)
    orch.step_executor(recovered)
    assert recovered.run.result_json['flatten_executor_id']==child
    assert len([r for r in orch.list_active() if r.kind=='market_order'])==1


def test_unsupported_protection_rejected_before_order(tmp_path):
    from nerya.core.errors import IntentValidationError
    from nerya.trading.order_tracker import OrderTracker
    cfg=_config(tmp_path)
    api=TradingAPI(config=cfg,skills=None)
    with pytest.raises(IntentValidationError,match='unsupported'):
        api.open_position(strategy_id='s1',account_id='paper_main',market='mock:BTC/USDT',side='long',
            sizing={'method':'fixed_usd','fixed_usd':100},protection={'stop_loss':{'type':'pnl_usd','value':10}},
            confidence=1,source='strategy_runtime',market_snapshot={'price':50000,'age_s':0})
    assert OrderTracker(cfg.paths).active_orders()==[]


@pytest.mark.parametrize('side,close_side', [('buy','sell'),('sell','buy')])
def test_agent_close_executes_against_own_share(tmp_path, monkeypatch, side, close_side):
    from nerya.trading.submit import submit_trade_intent
    from nerya.trading.executors.market_order import MarketOrderExecutor
    cfg=_config(tmp_path)
    monkeypatch.setattr(MarketOrderExecutor,'_paper_mark_price',lambda *a,**k:50000.0)
    spec=_intent_spec('strategy_agent')
    spec.update(side=side)
    first=submit_trade_intent(cfg,spec=spec,market_snapshot={'price':50000,'age_s':0})
    assert first['status']=='filled',first
    spec.update(side=close_side, plan_action='close_position', market_snapshot={'price':50000,'age_s':0})
    result=trade_intent_submit_handler(ToolCall(name='trade_intent_submit',arguments=spec,id='close'),config=cfg)
    assert not result.is_error,result
    receipt=result.content[0].data
    assert receipt['status']=='filled',receipt
    assert receipt['order']['side']==close_side and receipt['order']['reduce_only'] is True
    assert PositionBook(cfg.paths).get_open(account_id='paper_main',strategy_id='s1',market=spec['market']) is None


def test_background_partial_fill_arms_one_protection_after_restart(tmp_path, monkeypatch):
    from test_round2_trading_fixes import _config as live_config, _account, _VenueStub, _FakeRegistry, _make_partial_ack, _candidate
    from nerya.trading.order_intents import OrderCandidate, ProtectionRule, StopLossSpec
    from nerya.trading.order_polling import poll_active_live_orders
    cfg=live_config(tmp_path,accounts=[_account('live_main','live')])
    monkeypatch.setenv('NERYA_VAULT_PASSPHRASE','audit-placeholder-passphrase')
    venue=_VenueStub()
    registry=_FakeRegistry(venue)
    monkeypatch.setattr('nerya.connectors.ConnectorRegistry',lambda **kw:registry)
    orch=ExecutorOrchestrator(cfg)
    candidate=_candidate()
    executor=orch.create_market_order(candidate=candidate,protection=ProtectionRule(
        strategy_id='s1',account_id='live_main',market=candidate.market,side='long',
        stop_loss=StopLossSpec(type='price',value=49000)))
    orch.step_executor(executor)
    orch.close()
    venue.get_order_queue.append(_make_partial_ack('venue-1','',0.1))
    polled=poll_active_live_orders(cfg,registry=registry)
    assert polled.fills_applied==1
    position=PositionBook(cfg.paths).get_open(account_id='live_main',strategy_id='s1',market=candidate.market)
    rule=ProtectionStore(cfg.paths).get_for_position(position.position_id,strategy_id='s1')
    assert rule is not None and rule.status=='armed'
    restarted=ExecutorOrchestrator(cfg)
    entry=restarted.get(executor.run.executor_id)
    from nerya.trading.executors.market_order import MarketOrderExecutor
    MarketOrderExecutor(entry,cfg.paths)._maybe_attach_protection()
    active=[r for r in restarted.list_active() if r.kind=='position_protection']
    assert len(active)==1 and active[0].protection_id==rule.protection_id


def test_inverse_execution_is_rejected_before_any_venue_write():
    from nerya.core.errors import TradingError
    conn, sent, market=connector()
    conn.markets['BTC/USDT:USDT']['inverse']=True
    with pytest.raises(TradingError,match='inverse'):
        conn.place_order(market=market,side='buy',order_type='market',size=0.01,reference_price=50000)
    assert sent==[]


def test_hard_attachment_never_claims_unplaced_exchange_orders(tmp_path):
    cfg=_config(tmp_path)
    api=TradingAPI(config=cfg,skills=None)
    with pytest.raises(ValueError,match='hard_exchange'):
        api.attach_protection(strategy_id='s1',account_id='paper_main',position_id='missing',
            market='mock:BTC/USDT',side='long',mode='hard',stop_loss={'type':'price','value':49000})
    assert ProtectionStore(cfg.paths).list_active()==[]


def test_cancel_scope_does_not_mutate_live_order(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from test_round2_trading_fixes import _config as live_config, _account
    from nerya.trading.order_tracker import OrderTracker
    from nerya.api.routes_control_plane import _orders_cancel
    cfg=live_config(tmp_path,accounts=[_account('live_main','live')])
    tracker=OrderTracker(cfg.paths)
    order=tracker.register(client_order_id='scope',account_id='live_main',strategy_id='s1',
        market='fake:BTC/USDT',side='buy',order_type='limit',size_base=1,price=100,initial_state='submitted')
    out=_orders_cancel(SimpleNamespace(config=cfg),{'order_id':order.order_id,
        '_auth_actor_id':'test-actor','_auth_scopes':['trade:paper']})
    assert out['error']=='insufficient_trade_scope'
    assert tracker.get(order.order_id).state=='submitted'


def test_fast_runtime_loop_drives_protections_even_if_order_poll_fails(tmp_path, monkeypatch):
    from types import SimpleNamespace
    import nerya.api.local_server as server
    events=[]
    def poll(config):
        events.append('poll')
        raise RuntimeError('temporary poll failure')
    class FakeOrchestrator:
        def __init__(self, config): pass
        def run_once(self): events.append('executors')
        def close(self): pass
    class OneTickThread:
        def __init__(self, *,target,**kw): self.target=target
        def start(self):
            with pytest.raises(StopIteration): self.target()
        def is_alive(self): return False
    monkeypatch.setattr('nerya.trading.order_polling.poll_active_live_orders',poll)
    monkeypatch.setattr('nerya.trading.executors.ExecutorOrchestrator',FakeOrchestrator)
    monkeypatch.setattr(server.threading,'Thread',OneTickThread)
    def end_tick(seconds):
        assert seconds==5.0
        raise StopIteration()
    monkeypatch.setattr(server.time,'sleep',end_tick)
    monkeypatch.setattr(server,'_LIVE_ORDER_POLL_THREADS',{})
    monkeypatch.delenv('NERYA_DISABLE_ORDER_POLLER',raising=False)
    server._start_live_order_poller(SimpleNamespace(config=_config(tmp_path)))
    assert events==['poll','executors']


def test_concurrent_executor_ticks_place_only_once(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from test_round2_trading_fixes import _config as live_config, _account, _VenueStub, _FakeRegistry, _candidate
    from nerya.trading.executors.market_order import MarketOrderExecutor
    cfg=live_config(tmp_path,accounts=[_account('live_main','live')])
    monkeypatch.setenv('NERYA_VAULT_PASSPHRASE','audit-placeholder-passphrase')
    venue=_VenueStub()
    entered, release=Event(),Event()
    original=venue.place_order
    def slow_place(**kwargs):
        entered.set()
        assert release.wait(5)
        return original(**kwargs)
    venue.place_order=slow_place
    monkeypatch.setattr('nerya.connectors.ConnectorRegistry',lambda **kw:_FakeRegistry(venue))
    setup=ExecutorOrchestrator(cfg)
    executor_id=setup.create_market_order(candidate=_candidate()).run.executor_id
    setup.close()
    def tick():
        orch=ExecutorOrchestrator(cfg)
        try:
            return orch.step_executor(MarketOrderExecutor(orch.get(executor_id),cfg.paths))
        finally:
            orch.close()
    with ThreadPoolExecutor(max_workers=2) as pool:
        first=pool.submit(tick)
        assert entered.wait(5)
        try:
            assert pool.submit(tick).result(timeout=5) is False
        finally:
            release.set()
        first.result(timeout=5)
    tick()
    assert venue.place_calls==1


def test_agent_reduce_pct_preserves_exit_direction(tmp_path):
    cfg=_config(tmp_path)
    spec=_intent_spec('strategy_agent')
    spec.update(side='sell',plan_action='reduce_position',protection={'reduce_pct':0.25})
    captured=[]
    with patch('nerya.trading.submit.submit_trade_plan',lambda config,plan,**kw:captured.append(plan) or {'status':'captured'}):
        result=trade_intent_submit_handler(ToolCall(name='trade_intent_submit',arguments=spec,id='reduce'),config=cfg)
    assert not result.is_error,result
    assert captured[0].action=='reduce_position' and captured[0].buy_or_sell=='sell'
    assert captured[0].sizing.method=='reduce_pct' and captured[0].sizing.reduce_pct==0.25


def test_stop_cancels_unfilled_entry_before_flattening(tmp_path,monkeypatch):
    from test_position_protection_executor import _config as protection_config,_protection
    from nerya.trading.order_tracker import OrderTracker
    from nerya.trading.order_intents import OrderCandidate
    from nerya.trading.executors.position_protection import PositionProtectionExecutor
    from nerya.trading.executors.market_order import MarketOrderExecutor
    cfg=protection_config(tmp_path)
    orch,protector,rule=_protection(cfg)
    entry=orch.create_market_order(candidate=OrderCandidate(account_id='paper_main',
        strategy_id=rule.strategy_id,market=rule.market,side='buy',order_type='limit',
        price=80,size_base=1,notional_usd=80))
    monkeypatch.setattr(MarketOrderExecutor,'_paper_mark_price',lambda *a,**kw:100)
    orch.step_executor(entry)
    monkeypatch.setattr(PositionProtectionExecutor,'_live_mark_price',lambda *a:90)
    monkeypatch.setattr(MarketOrderExecutor,'step',lambda self:False)
    orch.step_executor(protector)
    tracker=OrderTracker(cfg.paths)
    assert tracker.get(entry.run.order_ids[0]).state=='canceled'
    child=orch.get(protector.run.result_json['flatten_executor_id'])
    assert child.config_json['candidate']['size_base']==1
    assert child.strategy_id==rule.strategy_id
