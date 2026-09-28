"use client";

import { useLocale } from "next-intl";
import styles from "./BacktestBiasChecks.module.css";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
const labels: Record<string, [string, string]> = {
  dynamic_lookahead: ["动态因果审计", "Dynamic lookahead"],
  warmup_stability: ["预热稳定性", "Warmup stability"],
  out_of_sample: ["独立样本外", "Independent out-of-sample"],
  walk_forward: ["滚动样本外", "Walk-forward"],
  cost_stress: ["成本压力", "Cost stress"],
  parameter_sensitivity: ["参数敏感性", "Parameter sensitivity"],
  ablation: ["组件消融", "Component ablation"],
};
const limitLabels: Record<string, [string, string]> = {
  funding: ["资金费", "Funding"], liquidation: ["保证金强平", "Margin liquidation"],
  partial_fills: ["部分成交", "Partial fills"], maker_taker_fee_split: ["Maker/Taker 费率区分", "Maker/taker fees"],
  exchange_precision_and_minimums: ["精度与最小下单", "Precision & minimums"],
  extra_latency_beyond_next_bar: ["额外执行延迟", "Additional execution latency"],
};

/** Render saved receipts only. Runtime constraints are not per-run dynamic audits. */
export function BacktestBiasChecks({ meta, compact = false }: { meta: Record<string, unknown>; compact?: boolean }) {
  const zh = useLocale().startsWith("zh");
  const checks = object(meta.bias_checks), research = object(meta.research_checks);
  const warnings = (Array.isArray(checks.static_warnings) ? checks.static_warnings : []).map(object)
    .filter(row => text(row.message) || text(row.code));
  const pending = (Array.isArray(research.checks) ? research.checks : []).map(object);
  const recorded = Object.entries(labels).map(([id, label]) => ({ id, label: label[zh ? 0 : 1],
    status: pending.find(row => row.id === id)?.status }));
  const notRun = recorded.filter(row => row.status === "not_run").length;
  const hasResearch = recorded.some(row => typeof row.status === "string");
  const failed = checks.static_temporal_scan === "failed";
  const passed = checks.static_temporal_scan === "passed";
  const staticState = failed ? "failed" : warnings.length ? "review" : passed ? "clear" : "not_recorded";
  const staticLabel = failed ? (zh ? "发现阻断项" : "Blocking findings") : warnings.length
    ? (zh ? `${warnings.length} 项待复核` : `${warnings.length} need review`)
    : passed ? (zh ? "未发现阻断项" : "No blocking patterns") : (zh ? "未记录" : "Not recorded");
  const unknown = zh ? "未记录" : "Not recorded";
  const statusLabel = (value: unknown) => value === "not_run" ? (zh ? "本次未执行" : "Not run here")
    : value === "blocked" ? (zh ? "受阻" : "Blocked") : value === "inconclusive" ? (zh ? "证据不足" : "Inconclusive")
    : value === "failed" ? (zh ? "未通过" : "Failed") : typeof value === "string"
      ? (zh ? "需核对独立报告" : "Review separate evidence") : unknown;
  const assumptions = object(object(meta.provenance).assumptions), limits = object(assumptions.execution_model_limits);
  const omitted = Object.keys(limitLabels).filter(key => limits[key] === "not_modeled");
  const runtime = [
    [zh ? "可见数据" : "Visible data", checks.historical_prefix_only === true && checks.closed_bar_context === true ? (zh ? "闭合历史前缀" : "Closed historical prefix") : unknown],
    [zh ? "多周期数据" : "Multi-timeframe data", checks.multi_timeframe_close_aligned === true ? (zh ? "对应 K 线收盘后可见" : "Available after candle close") : unknown],
    [zh ? "策略订单" : "Strategy orders", checks.strategy_order_execution === "next_bar_open" ? (zh ? "下一可用 K 线开盘成交" : "Next available bar open") : unknown],
    [zh ? "末根信号" : "Final-bar signal", checks.end_of_data_signal === "rejected_no_next_bar" ? (zh ? "没有下一根，不成交" : "No next bar, no signal fill") : unknown],
  ];
  return <section className={styles.evidence} data-testid="backtest-bias-checks" aria-label={zh ? "研究验证与假设" : "Research evidence & assumptions"}>
    <div className={styles.summary}>
      <span>{zh ? "静态扫描" : "Static scan"} <strong data-state={staticState} data-testid="backtest-static-status">{staticLabel}</strong></span>
      <span>{zh ? "深入验证" : "Deeper validation"} <strong data-testid="backtest-research-status">{notRun ? (zh ? `${notRun} 项本次未执行` : `${notRun} not run here`) : hasResearch ? (zh ? "查看独立证据" : "Review separate evidence") : unknown}</strong></span>
    </div>
    <details className={styles.details} open={!compact}>
      <summary>{zh ? "检查明细与执行假设" : "Checks & execution assumptions"}</summary>
      <div className={styles.body}>
        <p>{zh ? "静态扫描不等于动态无泄漏证明，回测完成或经济评估通过也不等于策略已验证。以下状态只对应本次报告。" : "Static scanning is not a dynamic no-leakage proof. Replay completion or an economic PASS is not strategy validation. Statuses below apply to this report only."}</p>
        {!!warnings.length && <div className={styles.warnings} role="note"><h4>{zh ? "需复核的源码提示" : "Source findings to review"}</h4>{warnings.map((row, i) => <p key={i}>{text(row.message) || text(row.code)}{text(row.file) && <code> · {text(row.file)}{typeof row.line === "number" ? `:${row.line}` : ""}</code>}</p>)}</div>}
        <section><h4>{zh ? "引擎时序约束（非动态审计结果）" : "Engine timing constraints (not dynamic audit results)"}</h4>
          <dl className={styles.rows}>{runtime.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>
        <section><h4>{zh ? "独立研究检查" : "Independent research checks"}</h4>
          {!hasResearch ? <p>{zh ? "该报告没有记录深入验证状态，不能按通过处理；其他批次的证据需单独查看。" : "This report did not record deeper validation status. Missing evidence is not a pass; inspect separate experiments independently."}</p>
            : <dl className={styles.rows}>{recorded.map(row => <div key={row.id} data-check={row.id}><dt>{row.label}</dt><dd>{statusLabel(row.status)}</dd></div>)}</dl>}
        </section>
        <section><h4>{zh ? "执行假设与未建模项" : "Execution assumptions & model limits"}</h4>
          <p>{limits.order_types === "market_only" ? (zh ? "订单模型：仅市价单。" : "Order model: market only.") : (zh ? "订单模型范围未记录。" : "Order model scope not recorded.")}
            {typeof assumptions.warmup_bars === "number" && Number.isFinite(assumptions.warmup_bars) ? (zh ? ` 预热配置 ${assumptions.warmup_bars} 根，未因此证明初始化稳定。` : ` Configured warmup: ${assumptions.warmup_bars} bars, not evidence of initialization stability.`) : ""}</p>
          {omitted.length ? <><p className={styles.limits}>{zh ? "未建模：" : "Not modeled: "}{omitted.map(key => limitLabels[key][zh ? 0 : 1]).join(zh ? "、" : ", ")}</p>
            <p>{zh ? "未建模不等于成本为零；资金费或强平缺失时，不应把结果称为完整永续净收益。" : "Not modeled does not mean zero cost. Missing funding or liquidation rules preclude a complete perpetual net-return claim."}</p></>
            : <p>{zh ? "未提供明确的模型缺项清单，不代表已模拟全部交易所约束。" : "No explicit model-limit list was recorded; this does not establish complete exchange simulation."}</p>}
        </section>
      </div>
    </details>
  </section>;
}
