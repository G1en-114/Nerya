import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const SHOTS = "test-results/mock-showcase-artifacts";

const workflow = {
  ok: true,
  strategy_id: "mock-momentum",
  revision: "mock-r1",
  legacy: false,
  can_edit: true,
  manifest: {
    strategy_id: "mock-momentum",
    title: "BTC 趋势突破 · Mock",
    description: "基于多周期趋势、波动率过滤与 Agent 复核的演示策略",
    mode: "paper",
    markets: ["binance:BTC/USDT:USDT", "bybit:ETH/USDT:USDT"],
    runtime: { mode: "scheduled" }
  },
  metadata: { version: 1, nodes: {}, edges: [] },
  source: { proposal_id: null, state: "active", omitted_files: [] },
  agent_defaults: { max_iterations: 6, max_tool_calls: 20, max_wall_seconds: 60, max_parallel: 3, tier: "medium" },
  strategy: {
    id: "strategy",
    enabled: true,
    nodes: [
      { id: "strategy:mock-momentum", kind: "strategy", title: "BTC 趋势突破 · Mock", subtitle: "paper", resource: "mock-momentum", position: { x: 30, y: 120 }, config: { title: "BTC 趋势突破 · Mock", description: "监控 BTC/ETH，趋势成立后交给 Agent 做风险复核。" }, binding: { file: null, path: [] }, editable: true },
      { id: "source:market", kind: "source", title: "市场行情", subtitle: "Candles", resource: "market", position: { x: 320, y: 20 }, config: { capability: "candles", markets: ["binance:BTC/USDT:USDT"] }, binding: { file: null, path: ["data_sources","market"] }, editable: true },
      { id: "script:signals.py", kind: "script", title: "signals.py", subtitle: "Python", resource: "signals.py", position: { x: 320, y: 210 }, content: `# @nerya.title 趋势信号生成
# @nerya.description 读取 1h 与 4h K 线，计算趋势、动量和波动率过滤，只输出候选信号，不直接下单。
# @nerya.input BTC / ETH 多周期 K 线
# @nerya.output candidate_signal: direction, confidence, stop_distance
# @nerya.risk ATR 过高或成交量不足时停止，不生成交易意图。

def run(ctx):
    # @nerya.step load | 读取多周期行情 | 获取 1h / 4h K 线和成交量。
    # @nerya.next trend | 数据完整
    candles = ctx.market.candles(ctx.config.markets[0], timeframe="1h", limit=120)

    # @nerya.step trend | 计算趋势与动量 | EMA 交叉 + ADX + RSI 作为候选方向。
    # @nerya.input candles
    # @nerya.output trend_score
    # @nerya.next filter | 趋势分数超过阈值

    # @nerya.step filter | 波动率与流动性过滤 | ATR 与成交量异常时拒绝信号。
    # @nerya.risk 高波动阶段优先放弃，而不是扩大止损。
    # @nerya.next publish | 风险过滤通过

    # @nerya.step publish | 发布候选信号 | 将结构化信号交给 Strategy Agent 做最终复核。
    # @nerya.output candidate_signal
    return ctx.inputs.publish("candidate_signal", {"side": "long", "confidence": 0.78})`, config: {}, binding: { file: "signals.py", path: null }, editable: true },
      { id: "agent:runtime", kind: "agent", title: "Strategy Agent", subtitle: "Agent", resource: "agent", position: { x: 650, y: 120 }, config: { agent_profile: { title: "策略复核 Agent", role: "结合候选信号、当前仓位和风险预算，决定是否允许下单。" }, max_iterations: 4 }, binding: { file: null, path: ["agent"] }, editable: true },
      { id: "risk:gate", kind: "risk", title: "Risk & approval gate", subtitle: "Gate", resource: "risk", position: { x: 980, y: 120 }, config: { max_position_pct: 0.12, max_daily_loss_pct: 0.03 }, binding: { file: null, path: ["risk"] }, editable: true }
    ],
    edges: [
      { id: "e1", source: "strategy:mock-momentum", target: "source:market", relation: "uses", origin: "manifest", label: "行情" },
      { id: "e2", source: "source:market", target: "script:signals.py", relation: "feeds", origin: "manifest", label: "K 线" },
      { id: "e3", source: "script:signals.py", target: "agent:runtime", relation: "publishes", origin: "manifest", label: "候选信号" },
      { id: "e4", source: "agent:runtime", target: "risk:gate", relation: "checks", origin: "manifest", label: "风险复核" }
    ]
  },
  evolution: {
    id: "evolution",
    enabled: true,
    nodes: [
      { id: "observation:perf", kind: "observation", title: "观察近期表现", subtitle: "Evidence", resource: "obs", position: { x: 80, y: 120 }, config: {}, binding: { file: null, path: null }, editable: false },
      { id: "agent:tuner", kind: "agent", title: "strategy_tuner", subtitle: "Agent", resource: "tuner", position: { x: 410, y: 120 }, config: { agent_profile: { title: "复盘 Agent", role: "分析收益、回撤、错误和错过的机会，提出最小变更。" } }, binding: { file: null, path: ["tuning"] }, editable: true },
      { id: "validation:replay", kind: "validation", title: "Validation & replay", subtitle: "Validation", resource: "validation", position: { x: 750, y: 120 }, config: { require_backtest: true }, binding: { file: null, path: ["validation"] }, editable: true }
    ],
    edges: [
      { id: "v1", source: "observation:perf", target: "agent:tuner", relation: "feeds", origin: "manifest", label: "证据" },
      { id: "v2", source: "agent:tuner", target: "validation:replay", relation: "proposes", origin: "manifest", label: "候选改动" }
    ]
  }
};

const detail = {
  strategy: { id: "mock-momentum", title: "BTC 趋势突破 · Mock", status: "running", mode: "paper", enabled: true, account_id: "paper-main", wallet_id: null, markets: ["binance:BTC/USDT:USDT","bybit:ETH/USDT:USDT"], subagents: ["market_analyst","risk_critic"], trigger_kinds: ["cron"], path: "strategies/mock-momentum" },
  strategy_yml: { strategy_id: "mock-momentum", title: "BTC 趋势突破 · Mock", description: "多周期趋势突破 + Agent 风险复核", mode: "paper" },
  config: {}, limits: {}, prompts: {}, learnings: ""
};

function nowSec() { return Math.floor(Date.now()/1000); }
function candles(base: number, n = 180) {
  const out = [];
  for (let i=0;i<n;i++) {
    const drift = i * 14 + Math.sin(i/6)*420 + Math.sin(i/17)*220;
    const open = base + drift;
    const close = open + Math.sin(i/2.7)*110 + 35;
    const high = Math.max(open, close) + 90 + (i%7)*8;
    const low = Math.min(open, close) - 85 - (i%5)*9;
    out.push({ ts: (nowSec() - (n-i)*3600), open, high, low, close, volume: 1200 + (i%13)*135 });
  }
  return out;
}
function equity() {
  let pnl = -180;
  return Array.from({length: 90}, (_,i) => {
    pnl += 18 + Math.sin(i/4)*22 + (i%17===0 ? -95 : 0);
    return { ts: nowSec() - (90-i)*3600*4, realized_pnl_usd: Number(pnl.toFixed(2)), fees_paid_usd: Number((i*2.9).toFixed(2)) };
  });
}

const perf = {
  ok: true, strategy_id: "mock-momentum",
  kpis: { open_positions: 3, closed_shares: 24, trades_count: 27, wins: 17, losses: 10, total_realized_usd: 1842.73, total_unrealized_usd: 386.42, fees_usd: 148.17, funding_usd: -12.4, last_trade_at: nowSec()-850 },
  positions: [
    { share_id:"p1", market:"BTC/USDT:USDT", venue:"binance", account_id:"paper-main", side:"long", size_share_base:0.084, avg_entry_price:65540, mark_price:67230, unrealized_pnl_usd:141.96, realized_pnl_usd:812.4, fees_usd:48.1, funding_usd:-4.8, notional_usd:5647.32, opened_at:nowSec()-7200, updated_at:nowSec()-30, merged:{position_id:"merged-btc",size_base:0.11,avg_entry_price:65480,mark_price:67230,unrealized_pnl_usd:202.3,co_strategies:["funding-carry"]}},
    { share_id:"p2", market:"ETH/USDT:USDT", venue:"bybit", account_id:"paper-main", side:"long", size_share_base:1.45, avg_entry_price:3340, mark_price:3418, unrealized_pnl_usd:113.1, realized_pnl_usd:534.9, fees_usd:39.4, funding_usd:-3.1, notional_usd:4956.1, opened_at:nowSec()-15400, updated_at:nowSec()-40, merged:null },
    { share_id:"p3", market:"SOL/USDT:USDT", venue:"bybit", account_id:"paper-main", side:"short", size_share_base:18, avg_entry_price:158.7, mark_price:151.4, unrealized_pnl_usd:131.36, realized_pnl_usd:495.43, fees_usd:60.67, funding_usd:-4.5, notional_usd:2725.2, opened_at:nowSec()-9200, updated_at:nowSec()-20, merged:null }
  ],
  orders: Array.from({length:8},(_,i)=>({ order_id:`ord-${i+1}`, venue_order_id:`v-${i+1}`, client_order_id:`c-${i+1}`, account_id:"paper-main", strategy_id:"mock-momentum", market:i%2?"ETH/USDT:USDT":"BTC/USDT:USDT", side:i%3?"buy":"sell", size_base:i%2?0.7:0.025, price:i%2?3370+i*8:66100+i*90, order_type:i%3?"limit":"market", state:i<6?"filled":"open", filled_size:i<6?(i%2?0.7:0.025):0, avg_price:i<6?(i%2?3372+i*8:66120+i*90):null, fee_usd:i<6?2.8+i*0.4:null, created_at:nowSec()-i*1700, updated_at:nowSec()-i*1600 })),
  fills: Array.from({length:8},(_,i)=>({ fill_id:`fill-${i+1}`, order_id:`ord-${i+1}`, account_id:"paper-main", market:i%2?"ETH/USDT:USDT":"BTC/USDT:USDT", side:i%3?"buy":"sell", price:i%2?3372+i*8:66120+i*90, size_base:i%2?0.7:0.025, notional_usd:i%2?2360:1655, fee_usd:2.8+i*0.4, funding_usd:0, ts:nowSec()-i*1700 })),
  equity_curve: equity()
};

const runs = [
  { run_id:"run-003", status:"ok", started_at:new Date(Date.now()-9*60*1000).toISOString(), finished_at:new Date(Date.now()-8.4*60*1000).toISOString(), duration_ms:36000, reason:"Agent approved long continuation", inputs:{trigger:"cron"}, outputs:{result:{status:"ok"}} },
  { run_id:"run-002", status:"hold", started_at:new Date(Date.now()-3*60*60*1000).toISOString(), finished_at:new Date(Date.now()-2.98*60*60*1000).toISOString(), duration_ms:22000, reason:"ATR spike: hold", inputs:{trigger:"cron"}, outputs:{result:{status:"hold"}} }
];

const agentTasks = [
  { task: { task_id:"task-003", status:"ok", started_at:new Date(Date.now()-9*60*1000).toISOString(), finished_at:new Date(Date.now()-8.4*60*1000).toISOString(), duration_ms:34000, session_id:"ses-003", turn_id:"turn-003", final_text:"允许继续持有 BTC 多头，但不加仓。4h 趋势保持向上，1h ATR 已回落；当前组合风险预算约使用 61%。", metadata:{path:"hold_or_manage",selected_roles:["market_analyst","risk_critic"]}, decision:{text:"hold"} }, session_id:"ses-003" }
];

async function mock(page: Page) {
  await page.addInitScript(() => localStorage.setItem("nerya.ui_settings.v1", JSON.stringify({ language: "zh", darkMode: "dark" })));
  await page.route("**/api/**", async route => {
    const req = route.request();
    const url = new URL(req.url());
    const ep = url.pathname.replace(/^\/api\/proxy/,"");
    let result: any = { ok:true, items:[], count:0, total:0 };
    if (ep === "/auth/status") result = { ok:true, local_access:true, mode:"local", password_configured:true, jwt_configured:true, jwt_ttl_seconds:86400, static_token_configured:false };
    else if (ep === "/workspace") result = { root:"fixture", live_trading_enabled:false };
    else if (ep === "/health") result = { status:"ok" };
    else if (ep === "/setup/readiness") result = { status:"ok", data:{checks:[],blocking:[]} };
    else if (ep === "/operator/overview") result = { status:"ok", data:{attention:[],counts:{},accounts:[],strategies:[]} };
    else if (ep === "/operator/nav") result = { ok:true, data:{primary:[],advanced:[]}, primary:[], advanced:[] };
    else if (ep === "/accounts/list") result = { accounts:[], ts:0 };
    else if (ep === "/agent/sessions") result = { sessions:[], has_more:false };
    else if (ep === "/llm/config") result = { ok:true, default_tier:"medium", tiers:[{tier:"medium",provider:"openai",model:"fixture",key_ref:"fixture"}], provider_profiles:[] };
    else if (ep === "/portfolio/summary") result = { accounts:[], totals:{} };
    else if (ep === "/portfolio/pnl") result = { equity_usd:100000, realized_usd:1842.73, total_pnl_usd:2229.15 };
    else if (ep === "/strategy/get") result = detail;
    else if (ep === "/strategy/performance") result = perf;
    else if (ep === "/strategy/files") result = { strategy_id:"mock-momentum", root:"fixture", files:[] };
    else if (ep === "/strategies/runtime/workspace") result = { ok:true, strategy_id:"mock-momentum", manifest:workflow.manifest, schedules:{}, kill_switch:{enabled:false}, runs:{runs,count:runs.length}, history:{ledgers:{orders:{},fills:{},decisions:{}}} };
    else if (ep === "/strategies/runtime/tuning/status") result = { ok:true, strategy_id:"mock-momentum", pending_proposals:[], schedule:{} };
    else if (ep === "/market/candles") {
      const body = req.postDataJSON();
      result = { ok:true, market:body.market, interval:body.interval, candles:candles(body.market.includes("ETH")?3380:65500) };
    }
    else if (ep === "/strategies/runtime/workflow") result = workflow;
    else if (ep === "/strategies/runtime/workflows") result = { ok:true, workflows:[{key:"mock-momentum",strategy_id:"mock-momentum",proposal_id:null,title:"BTC 趋势突破 · Mock",description:"趋势突破 + Agent 复核",mode:"paper",status:"draft",state:"active",execution_mode:"scheduled",counts:{script:1,agent:1,risk:1,source:1},markets:["binance:BTC/USDT:USDT","bybit:ETH/USDT:USDT"]}],total:1 };
    else if (ep === "/strategies/runtime/runs") result = { ok:true, strategy_id:"mock-momentum", runs, count:runs.length };
    else if (ep === "/strategies/runtime/agent_tasks") result = { ok:true, strategy_id:"mock-momentum", tasks:agentTasks, count:agentTasks.length };
    else if (ep === "/strategies/runtime/agent_task") result = { ok:true, strategy_id:"mock-momentum", task_id:"task-003", task:agentTasks[0].task, context_snapshot:{market_regime:"trend",portfolio_risk_used_pct:61,candidate_signal:{side:"long",confidence:0.78,atr_pct:1.9}}, team_snapshot:{results:[{subagent:"market_analyst",ok:true,output:{trend:"bullish",adx:31.4,rsi:62}},{subagent:"risk_critic",ok:true,output:{allow:true,max_additional_notional_usd:0}}]}, prompt:"请复核本次 BTC 候选信号，并结合当前仓位和风险预算决定是否行动。", recorded_turn:{session_id:"ses-003",turn_id:"turn-003",partial:false,messages:[{message_id:"m1",role:"user",content:"BTC 1h 趋势继续向上，候选信号 confidence=0.78。是否加仓？",ts:"2026-09-23T01:52:00+08:00"},{message_id:"m2",role:"assistant",content:"允许继续持有，不加仓。组合风险预算已使用 61%，当前收益风险比不足以支持扩大头寸。",ts:"2026-09-23T01:52:31+08:00"}],events:[{event_id:"e1",call_id:"c1",tool:"market_data.read",phase:"tool_use",ok:null,ts:"2026-09-23T01:52:04+08:00",payload:{payload:{market:"BTC/USDT:USDT",timeframes:["1h","4h"]}}},{event_id:"e2",call_id:"c1",tool:"market_data.read",phase:"tool_result",ok:1,ts:"2026-09-23T01:52:08+08:00",payload:{result:{trend_1h:"bullish",trend_4h:"bullish",adx:31.4,rsi:62,atr_pct:1.9}}},{event_id:"e3",call_id:"c2",tool:"portfolio_summary",phase:"tool_use",ok:null,ts:"2026-09-23T01:52:10+08:00",payload:{payload:{account_id:"paper-main"}}},{event_id:"e4",call_id:"c2",tool:"portfolio_summary",phase:"tool_result",ok:1,ts:"2026-09-23T01:52:12+08:00",payload:{result:{equity_usd:100000,risk_used_pct:61,open_positions:3}}}]} };
    else if (ep === "/agent/stream/events") result = { events:[], cursor:0, latest_seq:0 };
    else if (ep === "/strategies/runtime/tuning/history") result = { ok:true,strategy_id:"mock-momentum",runs:[
      {run_id:"review-003",strategy_id:"mock-momentum",status:"ok",started_at:"2026-09-22T23:10:00+08:00",finished_at:"2026-09-22T23:11:14+08:00",duration_ms:74000,reason:"建议降低高波动阶段的入场频率",proposal_id:"prop-031"},
      {run_id:"review-002",strategy_id:"mock-momentum",status:"hold",started_at:"2026-09-22T17:10:00+08:00",finished_at:"2026-09-22T17:10:48+08:00",duration_ms:48000,reason:"证据不足，暂不修改策略"},
      {run_id:"review-001",strategy_id:"mock-momentum",status:"error",started_at:"2026-09-22T11:10:00+08:00",finished_at:"2026-09-22T11:10:12+08:00",duration_ms:12000,reason:"历史行情缺失"}
    ],has_more:false,next_offset:3,partial:false };
    else if (ep === "/strategies/runtime/tuning/record") {
      const id=url.searchParams.get("run_id")||"review-003";
      result = { ok:true,strategy_id:"mock-momentum",run_id:id,partial:false,record:{run_id:id,strategy_id:"mock-momentum",status:id==="review-001"?"error":id==="review-002"?"hold":"ok",reason:id==="review-003"?"建议降低高波动阶段的入场频率":"复盘记录",request:{note:"自动复盘最近 24 次交易",dry_run:false},subagent_output:{summary:"过去 24 次交易中，ADX<20 且 ATR>2.8% 的 6 次入场贡献 -$412。建议提高波动率过滤阈值并减少震荡阶段交易。"}},audit:{payload:{lookback_trades:24,objectives:["降低回撤","减少震荡期误入场"]},prompt_records:[{prompt:"复盘最近 24 次交易，优先寻找可解释且最小的改进。"}],subagent_output:{summary:"过去 24 次交易中，高波动震荡阶段表现显著偏弱。",proposed_change:"ATR>2.8% 且 ADX<20 时跳过入场",expected_effect:"减少低质量入场"},conversation:[{kind:"tool_use",call_id:"rc1",skill_id:"strategy_history",action:"read",payload:{trades:24}},{kind:"tool_result",call_id:"rc1",ok:true,result:{wins:15,losses:9,net_pnl_usd:1260,max_drawdown_pct:4.7}},{kind:"tool_use",call_id:"rc2",skill_id:"backtest",action:"preview",payload:{change:"volatility filter"}},{kind:"tool_result",call_id:"rc2",ok:true,result:{baseline_pnl:1260,candidate_pnl:1498,baseline_max_dd_pct:4.7,candidate_max_dd_pct:3.8}},{kind:"text",text:"候选修改主要减少震荡阶段入场；收益改善来自少做，而不是放大头寸。"}],steps:[{kind:"prompt",status:"sent"},{kind:"think",status:"ok"},{kind:"act",status:"ok",detail:{skill:"strategy_history.read"}},{kind:"act",status:"ok",detail:{skill:"backtest.preview"}},{kind:"close",status:"ok"}]} };
    }
    else if (ep.includes("strategy/list")) result = { ok:true, strategies:[] };
    await route.fulfill({status:200,json:result});
  });
}

test.beforeAll(()=>mkdirSync(SHOTS,{recursive:true}));

test("mock showcase screenshots", async ({page}) => {
  await mock(page);
  await page.setViewportSize({width:1500,height:1000});
  await page.goto("/strategies/mock-momentum?tab=performance");
  await expect(page.getByTestId("strategy-runtime-details")).toBeVisible();
  await page.screenshot({path:`${SHOTS}/01-running-performance-full.png`,fullPage:true});
  await page.getByTestId("strategy-market-chart").screenshot({path:`${SHOTS}/02-kline-detail.png`});
  await page.getByText("最近订单", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({path:`${SHOTS}/10-orders-fills.png`});

  await page.goto("/strategies?strategy_id=mock-momentum");
  await expect(page.getByText("BTC 趋势突破 · Mock").first()).toBeVisible();
  await page.screenshot({path:`${SHOTS}/03-workflow-overview.png`,fullPage:true});
  await page.getByRole("button", { name: "编辑详情: 趋势信号生成" }).click();
  await expect(page.getByTestId("script-explanation")).toBeVisible();
  await page.getByTestId("workflow-editor-dialog").screenshot({path:`${SHOTS}/04-script-explanation.png`});
  await page.getByRole("button", { name: "关闭详情" }).click();

  await page.getByRole("tab", { name: "运行" }).click();
  await expect(page.getByTestId("workflow-invocation-canvas")).toBeVisible();
  await page.screenshot({path:`${SHOTS}/05-strategy-run-replay.png`,fullPage:true});
  await page.getByTestId("workflow-invocation-canvas").screenshot({path:`${SHOTS}/08-strategy-run-canvas.png`});

  await page.getByRole("tab", { name: "复盘" }).click();
  await page.getByTestId("workflow-review-log-toggle").click();
  await expect(page.getByTestId("workflow-review-activity")).toBeVisible();
  await expect(page.getByTestId("workflow-invocation-canvas")).toHaveAttribute("data-invocation-id", "review-003");
  await page.screenshot({path:`${SHOTS}/06-review-replay.png`,fullPage:true});
  await page.getByTestId("workflow-invocation-canvas").screenshot({path:`${SHOTS}/09-review-canvas.png`});

  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:`${SHOTS}/07-mobile-review.png`,fullPage:true});
});
