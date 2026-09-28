"use client";

import { useLocale } from "next-intl";
import type { FactorRun, FactorStats } from "../../lib/factorLibrary";
import { ErrorBanner } from "../Page";
import styles from "./Factors.module.css";

export function FactorEvidence({ run }: { run: FactorRun }) {
  const locale = useLocale(), zh = locale.startsWith("zh"), analysis = run.analysis;
  const fmt = (n: unknown, decimals = 3) => typeof n === "number" && Number.isFinite(n) ? n.toLocaleString(locale, { maximumFractionDigits: decimals }) : "—";
  const metrics: [keyof FactorStats, string][] = [["samples", zh ? "可用样本" : "Usable samples"], ["ic", "IC"], ["rank_ic", "Rank IC"],
    ["quantile_spread_bps", zh ? "高低组差 · bps" : "Bucket spread · bps"], ["favored_bucket_mean_bps", zh ? "方向组均值 · bps" : "Favored bucket · bps"],
    ["fee_slippage_adjusted_mean_bps", zh ? "扣手续费/滑点 · bps" : "After fee/slippage · bps"], ["double_cost_mean_bps", zh ? "双倍成本 · bps" : "Double costs · bps"]];
  return <div className={styles.evidence} data-testid="factor-evidence">
    <div className={styles.runHeading}><div><strong>{run.profile.market} <span className={styles.muted}>{run.profile.timeframe}</span></strong><p className={styles.muted}>{run.request.start} — {run.request.end} UTC</p></div><span className={styles.badge}>{run.status === "completed" ? (zh ? "已计算 · 研究诊断" : "Calculated · research") : run.status}</span></div>
    {run.error && <ErrorBanner error={run.error}/>}
    {analysis && <>
      <p className={styles.notice}>{zh ? "单品种时序因子诊断，不是策略组合回测。分组收益可能重叠，不可累计成收益率；完成计算不等于验证有效。" : "Single-instrument time-series diagnostics, not portfolio performance. Overlapping bucket returns cannot be compounded. Calculated does not mean validated."}</p>
      <div className={styles.tableScroll}><table className={styles.table}><thead><tr><th>{zh ? "指标" : "Metric"}</th><th>{zh ? "样本内" : "Train"}</th><th>{zh ? "样本外" : "Test"}</th></tr></thead><tbody>{metrics.map(([key,label]) => <tr key={key}><th>{label}</th><td>{fmt(analysis.in_sample[key])}</td><td>{fmt(analysis.out_of_sample[key])}</td></tr>)}</tbody></table></div>
      <section><h3 className={styles.subheading}>{zh ? "样本外分组 · 训练集固定阈值" : "Test quantiles · fixed training thresholds"}</h3>
        <div className={styles.quantiles}>{analysis.out_of_sample.quantiles.map(q => {
          const max = Math.max(1, ...analysis.out_of_sample.quantiles.map(v => Math.abs(v.mean_forward_bps || 0)));
          const value = q.mean_forward_bps;
          return <div key={q.bucket} className={styles.quantile}><span>Q{q.bucket}</span><div className={styles.barTrack}><span className={styles.barZero}/>{value != null && <span className={styles.bar} data-negative={value < 0} style={{ left: `${value < 0 ? 50 - Math.abs(value) / max * 50 : 50}%`, width: `${Math.abs(value) / max * 50}%` }}/>}</div><strong>{fmt(value, 2)} bps</strong><small>n={q.count}</small></div>;
        })}</div>
      </section>
      <section><h3 className={styles.subheading}>{zh ? "时间分段稳定性（非 Walk-forward）" : "Chronological stability (not walk-forward)"}</h3><div className={styles.blocks}>{analysis.test_blocks.map((block, i) => <div key={i}><span>{new Date(block.start * 1000).toISOString().slice(0,10)}</span><strong>{fmt(block.rank_ic)}</strong><small>Rank IC · n={block.samples}</small></div>)}</div></section>
      {!!analysis.comparisons.length && <section><h3 className={styles.subheading}>{zh ? "同窗口因子相关性" : "Same-window factor correlation"}</h3>{analysis.comparisons.map(c => <p key={`${c.factor_id}:${c.version}`} className={styles.compareRow}><span>{c.factor_id} · v{c.version}</span><strong>{fmt(c.rank_correlation)}</strong></p>)}</section>}
      <p className={styles.muted}>{zh ? "样本外开始" : "Test begins"}: {new Date(analysis.split.test_start * 1000).toISOString()} · {zh ? "隔离" : "Purged"}: {analysis.split.purge_bars} bars · {zh ? "预测跨度" : "Forward horizon"}: {run.request.horizon} bars</p>
      <div className={styles.notice}><strong>{zh ? "尚未完成的检查" : "Checks still pending"}</strong><p>{zh ? "滚动样本外、参数敏感性、策略消融、容量、跨市场验证。当前样本外区间已被查看，调参后不能继续称为锁定测试集。" : "Walk-forward, parameter sensitivity, strategy ablation, capacity and cross-market validation. This test period is now inspected and cannot remain a locked holdout after tuning."}</p>
        {run.profile.instrument_type === "perpetual" && <p className="text-warn">{zh ? "未计入资金费、强平和标记价格影响，扣成本均值不是永续净收益。" : "Funding, liquidation and mark-price effects are excluded. Adjusted means are not net perpetual returns."}</p>}
      </div>
      <details className={styles.details}><summary>{zh ? "原始诊断与复现信息" : "Diagnostics & reproducibility"}</summary><pre>{JSON.stringify({ warnings: analysis.warnings, run_id: run.run_id, engine: run.engine, data: run.data, manifest: run.manifest_path, profile: run.profile }, null, 2)}</pre></details>
    </>}
    {!analysis && <p className={styles.muted}>{zh ? "该实验未完成，记录已保留。修复原因后再验证，不会展示伪造指标。" : "This experiment did not complete. The record is retained; repair the cause before retrying."}</p>}
  </div>;
}
