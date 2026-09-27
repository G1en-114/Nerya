"""Opt-in acceptance strategies. Never installed in a normal workspace.

The strategies contain no fabricated observations. The caller supplies real
historical candles for acceptance; unit tests explicitly use fixture data.
"""
from nerya.core import yaml_io

MARKET = "BINANCE:BTCUSDT"
ACCOUNT = "paper_qa"

READ_BARS = '''
def bars_for_event(ctx):
    observed = ctx.trigger.get("candles")
    if observed is not None:
        ctx.inputs.publish("source:bars", observed, source="recorded candle event", data_as_of=ctx.trigger.get("closed_at_utc"))
    return ctx.inputs.source("bars")
'''

SCRIPT = '''from nerya.strategies import StrategyContext

# @nerya step: Closed-candle trend, isolated paper execution only.
def run(ctx: StrategyContext):
    market = ctx.config.markets[0]
    bars = ctx.market.candles(market, timeframe="1h", limit=40)
    if len(bars) < 8:
        return ctx.result.hold(reason="warmup")
    fast = sum(float(b["close"]) for b in bars[-3:]) / 3
    slow = sum(float(b["close"]) for b in bars[-8:]) / 8
    position = ctx.portfolio.position(market)
    if fast > slow and position is None:
        return ctx.trading.open_position(market=market, side="long",
            sizing={"method": "fixed_usd", "fixed_usd": 100}, confidence=0.8,
            reasoning_ref="closed SMA3 exceeds SMA8")
    if fast <= slow and position is not None:
        return ctx.trading.close_position(market=market, side="long", confidence=0.8,
            reasoning_ref="closed SMA3 no longer exceeds SMA8")
    return ctx.result.hold(reason="hold position" if position else "no trend")
'''

GATED = '''from nerya.strategies import StrategyAgentTask
''' + READ_BARS + '''
# @nerya step: Script checks trend and deduplicates before waking the Agent.
def run(ctx):
    bars = bars_for_event(ctx)
    if len(bars) < 8:
        return StrategyAgentTask.stop("warmup", path="warmup")
    stamp = bars[-1]["ts"]
    if ctx.state.get("last_signal") == stamp:
        return StrategyAgentTask.stop("duplicate candle", path="duplicate")
    fast = sum(float(b["close"]) for b in bars[-3:]) / 3
    slow = sum(float(b["close"]) for b in bars[-8:]) / 8
    if fast <= slow:
        return StrategyAgentTask.stop("trend gate not met", path="no_signal")
    ctx.inputs.publish("signal", {"fast": fast, "slow": slow, "candle_ts": stamp, "order_allowed": False})
    ctx.state.set("last_signal", stamp)
    return StrategyAgentTask.dispatch(prompt="根据已提供的真实收盘数据和信号，简要解释趋势、数据截至时间及一个风险。不得下单。",
        sources=["bars"], outputs=["signal"], include_trigger=True, roles=[], path="trend_analysis")
'''

EVENT = '''from nerya.strategies import StrategyAgentTask
''' + READ_BARS + '''
# @nerya step: Each finite candle-close event dispatches the observation Agent.
def build_agent_task(ctx):
    bars_for_event(ctx)
    return StrategyAgentTask.dispatch(prompt="分析这次收盘事件提供的历史行情，用三句话说明走势、数据截至时间和局限。不得下单。",
        sources=["bars"], outputs=[], include_trigger=True, roles=[], path="event_analysis")

def run(ctx):
    return build_agent_task(ctx)
'''


def case(mode: str) -> dict:
    agent = mode != "script"
    sid = {"script": "qa_script_trend", "gated": "qa_script_agent", "event": "qa_event_agent"}[mode]
    title = {"script": "BTC 收盘趋势 · 纯脚本", "gated": "BTC 趋势解读 · 脚本驱动 Agent", "event": "BTC 收盘事件 · 纯 Agent"}[mode]
    manifest = {"version": 1, "strategy_id": sid, "title": title, "mode": "paper", "entrypoint": "main.py:run",
        "execution_mode": "agent" if agent else "script", "agent_task": {"enabled": agent},
        "markets": [MARKET], "accounts": [ACCOUNT], "subagents": [],
        "schedule": {"type": "interval", "every_seconds": 3600, "enabled": False},
        "evaluation": {"mode": "observation" if agent else "trading"},
        "policy": {"allow_direct_order": not agent, "require_subagent_before_order": False,
            "max_single_order_usd": 100, "max_daily_notional_usd": 1000, "min_confidence": 0.5, "max_run_seconds": 10},
        "llm_policy": {"default_tier": "light", "allowed_tiers": ["light"], "max_calls_per_run": 1},
        "data_sources": [{"id": "bars", "provider": "runtime.market", "capability": "candles", "timeframe": "1h", "limit": 40}],
        "agent_context": {"sources": ["bars"], "include_trigger": True, "on_error": "stop"},
        "agent_profile": {"role": "行情观察员。本次没有可用工具，请直接完成纯文本分析，不创建文件、不输出工具调用标签或代码。只使用本次事件数据，不把历史行情说成当前行情。数据截至时间必须原样引用 trigger.closed_at_utc，不要把 captured_at 当行情日期，也不要自己换算 Unix 时间。三句话说明走势、截至时间和风险。不得下单或修改策略。", "allowed_tools": []},
        "agent_session": {"policy":"per_signal", "include_prior_messages":False},
        "agent_execution": {"capabilities": "custom", "tier": "light", "max_iterations": 4, "max_tool_calls": 4, "max_wall_seconds": 90}}
    return {"strategy_id": sid, "title": title, "strategy_class": "agent" if agent else "trend",
        "execution_mode": manifest["execution_mode"], "mode": "paper", "markets": [MARKET], "accounts": [ACCOUNT],
        "create_tuning": False, "files": {"strategy.yml": yaml_io.dumps(manifest),
            "main.py": {"script": SCRIPT, "gated": GATED, "event": EVENT}[mode],
            "strategy.md": f"# {title}\n\n隔离验收候选，使用真实历史收盘行情。策略与定时任务默认不启动。\n\n风险：样本覆盖有限，历史结果不代表未来；Agent 观察回放不构成交易收益证据。\n"}}
