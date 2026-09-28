"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useContext, useId, useMemo, useState } from "react";
import { useLocale } from "next-intl";
import type { AssistantMessage } from "../../lib/chat";
import { collectBacktestResults, type BacktestResultRef } from "../../lib/backtestResults";
import { financeNumber } from "../../lib/financeDisplay";
import { Icon } from "../icons";
import { StrategyDetailContext } from "./StrategyDetailContext";
import { strategyDetailId, type StrategyDetailTarget } from "../../lib/strategyDetail";
import styles from "./BacktestReplyCards.module.css";
import { BacktestExecutionEvidence } from "../backtest/BacktestExecutionEvidence";
import { BacktestCoverage } from "../backtest/BacktestCoverage";
import { BacktestBiasChecks } from "../backtest/BacktestBiasChecks";
import { BacktestReviewAction } from "../backtest/BacktestReviewAction";
import { factorSourceUrl } from "../../lib/factorLibrary";

const BacktestChart = dynamic(() => import("../backtest/BacktestChart").then(module => module.BacktestChart), { ssr: false });
const evaluationNotes: Record<string, [string, string]> = {
  no_trades: ["没有完整交易，不能用零收益判断策略有效。", "No closed trades; a zero return is not evidence of effectiveness."],
  "risk_breach:max_drawdown": ["最大回撤超过本次回测设定的上限。", "Drawdown exceeded this replay's configured limit."],
  negative_net_return: ["扣除成本后的净收益为负。", "Net return after costs was negative."],
  benchmark_capture_below_threshold: ["回放已完成；但未达到基准参与度评估条件，且收益未超过买入持有基准。", "Replay completed, but the benchmark-capture gate was not met and return did not exceed buy-and-hold."],
  strategy_returned_errors: ["策略在回放中返回了错误，结果需要排查。", "The strategy returned errors during replay; investigate the result."],
  sdk_order_errors: ["下单接口出现异常，即使被策略捕获也不能算执行成功。请查看订单诊断。", "Submission errors occurred, including exceptions caught by the strategy. Inspect order diagnostics."],
  market_data_gaps: ["各品种行情覆盖不一致；缺失时只沿用已知价格估值，不补造 K 线。", "Market coverage differs. Missing marks carry the last known price; candles are not fabricated."],
};

/** A persisted tool receipt is a deliverable even before final prose arrives. */
export function BacktestReplyCards({ message }: { message: AssistantMessage }) {
  const results = useMemo(() => collectBacktestResults({ messages: [message] }), [message]);
  if (!results.length) return null;
  return <div className={styles.results} data-testid="backtest-reply-cards" data-backtest-turn={message.id}>
    {results.map(result => <BacktestResultCard key={result.id} result={result} />)}
  </div>;
}

export function BacktestResultCard({ result }: { result: BacktestResultRef }) {
  const locale = useLocale(), zh = locale.startsWith("zh"), id = useId();
  const [open, setOpen] = useState(false);
  const details = useContext(StrategyDetailContext);
  const reportTarget: StrategyDetailTarget = { kind: "backtest", strategyId: result.strategyId, proposalId: result.proposalId, ts: result.ts, title: result.title };
  const reportId = strategyDetailId(reportTarget);
  const expanded = details ? details.active === reportId : open;
  const openReport = () => details ? details.open(reportTarget) : setOpen(value => !value);
  const openStrategy = () => details?.open({ kind: "strategy", strategyId: result.strategyId, proposalId: result.proposalId, title: result.title });
  const complete = result.status === "completed";
  const observation = result.evaluationMode === "observation" || result.performanceEvidence === false;
  const agentNotRun = result.executionMode === "agent" && result.replay.agent_execution === "not_run";
  const dataLabel = ({ historical: zh ? "真实历史行情" : "Historical market data", sample: zh ? "测试样本" : "Test sample",
    unverified: zh ? "数据待核实" : "Unverified data" } as Record<string,string>)[result.dataKind] || (zh ? "来源未标注" : "Source not recorded");
  const date = (raw: string) => Number.isFinite(Date.parse(raw)) ? new Date(raw).toLocaleString(locale, { year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",timeZone:"UTC" }) : "";
  const values = observation ? result.replay : result.metrics;
  const metrics = observation ? [["decisions", zh ? "历史事件" : "Historical events"], ["dispatches", zh ? "触发 Agent" : "Dispatches"],
    ["skipped", zh ? "跳过 / 去重" : "Skipped / deduped"], ["errors", zh ? "执行错误" : "Errors"]]
    : [["total_return_pct", zh ? "总收益" : "Total return"], ["max_drawdown_pct", zh ? "最大回撤" : "Max drawdown"],
      ["sharpe_ratio", zh ? "夏普比率" : "Sharpe ratio"], ["total_trades", zh ? "完整交易" : "Closed trades"]];
  const format = (key: string, raw: unknown): string => typeof raw === "string" && ["sharpe_ratio","total_trades"].includes(key) && raw.trim() && Number.isFinite(Number(raw)) ? format(key,Number(raw)) : typeof raw === "number" && Number.isFinite(raw)
    ? `${financeNumber(raw, locale, observation || key === "total_trades" ? 0 : 2)}${key.endsWith("_pct") ? "%" : ""}`
    : typeof raw === "string" && raw.trim() && !/^(nan|none|null|undefined|[-+]?inf(?:inity)?|[-+]?∞)$/i.test(raw.trim()) ? raw : "—";
  const verdict = ({ PASS: observation ? (zh ? "回放检查通过" : "Replay checks passed") : (zh ? "经济评估通过" : "Economic checks passed"), WARN: zh ? "需关注局限" : "Review limitations", FAIL: zh ? "未通过评估" : "Evaluation failed" } as Record<string,string>)[result.verdict];
  const points = [...new Map(result.equityPreview.map(p => [p.time,p])).values()].sort((a,b) => a.time-b.time);
  const min = Math.min(...points.map(p=>p.value)), max = Math.max(...points.map(p=>p.value));
  const from = points[0]?.time || 0, span = (points.at(-1)?.time || 0) - from;
  const line = points.length > 1 ? points.map((p,i) => `${i ? "L" : "M"}${(4 + (p.time-from)/(span||1)*552).toFixed(2)},${(max === min ? 32 : 58-(p.value-min)/(max-min)*50).toFixed(2)}`).join(" ") : "";
  const target = result.strategyId ? `/strategies?strategy_id=${encodeURIComponent(result.strategyId)}${result.proposalId ? `&proposal_id=${encodeURIComponent(result.proposalId)}` : ""}` : "";
  return <section className={styles.card} data-testid="backtest-result-card" data-backtest-id={result.id} data-status={result.status}
    data-evaluation={observation ? "observation" : "trading"} aria-label={zh ? "回测结果" : "Backtest result"}>
    <div className={styles.body}>
      <header className={styles.header}>
        <div className={styles.identity}><div className={styles.kind}><Icon name="chart" size={15}/>{observation ? (zh ? "事件与触发回放" : "Event & dispatch replay") : (zh ? "策略回测" : "Strategy backtest")}</div>
          <h3 className={styles.title}>{result.title}</h3></div>
        <div className={styles.headerActions}><span className={`${styles.state} ${!complete || result.verdict === "WARN" ? "text-warn" : result.verdict === "FAIL" ? "text-danger" : "text-[color:var(--text-muted)]"}`}>
          {complete ? verdict || (zh ? "已完成" : "Completed") : result.status === "blocked" ? (zh ? "回测受阻" : "Blocked") : (zh ? "执行失败" : "Failed")}
        </span>{complete && <button type="button" className={styles.expand} onClick={openReport} aria-label={zh ? "在对话中展开回测详情" : "Open backtest details in conversation"} title={zh ? "在右侧标签页查看" : "Open in a detail tab"} aria-expanded={expanded} aria-controls={details ? `task-dock-panel-${reportId}` : id} data-testid="expand-backtest-details"><Icon name="arrowUpRight" size={18}/></button>}</div>
      </header>
      {complete && <p className={styles.period}>{result.start && result.end ? `${date(result.start)} – ${date(result.end)} UTC` : (zh ? "未记录回放日期" : "Replay dates not recorded")}</p>}
      {complete && <BacktestCoverage compact meta={{ ...result.metrics, ...result.coverage, start: result.start, end: result.end, provenance: result.provenance }}/>}
      {complete && <dl className={styles.metrics}>{metrics.map(([key,label]) => <div key={key}><dt>{label}</dt><dd data-metric={key}>{format(key,values[key])}</dd></div>)}</dl>}
      {complete && !observation && <BacktestExecutionEvidence replay={result.replay}/>}
      {complete && !observation && line && <figure className={styles.trend}>
        <svg viewBox="0 0 560 64" preserveAspectRatio="none" role="img" aria-label={zh ? "已记录的回测净值曲线" : "Recorded backtest equity"}><path d={line} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke"/></svg>
        <figcaption><span>{zh ? "净值 · 含手续费" : "Equity · includes fees"}</span><span>{financeNumber(points.at(-1)!.value,locale,2)} USD</span></figcaption>
      </figure>}
      {complete && <BacktestBiasChecks compact meta={{ bias_checks: result.biasChecks, research_checks: result.researchChecks, provenance: result.provenance }}/>}
      {complete ? <>
        {result.flags.filter(flag => evaluationNotes[flag]).map(flag => <p key={flag} className={styles.note} data-testid="backtest-evaluation-note">{evaluationNotes[flag][zh ? 0 : 1]}</p>)}
        <div className={styles.evidence}><span>{dataLabel}</span><span>{result.engine === "freeform" ? (zh ? "自定义研究回放" : "Custom research replay") : (zh ? "原生策略引擎" : "Native strategy engine")}</span>
          {agentNotRun && <strong className="text-warn">{zh ? "未执行 Agent 模型" : "Agent model not executed"}</strong>}</div>
        {result.message && <p className={styles.note}>{zh && /^Loaded [\d.]+d of real candle coverage/.test(result.message) ? `实际载入 ${result.message.match(/^Loaded ([\d.]+)d/)?.[1]} 天历史行情；请结合本次覆盖范围解读结果。` : result.message}</p>}
        <p className={styles.note}>{observation ? (zh ? "验证事件、脚本分支和输入传递；这些统计不是 Agent 交易收益。实际模型执行需查看单独运行记录。" : "Verifies events, branches and inputs, not Agent trading returns. Actual model execution has a separate run record.")
          : result.dataKind !== "historical" ? (zh ? "此结果尚不能作为已核实的真实历史收益证据。" : "This result is not verified real-history performance evidence.")
          : (zh ? "仅为历史模拟，不会自动上线或执行实盘交易。" : "Historical simulation only; does not activate the strategy or place live orders.")}</p>
      </> : <p className={styles.diagnostic} role="status">{result.message.split("\n")[0].slice(0,360) || (zh ? "回测未能完成。" : "Replay could not complete.")}</p>}
      <div className={styles.footer}>
        {complete && <BacktestReviewAction className={styles.secondary} target={{strategyId:result.strategyId,ts:result.ts,proposalId:result.proposalId,sourceRevision:typeof result.provenance.source_revision === "string" ? result.provenance.source_revision : undefined}}/>}
        {complete && !observation && <Link href={factorSourceUrl({strategy_id:result.strategyId,ts:result.ts,proposal_id:result.proposalId})} className={styles.secondary} data-testid="backtest-factor-library">{zh ? "提取与复用因子" : "Extract & reuse factors"}<Icon name="arrowUpRight" size={14}/></Link>}
        {complete && <button type="button" className={styles.action} aria-expanded={expanded} aria-controls={details ? `task-dock-panel-${reportId}` : id} onClick={openReport} data-testid="open-backtest-report">
          <Icon name="chart" size={14}/>{!details && open ? (zh ? "收起报告" : "Close report") : observation ? (zh ? "查看事件与诊断" : "View events and diagnostics") : (zh ? "查看行情与交易明细" : "View equity curve and trades")}<Icon name="chevronRight" size={14}/></button>}
        {target && (details ? <button type="button" onClick={openStrategy} className={styles.secondary}>{zh ? "对应策略" : "View this strategy"}<Icon name="chevronRight" size={14}/></button> : <Link href={target} className={styles.secondary}>{zh ? "查看对应策略" : "View this strategy"}<Icon name="arrowUpRight" size={14}/></Link>)}
      </div>
      <details className={styles.details}><summary>{zh ? "版本与验证详情" : "Version and verification details"}</summary><pre>{[
        result.proposalId, result.strategyId, result.ts, typeof result.provenance.source_revision === "string" && !result.provenance.source_revision.includes("REDACTED") ? result.provenance.source_revision : "",
        ...result.flags, ...(!complete ? [result.message,result.nextAction] : []),
      ].filter(Boolean).join("\n")}</pre></details>
    </div>
    {complete && open && !details && <div id={id} className={styles.report}><BacktestChart strategyId={result.strategyId} ts={result.ts} proposalId={result.proposalId}/></div>}
  </section>;
}
