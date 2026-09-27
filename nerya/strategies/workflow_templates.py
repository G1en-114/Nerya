"""Three executable-contract examples. Paper drafts only, never auto-started.

These illustrate architecture, not profitable trading systems. Market data is
requested through the real SDK; no synthetic candles or performance claims.
"""
from __future__ import annotations

from dataclasses import replace
from typing import Any
from uuid import uuid4

from ..core import yaml_io
from ..core.paths import WorkspacePaths
from ..evolution.strategy_code_generator import StrategyCodeGenerator, StrategyGenerationRequest
from .workflow_graph import WorkflowError
from .workflow_service import view_workflow

TEMPLATES = {
    "multi_script": {"title": "多脚本 · 趋势观察", "description": "双周期数据 → 因子脚本 → 风险检查 → 观察结果。示例只返回 HOLD，不下单。"},
    "script_agent": {"title": "脚本驱动 · Agent 研判", "description": "脚本采集真实市场数据并计算信号，再向策略 Agent 派发结构化研判任务。"},
    "scheduler_agent": {"title": "调度驱动 · Agent 巡检", "description": "独立调度器唤醒策略 Agent，协同市场分析和风险复核；默认不启用调度。"},
}

_INPUTS = '''"""Fetch and publish market observations inside an ordinary script."""
def collect(ctx):
    # @nerya.step collect | 采集行情 | 逐个读取配置品种的 5 分钟和 1 小时 K 线。
    # @nerya.next publish | 行情读取完成
    snapshots = {}
    for timeframe in ("5m", "1h"):
        for market in ctx.config.markets:
            snapshots[f"{market}:{timeframe}"] = ctx.market.candles(market, timeframe=timeframe, limit=40)
    # @nerya.step publish | 发布数据 | 将 observations 交给下游脚本或 Agent。
    return ctx.inputs.publish("observations", snapshots)
'''
_SIGNALS = '''"""Deterministic features; missing observations do not become signals."""
def momentum(snapshots):
    # @nerya.step momentum | 计算价格变化 | 比较每组首尾收盘价；不足两根或起始价非正时跳过。
    signals = {}
    for key, rows in snapshots.items():
        if len(rows) < 2:
            continue
        first, last = float(rows[0]["close"]), float(rows[-1]["close"])
        if first > 0:
            signals[key] = last / first - 1.0
    return signals
'''
_RISK = '''"""An illustrative prefilter, additional to the SDK's mandatory risk gate."""
def review(signals):
    # @nerya.step filter | 筛选波动范围 | 只保留绝对变化不超过 5% 的信号，不代替运行时风控。
    return {key: value for key, value in signals.items() if abs(value) <= 0.05}
'''
_MULTI = '''from nerya.strategies import StrategyContext, StrategyResult
from market_inputs import collect
from signals import momentum
from risk_rules import review


def run(ctx: StrategyContext) -> StrategyResult:
    # @nerya.step collect | 采集双周期行情 | 获取配置品种的真实 K 线。
    # @nerya.next calculate | 采集完成
    snapshots = collect(ctx)
    # @nerya.step calculate | 计算信号 | 计算首尾价格变化并发布 signals。
    # @nerya.next review | 计算完成
    signals = ctx.inputs.publish("signals", momentum(ctx.inputs.read("observations")))
    # @nerya.step review | 检查并记录 | 筛选变化幅度，返回 HOLD 和观察数据，不下单。
    reviewed = review(ctx.inputs.read("signals"))
    return ctx.result.hold(
        reason="Architecture example: observation only, no orders",
        metadata={"signals": signals, "reviewed": reviewed, "sources": list(snapshots)},
    )
'''
_SCRIPT_AGENT = '''from nerya.strategies import StrategyContext, StrategyAgentTask
from market_inputs import collect
from signals import momentum


def run(ctx: StrategyContext) -> StrategyAgentTask:
    # @nerya.step signals | 准备信号 | 从双周期行情计算动量。
    # @nerya.next stop | 没有完整信号
    # @nerya.next dispatch | 存在可用信号
    signals = momentum(collect(ctx))
    if not signals:
        # @nerya.step stop | 停止本轮 | 无有效数据时不派发研判。
        return StrategyAgentTask.skip("No complete market observations; do not invent evidence")
    # @nerya.step dispatch | 派发 Agent 研判 | 提供 observations 和 signals，要求分析证据与风险。
    ctx.inputs.publish("signals", signals)
    return StrategyAgentTask.dispatch(
        outputs=["observations", "signals"],
        prompt=("Review the supplied structured momentum features"
                + ". Ask market_analyst and risk_critic for independent reviews. "
                "Report evidence, uncertainty and risk only; this example must not place orders."),
        session_key={"market": ctx.config.markets[0]},
        metadata={"signals": signals, "workflow_template": "script_agent"},
        reason="script observations ready",
    )
'''
_SCHEDULER_AGENT = '''from nerya.strategies import StrategyContext, StrategyAgentTask


def run(ctx: StrategyContext) -> StrategyAgentTask:
    # @nerya.step dispatch | 派发定期巡检 | 请市场与风险角色读取配置数据，记录缺失证据。
    return StrategyAgentTask.dispatch(
        prompt=("Scheduled market and account review for " + ", ".join(ctx.config.markets)
                + ". Use configured data capabilities. Ask market_analyst to summarize "
                "market evidence and risk_critic to review risks. Record missing data honestly. "
                "This architecture example is review-only: do not place orders or change live settings."),
        session_key={"market": ctx.config.markets[0]},
        metadata={"workflow_template": "scheduler_agent"},
        reason="scheduled review",
    )
'''


def create_workflow_template(paths: WorkspacePaths, payload: dict[str, Any]) -> dict[str, Any]:
    template = str(payload.get("template") or "")
    if template not in TEMPLATES:
        raise WorkflowError("Unknown workflow template")
    accounts, markets = payload.get("accounts"), payload.get("markets")
    if not isinstance(accounts, list) or not accounts or not all(isinstance(a, str) and a.strip() for a in accounts):
        raise WorkflowError("Select at least one paper account reference")
    if not isinstance(markets, list) or not markets or not all(isinstance(m, str) and m.strip() for m in markets):
        raise WorkflowError("At least one concrete market is required")
    info = TEMPLATES[template]
    strategy_id = str(payload.get("strategy_id") or f"wf_{template}_{uuid4().hex[:8]}")
    is_agent = template != "multi_script"
    req = StrategyGenerationRequest(
        strategy_id=strategy_id, title=str(payload.get("title") or info["title"]),
        description=info["description"], prompt=info["description"],
        strategy_class="agent" if is_agent else "trend", execution_mode="agent" if is_agent else "script",
        mode="paper", markets=tuple(markets), accounts=tuple(accounts),
        schedule_every_seconds=900 if template == "scheduler_agent" else 300,
        subagents=("market_analyst", "risk_critic") if is_agent else (),
        policy_overrides={"allow_direct_order": False, "max_single_order_usd": 25, "max_daily_notional_usd": 100},
        create_tuning=True,
        extra_subagent_prompts={
            "market_analyst": "# Market analyst\nReview observed market data. Cite timestamps and missing evidence. Do not place orders.\n",
            "risk_critic": "# Risk critic\nIndependently challenge the thesis, data quality and risk budget. Do not place orders or relax approvals.\n",
        },
    )
    generator = StrategyCodeGenerator(paths)
    files = generator.generate(req, validate=False, create_proposal_record=False).files
    manifest = yaml_io.loads(files["strategy.yml"])
    manifest["schedule"]["enabled"] = False
    manifest["tuning"]["schedule"]["enabled"] = False
    manifest["workflow_template"] = template
    files["strategy.yml"] = yaml_io.dumps(manifest)
    files["main.py"] = {"multi_script": _MULTI, "script_agent": _SCRIPT_AGENT, "scheduler_agent": _SCHEDULER_AGENT}[template]
    if template != "scheduler_agent":
        files.update({"market_inputs.py": _INPUTS, "signals.py": _SIGNALS})
    if template == "multi_script":
        files["risk_rules.py"] = _RISK
    explanations = {
        "main.py": (info["title"], info["description"], "配置的品种、策略上下文和可用行情", "观察结果或 Agent 研判任务"),
        "market_inputs.py": ("采集行情", "遍历配置品种，读取 5m 和 1h 各 40 根 K 线并发布 observations。", "配置的品种与行情服务", "observations：按品种和周期分组的 K 线"),
        "signals.py": ("计算动量", "对每组行情计算末根与首根收盘价之比减一；无有效数据时跳过。", "已采集的 K 线快照", "按品种和周期分组的价格变化率"),
        "risk_rules.py": ("检查信号幅度", "仅保留绝对价格变化率不超过 0.05 的信号。", "计算得到的价格变化率", "通过示例幅度检查的信号"),
    }
    for rel, (title, logic, inputs, outputs) in explanations.items():
        if rel not in files:
            continue
        files[rel] = (
            f"# @nerya.version 1\n# @nerya.title {title}\n# @nerya.description {logic}\n"
            f"# @nerya.logic {logic}\n"
            "# @nerya.rationale 将数据、信号和研判分开，便于检查每一步的依据。\n"
            f"# @nerya.scope {rel} 的示例逻辑；默认调度关闭，不授予交易权限。\n"
            f"# @nerya.input {inputs}\n# @nerya.output {outputs}\n"
            "# @nerya.risk 数据缺失或延迟会影响结论；架构示例不证明策略收益。\n"
            "# @nerya.validation 以候选提案的实际验证记录为准；生成模板不代表通过回测。\n"
            + files[rel]
        )
    result = generator.generate(replace(req, files=files), require_valid=True, initial_state="draft")
    if not result.proposal:
        return {"ok": False, "error": "template_validation_failed", "validation": result.validation.asdict() if result.validation else None}
    return {"ok": True, "strategy_id": strategy_id, "proposal_id": result.proposal.id,
            "state": "draft", "validation": result.validation.asdict() if result.validation else None,
            "workflow": view_workflow(paths, strategy_id, result.proposal.id)}
