"use client";

import { useLocale } from "next-intl";
import { backtestCoverage } from "../../lib/backtestCoverage";

export function BacktestCoverage({ meta, compact = false }: { meta: Record<string, unknown>; compact?: boolean }) {
  const locale = useLocale(), zh = locale.startsWith("zh");
  const coverage = backtestCoverage(meta);
  const number = (value: number | null) => value === null ? "—" : value.toLocaleString(locale, { maximumFractionDigits: 2 });
  if (coverage.requestedDays === null && coverage.recordedDays === null) return null;
  return <section className={`rounded-lg border border-[color:var(--line)] px-3 py-2 text-xs ${coverage.state === "partial" ? "text-warn" : "text-[color:var(--text-muted)]"}`}
    data-testid="backtest-coverage" data-coverage-status={coverage.state} data-recorded-start={coverage.start ?? undefined} data-recorded-end={coverage.end ?? undefined}>
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 tabular-nums">
      <span>{zh ? "请求" : "Requested"} <strong>{number(coverage.requestedDays)}</strong> {zh ? "天" : "days"}</span>
      <span>{zh ? "实际记录" : "Recorded span"} <strong>{number(coverage.recordedDays)}</strong> {zh ? "天" : "days"}</span>
      <span>{coverage.state === "partial" ? (zh ? "覆盖不足" : "Incomplete coverage") : coverage.state === "complete" ? (zh ? "区间已核对" : "Window verified") : (zh ? "完整性未记录" : "Completeness not recorded")}</span>
    </div>
    {coverage.state === "partial" && <p className="mt-1 leading-5">{zh ? "这不是完整请求区间的回测。下载新数据不会改写旧报告，需要重新回测生成新批次。" : "This is not the full requested window. New downloads do not rewrite this report; rerun the strategy to create a new result."}</p>}
    {!compact && coverage.start !== null && coverage.end !== null && <p className="mt-1 leading-5">{new Date(coverage.start).toISOString().slice(0, 10)} — {new Date(coverage.end).toISOString().slice(0, 10)} UTC · {zh ? "本批次记录，结束时间不含" : "Recorded run, exclusive end"}</p>}
  </section>;
}
