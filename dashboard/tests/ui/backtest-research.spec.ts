import { test, expect } from "@playwright/test";
import { parityFixture } from "./command-fixture";

// Isolated presentation fixture; requests are intercepted, never user research.
const ts = "20260928_000000";
const bias = {
  static_temporal_scan: "passed", historical_prefix_only: true, closed_bar_context: true,
  multi_timeframe_close_aligned: true, strategy_order_execution: "next_bar_open",
  end_of_data_signal: "rejected_no_next_bar",
  static_warnings: [{ code: "lookahead_dynamic_shift", file: "main.py", line: 12,
    message: "Dynamic periods require review (isolated UI fixture)." }],
};
const research = { version: 1, scope: "this_run_only", checks: ["dynamic_lookahead", "warmup_stability",
  "out_of_sample", "walk_forward", "cost_stress", "parameter_sensitivity", "ablation"].map(id => ({ id, status: "not_run" })) };
const provenance = { data_kind: "sample", source_revision: "frozen-review-fixture", assumptions: {
  warmup_bars: 100, execution_model_limits: { order_types: "market_only", funding: "not_modeled",
    liquidation: "not_modeled", partial_fills: "not_modeled", maker_taker_fee_split: "not_modeled",
    exchange_precision_and_minimums: "not_modeled", extra_latency_beyond_next_bar: "not_modeled" },
} };
const result = { ok: true, result_type: "backtest_result", strategy_id: "research-fixture", proposal_id: "prp_frozen",
  backtest_ts: ts, title: "Research review · isolated UI fixture", engine: "native", verdict: "WARN",
  start_utc: "2024-01-01T00:00:00Z", end_utc: "2024-01-21T00:00:00Z",
  metrics_display: { total_return_pct: "0.00%", max_drawdown_pct: "0.00%", total_trades: "0" },
  bias_checks: bias, research_checks: research, provenance,
};

for (const mobile of [false, true]) test(`research evidence and scoped review draft (${mobile ? "mobile zh" : "desktop en"})`, async ({ page }) => {
  const zh = mobile;
  await page.setViewportSize(mobile ? {width:390,height:844} : {width:1440,height:1000});
  const fixture = await parityFixture(page, { language: zh ? "zh" : "en", theme: mobile ? "light" : "dark" });
  await page.route("**/api/proxy/agent/session/transcript?**", route => route.fulfill({json: {
    ok:true,session_id:"parity-session",title:"Research UI fixture",count:2,messages:[
      {message_id:"question",role:"user",content:"Inspect this isolated test report. Not market research.",ts:"2026-09-28T00:00:00Z"},
      {message_id:"answer",role:"assistant",content:"Synthetic UI fixture, not performance evidence.",ts:"2026-09-28T00:00:01Z",
        turn:{turn_id:"research-ui",stopped_reason:"end_turn",reply_text:"Synthetic UI fixture, not performance evidence.",
          blocks:[{block:{kind:"tool_result",action:"strategy_backtest",ok:true,result}}]}},
    ],
  }}));
  await page.route("**/api/proxy/strategy/backtests/chart", route => route.fulfill({json:{
    ok:true,strategy_id:result.strategy_id,ts,proposal_id:result.proposal_id,
    chart:{schema_version:"1.0",meta:{bias_checks:bias,research_checks:research,provenance},panels:[],tables:[],summary_cards:[]},
  }}));
  await page.goto("/chat/parity-session");
  const card = page.getByTestId("backtest-result-card");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("backtest-static-status")).toHaveText(zh ? "1 项待复核" : "1 need review");
  await expect(card.getByTestId("backtest-research-status")).toHaveText(zh ? "7 项本次未执行" : "7 not run here");
  await card.screenshot({path:`test-results/backtest-research-card-${mobile ? "mobile" : "desktop"}.png`});
  const details = card.getByTestId("backtest-bias-checks").locator("details");
  await expect(details).not.toHaveAttribute("open", "");
  await details.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(details.locator('[data-check="dynamic_lookahead"]')).toContainText(zh ? "本次未执行" : "Not run here");
  await expect(details).toContainText("Dynamic periods require review");
  await expect(details).toContainText(zh ? "资金费" : "Funding");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await card.screenshot({path:`test-results/backtest-research-detail-${mobile ? "mobile" : "desktop"}.png`});
  await details.locator("summary").click();
  await card.getByTestId("expand-backtest-details").click();
  const report = page.getByTestId("backtest-report");
  await expect(report).toBeVisible();
  await expect(report.getByTestId("backtest-research-status")).toContainText(zh ? "7 项本次未执行" : "7 not run here");
  // Hide the report on a narrow viewport so the conversation action is reachable.
  if (mobile) await page.keyboard.press("Escape");
  await card.getByTestId("backtest-research-review").click();
  const composer = page.locator("[data-chat-composer] textarea").first();
  await expect(composer).toHaveValue(/"source_revision":"frozen-review-fixture"/);
  await expect(composer).toHaveValue(/"proposal_id":"prp_frozen"/);
  await expect(composer).toHaveValue(/20260928_000000/);
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.errors).toEqual([]);
});
