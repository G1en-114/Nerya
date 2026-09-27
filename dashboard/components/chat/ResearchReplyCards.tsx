"use client";
import { Icon as NeryaGlyph } from "../icons";

import { useContext, useId, useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AssistantMessage } from "../../lib/chat";
import type { ChartBlockShape } from "../../lib/chartBlock";
import { collectResearchVisuals, type ResearchInstrument } from "../../lib/researchVisuals";
import { chartSummary } from "../../lib/financialChart";
import { financeNumber } from "../../lib/financeDisplay";
import { useChartData } from "../../lib/useChartData";
import { ResearchInstrumentContext, ResearchVisualContext } from "./ResearchVisualContext";
import styles from "./ResearchReplyCards.module.css";

/** Cards belong to this reply, never to the current composer or a later turn. */
export function ResearchReplyCards({ message }: { message: AssistantMessage }) {
  const research = useMemo(() => collectResearchVisuals({ messages: [message] }), [message]);
  const openInstrument = useContext(ResearchInstrumentContext);
  const openChart = useContext(ResearchVisualContext);
  const t = useTranslations("researchWorkspace");
  if (!research.instruments.length && !research.studies.length) return null;
  return <div className={styles.results} data-testid="research-reply-cards" data-research-turn={message.id}>
    {research.instruments.map(instrument => {
      const block = [...research.charts].reverse().find(chart => instrument.chartIds.includes(chart.chart_id));
      const onOpen = openInstrument ? () => openInstrument(instrument, research.charts) : undefined;
      return block ? <ResearchAssetCard key={instrument.id + block.chart_id} instrument={instrument} block={block} onOpen={onOpen} />
        : <InstrumentCard key={instrument.id} instrument={instrument} onOpen={onOpen} />;
    })}
    {research.studies.length > 0 && <div className={styles.studies}>{research.studies.map(block => <button type="button" key={block.chart_id} disabled={!openChart}
      onClick={() => openChart?.(block)}><NeryaGlyph name="chart" size={18} /> {block.title} <span>{t("openChart")}</span></button>)}</div>}
  </div>;
}
export function ResearchAssetCard({ instrument, block, onOpen }: { instrument: ResearchInstrument; block: ChartBlockShape; onOpen?: () => void }) {
  const resolved = useChartData(block);
  return <InstrumentCard instrument={instrument} block={resolved.ready ? resolved.block : undefined} loading={resolved.loading} onOpen={onOpen} />;
}
function InstrumentCard({ instrument, block, loading, onOpen }: { instrument: ResearchInstrument; block?: ChartBlockShape; loading?: boolean; onOpen?: () => void }) {
  const locale = useLocale(), t = useTranslations("researchWorkspace");
  const gradient = useId().replace(/:/g, "");
  const summary = useMemo(() => block ? chartSummary(block) : null, [block]);
  const symbol = instrument.market.toLowerCase().startsWith(instrument.venue + ":") ? instrument.market.slice(instrument.venue.length + 1) : instrument.market;
  const base = symbol.split(/[/:]/)[0].replace(/(USDT|USDC|BUSD|USD|PERP)$/i, "");
  const quote = symbol.includes("/") ? symbol.split("/")[1].split(":")[0] : symbol.match(/(USDT|USDC|BUSD|USD)$/i)?.[1] || "";
  const points = (summary?.data || []).map(point => ({ time: Number(point.time), value: "close" in point ? point.close : point.value }));
  const values = points.map(point => point.value), min = Math.min(...values), max = Math.max(...values);
  const from = points[0]?.time ?? 0, to = points.at(-1)?.time ?? 0;
  const path = points.length > 1 ? points.map((point, i) => `${i ? "L" : "M"}${(4 + (point.time - from) / (to - from || 1) * 312).toFixed(2)},${(max === min ? 36 : 64 - (point.value - min) / (max - min) * 56).toFixed(2)}`).join(" ") : "";
  const change = summary?.percent ?? null;
  const tone = change === null || change === 0 ? "flat" : change > 0 ? "up" : "down";
  const timestamp = block?.source?.as_of;
  const asOf = timestamp && Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  const range = from && to ? `${new Date(from * 1000).toLocaleString(locale)} – ${new Date(to * 1000).toLocaleString(locale)}` : "";
  return <button type="button" className={styles.card} data-testid="research-instrument-card" data-instrument={instrument.id} data-tone={tone}
    onClick={onOpen} disabled={!onOpen} aria-label={`${instrument.name} · ${t("openInstrument")}`} title={`${instrument.market}\n${t("snapshot")} ${asOf}\n${range}`}>
    <span className={styles.avatar} aria-hidden>{base === "BTC" ? "₿" : base.slice(0, 2)}</span>
    <span className={styles.identity}>
      <strong className={styles.name}>{instrument.name === instrument.market ? base : instrument.name}</strong>
      <span className={styles.quote}><span className={styles.symbol}>{base}</span><strong data-testid="research-card-price">{summary?.end != null ? `${quote === "USD" ? "$" : ""}${financeNumber(summary.end, locale, Math.abs(summary.end) >= 1 ? 2 : undefined)}` : "—"}</strong>
        {quote && quote !== "USD" && <small>{quote}</small>}
        {change !== null && <span className={styles.change}>{change > 0 ? "+" : ""}{financeNumber(change, locale, 2)}% <small>{t("rangeChange")}</small></span>}
      </span>
      <span className={styles.metadata}>{loading ? t("loadingMarket") : summary?.end == null ? t("noPrice") : `${instrument.venue} · ${t("snapshot")} ${asOf}`}</span>
    </span>
    <span className={styles.sparkline}>
      {path ? <svg viewBox="0 0 320 72" preserveAspectRatio="none" role="img" aria-label={t("observedTrend")}>
        <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="currentColor" stopOpacity=".18" /><stop offset="100%" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
        <path d={`${path} L316,72 L4,72 Z`} fill={`url(#${gradient})`} /><path d={path} fill="none" stroke="currentColor" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
      </svg> : <span>{loading ? "…" : t("noTrend")}</span>}
    </span><span className={styles.arrow} aria-hidden><NeryaGlyph name="arrowUpRight" size={16} /></span>
  </button>;
}
