"""Wallet strategy → risk → approval → confirmed receipt → strategy position."""
from copy import deepcopy
from contextlib import closing
import time
import socket
from types import SimpleNamespace
import pytest
from nerya.core import yaml_io
from nerya.core.config import Config,DEFAULT_CONFIG
from nerya.core.paths import WorkspacePaths
from nerya.wallet.protocol import WalletQuote,WalletSwapResult
from nerya.wallet import swap_approval
from nerya.trading.order_intents import TradePlan,SizingPolicy
from nerya.trading.submit import submit_trade_plan
from nerya.trading.position_book import PositionBook
from nerya.trading.account_snapshots import AccountSnapshot

pytestmark=pytest.mark.smoke

@pytest.fixture(autouse=True)
def offline(monkeypatch):
    def denied(*a,**kw):raise AssertionError('NETWORK_DISABLED')
    monkeypatch.setattr(socket.socket,'connect',denied)
    monkeypatch.setattr(socket,'create_connection',denied)

def setup(tmp_path,monkeypatch,mode='live'):
    data=deepcopy(DEFAULT_CONFIG);data['runtime']['live_trading_enabled']=True
    data['wallet']={'providers':{'meme_wallet':{'provider':'byreal','config':{'signer_ref':'vault://test'}}}}
    cfg=Config(paths=WorkspacePaths(tmp_path),data=data)
    yaml_io.dump(cfg.paths.accounts_file,{'accounts':[{'id':'meme','venue':'byreal','exchange':'byreal','kind':'chain',
        'wallet_id':'meme_wallet','mode':mode,'status':'active','live_trading_enabled':True,
        'initial_balance_usd':10000,'permissions':{'place_order':True,'read_balances':True,'cancel_order':True}}]})
    market='BYREAL_ONCHAIN:solana:pool@MemeMint'
    yaml_io.dump(cfg.paths.strategy('s1')/'strategy.yml',{'id':'s1','status':mode,'account_id':'meme','markets':[market],
        'live_trading_enabled':True,'paper_trading_enabled':True})
    yaml_io.dump(cfg.paths.strategy('s1')/'limits.yml',{'allowed_markets':[market],'min_confidence':0,'max_single_order_usd':1000,'max_stale_seconds':120})
    monkeypatch.setattr('nerya.wallet.strategy_execution._price',lambda *a:{'price':2,'age_s':0,'_envelope':{'mode':'live'}})
    monkeypatch.setattr('nerya.trading.risk.fresh_snapshot',lambda *a,**kw:AccountSnapshot(snapshot_id='test',account_id='meme',ts=time.time(),
        source='live',nav_usd=10000,cash_by_asset={'USDC':10000},free_by_asset={'USDC':10000},health='ok'))
    calls=[]
    class Provider:
        def quote(self,**kw):
            expected=kw['amount_in']/2 if kw['token_out']=='MemeMint' else kw['amount_in']*2
            return WalletQuote(provider='byreal',chain='solana',token_in=kw['token_in'],token_out=kw['token_out'],
                amount_in=kw['amount_in'],expected_out=expected,min_out=expected*.99,slippage_bps=50)
        def swap(self,**kw):
            calls.append(kw)
            out=self.quote(**kw).expected_out
            kw['on_broadcast']({'tx_hash':'tx-'+str(len(calls)),'chain':'solana','owner':'owner','token_out':kw['token_out']})
            return WalletSwapResult(provider='byreal',chain='solana',ok=True,tx_hash='tx-'+str(len(calls)),
                amount_in=kw['amount_in'],amount_out=out,extra={'confirmed':True,'amount_out_source':'transaction_meta'})
    provider=Provider()
    monkeypatch.setattr(swap_approval,'build_provider',lambda *a,**kw:provider)
    return cfg,market,calls

def test_live_wallet_strategy_approval_executes_and_books_once(tmp_path,monkeypatch):
    cfg,market,calls=setup(tmp_path,monkeypatch)
    plan=TradePlan(strategy_id='s1',account_id='meme',market=market,action='open_position',side='long',
        sizing=SizingPolicy(method='fixed_usd',fixed_usd=100),confidence=1,source='strategy_runtime')
    out=submit_trade_plan(cfg,plan)
    assert out['status']=='pending_approval',out
    assert calls==[]
    from test_wallet_swap_approval import _approve
    result=_approve(cfg,out['approval_id'])
    assert result['resume']['ok'],result
    assert len(calls)==1 and calls[0]['token_out']=='MemeMint'
    with closing(PositionBook(cfg.paths)) as book:
        share=book.get_share(account_id='meme',strategy_id='s1',market=market)
        assert share.size_share_base==50
    repeat=swap_approval.resume_approved(cfg,out['approval_id'])
    assert len(calls)==1
    close=TradePlan(strategy_id='s1',account_id='meme',market=market,action='close_position',side='long',
        sizing=SizingPolicy(method='close_all'),confidence=1,source='strategy_runtime')
    out=submit_trade_plan(cfg,close)
    assert out['status']=='pending_approval',out
    result=_approve(cfg,out['approval_id'])
    assert result['resume']['ok'],result
    assert calls[-1]['token_in']=='MemeMint' and calls[-1]['amount_in']==50
    assert PositionBook(cfg.paths).get_share(account_id='meme',strategy_id='s1',market=market) is None


def test_strategy_market_passes_workspace_and_history_window(tmp_path,monkeypatch):
    from nerya.strategies.context import StrategyMarket
    cfg,market,_=setup(tmp_path,monkeypatch)
    seen=[]
    monkeypatch.setattr('nerya.strategies.context.fetch_candles',lambda *a,**kw:seen.append(kw) or [{'ts':100,'close':2}])
    monkeypatch.setattr('nerya.strategies.context.fetch_public_ticker',lambda *a,**kw:seen.append(kw) or
        {'price':2,'_envelope':{'mode':'live'}})
    data=StrategyMarket(paths=cfg.paths,accounts=('meme',),_registry_factory=lambda:None,config=cfg)
    assert data.candles(market,start=100,end=200)[0]['close']==2
    assert data.mark_price(market)==2
    assert seen[0]['start']==100 and seen[0]['end']==200
    assert all(s['config_like'] is cfg for s in seen)

def test_paper_wallet_strategy_never_invokes_swap(tmp_path,monkeypatch):
    cfg,market,calls=setup(tmp_path,monkeypatch,mode='paper')
    plan=TradePlan(strategy_id='s1',account_id='meme',market=market,action='open_position',side='long',
        sizing=SizingPolicy(method='fixed_usd',fixed_usd=100),confidence=1,source='strategy_runtime')
    out=submit_trade_plan(cfg,plan)
    assert out['status']=='filled' and out['execution_mode']=='paper',out
    assert calls==[]
    from nerya.trading.risk import _strategy_daily_notional
    assert _strategy_daily_notional(cfg.paths,'s1')==100


def test_confirmed_swap_below_floor_still_books_actual_position(tmp_path,monkeypatch):
    cfg,market,calls=setup(tmp_path,monkeypatch)
    provider=swap_approval.build_provider(None,None)
    original=provider.swap
    def below(**kw):
        result=original(**kw);result.amount_out=40
        return result
    provider.swap=below
    plan=TradePlan(strategy_id='s1',account_id='meme',market=market,action='open_position',side='long',
        sizing=SizingPolicy(method='fixed_usd',fixed_usd=100),confidence=1,source='strategy_runtime')
    out=submit_trade_plan(cfg,plan)
    from test_wallet_swap_approval import _approve
    resumed=_approve(cfg,out['approval_id'])['resume']
    result=resumed.get('resume_response',resumed)
    assert not result['ok'] and result['status']=='confirmed'
    assert result['error']=='execution_below_approved_min_out'
    with closing(PositionBook(cfg.paths)) as book:
        assert book.get_share(account_id='meme',strategy_id='s1',market=market).size_share_base==40

def test_wallet_strategy_risk_cap_still_rejects_before_approval(tmp_path,monkeypatch):
    cfg,market,calls=setup(tmp_path,monkeypatch)
    plan=TradePlan(strategy_id='s1',account_id='meme',market=market,action='open_position',side='long',
        sizing=SizingPolicy(method='fixed_usd',fixed_usd=2000),confidence=1,source='strategy_runtime')
    out=submit_trade_plan(cfg,plan)
    assert out['status']=='rejected' and calls==[]

def test_stale_wallet_approval_claim_cannot_rebroadcast(tmp_path,monkeypatch):
    cfg,market,calls=setup(tmp_path,monkeypatch)
    from nerya.db.sqlite import connect
    from nerya.db.repositories import ApprovalRepository
    with closing(connect(cfg.paths.db)) as con:
        repo=ApprovalRepository(con)
        repo.insert(id='wallet-claim',kind='wallet_swap',expires_s=600,payload={'resume_claimed_at':1})
        repo.set_state('wallet-claim','resuming')
    claimed,_=swap_approval._claim_resume(cfg,'wallet-claim')
    assert not claimed


@pytest.mark.parametrize('entry',['agent','script','sdk'])
def test_agent_and_script_reach_wallet_approval_then_receipt(tmp_path,monkeypatch,entry):
    cfg,market,calls=setup(tmp_path,monkeypatch)
    if entry=='agent':
        from nerya.tools.native.trading import trade_intent_submit_handler
        from nerya.tools.types import ToolCall
        result=trade_intent_submit_handler(ToolCall(id='wallet-entry',name='trade_intent_submit',arguments={
            'strategy_id':'s1','account_id':'meme','market':market,'side':'buy','size':100,
            'size_unit':'usd','order_type':'market','confidence':1,'source':'strategy_agent'}),config=cfg)
        assert not result.is_error,result
        out=result.content[0].data
    elif entry=='script':
        from nerya.strategies.context import StrategyTrading
        from test_strategy_execution_modes import _policy
        trading=StrategyTrading(config=cfg,strategy_id='s1',policy=_policy(),accounts=('meme',),
            execution_mode='live',session_id='wallet-script')
        out=trading.submit_intent(market=market,side='buy',size=100,size_unit='usd',confidence=1)
    else:
        from nerya.sdk.trading_api import TradingAPI
        out=TradingAPI(config=cfg,skills=None).open_position(strategy_id='s1',account_id='meme',market=market,
            side='long',sizing={'method':'fixed_usd','fixed_usd':100},confidence=1)
    assert out['status']=='pending_approval',out
    assert not calls
    from test_wallet_swap_approval import _approve
    approved=_approve(cfg,out['approval_id'])
    assert approved['resume']['ok'],approved
    with closing(PositionBook(cfg.paths)) as book:
        assert book.get_share(account_id='meme',strategy_id='s1',market=market).size_share_base==50


def test_pending_dedupe_expires_and_paused_strategy_can_close(tmp_path,monkeypatch):
    from nerya.db.sqlite import connect
    from test_wallet_swap_approval import _approve
    cfg,market,calls=setup(tmp_path,monkeypatch)
    plan=TradePlan(strategy_id='s1',account_id='meme',market=market,action='open_position',side='long',
        sizing=SizingPolicy(method='fixed_usd',fixed_usd=100),confidence=1,source='strategy_runtime')
    first=submit_trade_plan(cfg,plan)
    repeat=swap_approval.request_approval(cfg,request=first['wallet_swap'],quote=first['quote'],actor_id='strategy:s1')
    assert repeat['approval_id']==first['approval_id']
    with closing(connect(cfg.paths.db)) as con:
        import json
        row=con.execute('SELECT payload FROM approvals WHERE id=?',(first['approval_id'],)).fetchone()
        payload=json.loads(row[0]);payload['expires_at']=1
        con.execute('UPDATE approvals SET expires_at=1,payload=? WHERE id=?',(json.dumps(payload),first['approval_id']))
    second=swap_approval.request_approval(cfg,request=first['wallet_swap'],quote=first['quote'],actor_id='strategy:s1')
    assert second['approval_id']!=first['approval_id']
    assert _approve(cfg,second['approval_id'])['resume']['ok']
    doc=yaml_io.load(cfg.paths.strategy('s1')/'strategy.yml');doc['status']='paused'
    yaml_io.dump(cfg.paths.strategy('s1')/'strategy.yml',doc)
    close=TradePlan(strategy_id='s1',account_id='meme',market=market,action='close_position',side='long',
        sizing=SizingPolicy(method='close_all'),confidence=1,source='strategy_runtime')
    out=submit_trade_plan(cfg,close)
    assert out['status']=='pending_approval',out
    result=_approve(cfg,out['approval_id'])
    assert result['resume']['ok'],result
