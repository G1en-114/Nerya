import pytest
from nerya.strategies.signal_runner import run_signal_strategy
from nerya.strategies.indicators import alphatrend
from nerya.skills.builtin.backtest.scripts.mock_ctx import MockCtx, MockState, SimpleConfigView
from nerya.skills.builtin.backtest.scripts.config import load_config
from nerya.skills.builtin.backtest.scripts.engine import run_backtest
from nerya.strategies.candle_view import candle_snapshots

pytestmark = pytest.mark.smoke
T=1700006400
def bars(moves):
    return [{"ts":T+i*3600,"open":p,"high":p+1,"low":p-1,"close":p,"volume":1} for i,p in enumerate(moves)]


def test_timestamp_aliases_never_turn_every_candle_into_zero():
    for mult in (1,1000,1000000):
        row=candle_snapshots([{**bars([100])[0],"ts":T*mult}],"1h")[0]
        assert row["ts"] == T
        assert row["timestamp_ms"] == row["open_time_ms"] == row["ts_ms"] == T*1000
        assert row["close_time_ms"] == (T+3600)*1000


def test_state_mapping_setitem_uses_the_scoped_facade():
    state=MockState(); state["value"]={"seen":1}
    assert state["value"]==state.get("value")=={"seen":1}
    assert "value" in state
    del state["value"]
    assert "value" not in state
    with pytest.raises(KeyError): state["missing"]


def test_indicator_metadata_is_not_forwarded_as_an_algorithm_argument():
    from nerya.strategies.signal_runner import indicator_parameters
    original={"name":"alphatrend","period":14,"offset":2}
    assert indicator_parameters(alphatrend, original)=={"period":14,"offset":2}
    assert original["name"]=="alphatrend"
    with pytest.raises(ValueError,match="does not match"):
        indicator_parameters(alphatrend,{"name":"some_other_algorithm"})
    with pytest.raises(ValueError,match="invalid parameters"):
        indicator_parameters(alphatrend,{"unknown_setting":1})


def test_preflight_checks_sdk_parameters_before_market_data_is_loaded(tmp_path):
    from nerya.core import yaml_io
    from nerya.strategies.package import load_package_from_dir
    from nerya.skills.builtin.backtest.scripts.preflight import inspect_package
    body={"version":1,"strategy_id":"preflight_params","mode":"paper","markets":["BINANCE:BTCUSDT"],
          "accounts":["paper_main"],"entrypoint":"main.py:run","timeframe":"1h",
          "schedule":{"type":"interval","every_seconds":3600,"enabled":False},
          "params":{"indicator":{"name":"alphatrend","period":14}}}
    yaml_io.dump(tmp_path/"strategy.yml",body)
    (tmp_path/"main.py").write_text('from nerya.strategies.indicators import alphatrend\nfrom nerya.strategies.signal_runner import run_signal_strategy\ndef run(ctx):\n return run_signal_strategy(ctx, alphatrend)\n')
    cfg=load_config(markets=["BINANCE:BTCUSDT"])
    result,_=inspect_package(load_package_from_dir(tmp_path),cfg)
    assert result["ok"],result["blockers"]
    body["params"]["indicator"]["unknown_setting"]=1
    yaml_io.dump(tmp_path/"strategy.yml",body)
    result,_=inspect_package(load_package_from_dir(tmp_path),cfg)
    assert any(item["code"]=="invalid_indicator_parameters" for item in result["blockers"])


def test_timer_evaluates_all_markets_and_repeat_is_deduped_per_market():
    data={m:bars([100,101]) for m in ("MOCK:A","MOCK:B")}
    cfg=load_config(markets=list(data),overrides={"tf":"1h","warmup_bars":0})
    queue=[]
    ctx=MockCtx("test","MOCK:A",data,data["MOCK:A"][-1],queue,cfg,MockState())
    ctx.config=SimpleConfigView("test",markets=tuple(data),extras={"timeframe":"1h"})
    ctx.trigger={"kind":"schedule"}
    seen=[]
    def signal(rows): seen.append(len(rows)); return {"buy":True,"sell":False}
    run_signal_strategy(ctx,signal)
    assert len(queue)==2 and seen==[2,2]
    result=run_signal_strategy(ctx,signal)
    assert len(queue)==2 and result.reason=="duplicate_closed_candles"


def test_signal_runner_and_sdk_alpha_create_real_simulated_orders_without_extra_mfi():
    prices=[100,110,120,130,120,100,80,60,40,50,90,130,170,180,180,120,80,60,50,100,150,170]
    cfg=load_config(markets=["MOCK:A"],overrides={"tf":"1h","warmup_bars":2})
    result=run_backtest(None,cfg,run_fn=lambda ctx:run_signal_strategy(ctx,alphatrend),
        strategy_config={"strategy_id":"test","timeframe":"1h","markets":["MOCK:A"],
            "params":{"indicator":{"period":2},"lookback":200,"protection":{"stop_loss":{"type":"pct","value":.02}}}},
        candles_by_market={"MOCK:A":bars(prices)})
    assert result.order_attempts>0 and result.trades
    from nerya.skills.builtin.backtest.scripts.order_evidence import execution_evidence
    assert execution_evidence(result)["sdk_errors"] == 0
