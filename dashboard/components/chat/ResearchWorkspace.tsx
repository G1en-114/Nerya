"use client";
import { Icon as NeryaGlyph } from "../icons";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { callApi } from "../../lib/clientApi";
import type { Candle } from "../../lib/api";
import type { ChartBlockShape } from "../../lib/chartBlock";
import { instrumentId, matchingResearchNews, researchNews, type ResearchInstrument, type ResearchNews, type ResearchVisuals } from "../../lib/researchVisuals";
import { AgentVisualChart } from "./AgentChartPanel";
import { ChartIcon, RefreshIcon } from "../icons";
import styles from "./ResearchWorkspace.module.css";

export function ResearchInstrumentBar({ research, selected, chartsOpen, onInstrument, onCharts }: {
  research: ResearchVisuals; selected: string; chartsOpen: boolean;
  onInstrument: (id: string) => void; onCharts: () => void;
}) {
  const t = useTranslations("researchWorkspace");
  if (!research.instruments.length && !research.studies.length) return null;
  return <footer className={styles.bar} data-testid="research-instrument-bar" aria-label={t("instruments")}>
    <span className={styles.barLabel}>{t("instruments")} <span>{research.instruments.length}</span></span>
    <div className={styles.instruments}>
      {research.instruments.map(item => <button type="button" key={item.id} data-testid="research-instrument" className={styles.instrument}
        aria-pressed={selected === item.id} aria-controls={`task-dock-panel-instrument:${item.id}`} onClick={() => onInstrument(item.id)} title={item.name}>
        <span className={styles.dot} aria-hidden /><strong>{item.market.includes(":") ? item.market.slice(item.market.indexOf(":") + 1) : item.market}</strong>
        <span>{item.venue || item.name}</span><NeryaGlyph name="arrowUpRight" size={16} />
      </button>)}
    </div>
    {!!research.studies.length && <button type="button" className={styles.studiesButton} aria-pressed={chartsOpen} onClick={onCharts} aria-controls="research-charts-panel"><ChartIcon size={15} />{t("charts")} <span>{research.studies.length}</span></button>}
  </footer>;
}

export function ResearchChartTabs({ open, count, onConversation, onCharts }: {
  open: boolean; count: number; onConversation: () => void; onCharts: () => void;
}) {
  const t = useTranslations("researchWorkspace");
  return <div className={styles.tabs} role="group" aria-label={t("workspace")}>
    <button type="button" aria-pressed={!open} onClick={onConversation}>{t("conversation")}</button>
    <button type="button" aria-pressed={open} onClick={onCharts}><ChartIcon size={14} />{t("charts")} <span>{count}</span></button>
  </div>;
}

export function ResearchCharts({ charts, selected, onSelect }: { charts: ChartBlockShape[]; selected: string; onSelect: (id: string) => void }) {
  const t = useTranslations("researchWorkspace");
  const active = charts.find(chart => chart.chart_id === selected) || charts[charts.length - 1];
  return <section className={styles.studies} id="research-charts-panel" data-testid="research-charts-panel" aria-label={t("charts")}>
    <div className={styles.heading}><div><p>{t("analysis")}</p><h2>{t("charts")}</h2></div><span>{t("chartCount", { count: charts.length })}</span></div>
    <p className={styles.description}>{t("chartDescription")}</p>
    {charts.length > 1 && <div className={styles.chartPicker} role="group" aria-label={t("selectChart")}>{charts.map(chart => <button type="button" key={chart.chart_id} aria-pressed={chart.chart_id === active?.chart_id} onClick={() => onSelect(chart.chart_id)}>{chart.title}</button>)}</div>}
    {active && <AgentVisualChart key={active.chart_id} visual={{ id: active.chart_id, block: active, seenAt: 0, source: active.source?.skill || "research" }} />}
  </section>;
}

type NewsFeed = { ok: boolean; items?: unknown[]; fetched_at?: number; error?: string };
type CandleResponse = { candles?: Candle[]; market?: string; interval?: string; error?: string };
export function ResearchInstrumentPanel({ instrument, charts }: { instrument: ResearchInstrument; charts: ChartBlockShape[] }) {
  const t = useTranslations("researchWorkspace"), locale = useLocale();
  const sourceChart = [...charts].reverse().find(chart => instrument.chartIds.includes(chart.chart_id));
  const [fetched, setFetched] = useState<ChartBlockShape | null>(null);
  const [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(false), [error, setError] = useState(false);
  const [feed, setFeed] = useState<{ rows: ResearchNews[]; asOf: string; error: boolean } | null>(null);
  const [newsLoading, setNewsLoading] = useState(false), [newsRefresh, setNewsRefresh] = useState(0);
  const chart = fetched || sourceChart;
  const market = instrument.market.toLowerCase().startsWith(`${instrument.venue}:`) ? instrument.market.slice(instrument.venue.length + 1) : instrument.market;
  useEffect(() => {
    if (sourceChart && refresh === 0 || !instrument.venue) return;
    let disposed = false;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15_000);
    setLoading(true); setError(false);
    void callApi<CandleResponse>("/market/candles", { method: "POST", body: { market, venue: instrument.venue, interval: instrument.interval, count: 180 }, signal: controller.signal }).then(result => {
      if (result.error || result.market && instrumentId(result.market, instrument.venue) !== instrument.id || result.interval && result.interval !== instrument.interval) throw new Error("market data unavailable");
      const rows = (result.candles || []).filter(row => [row.ts, row.open, row.high, row.low, row.close].every(Number.isFinite) && row.high >= Math.max(row.open, row.close) && row.low <= Math.min(row.open, row.close));
      if (!rows.length) throw new Error("empty market data");
      if (!disposed) setFetched({ kind: "chart", chart_id: `instrument-${instrument.id}-${refresh}`, chart_kind: "candlestick", path: "inline", title: `${instrument.market} · ${instrument.interval}`,
        market, venue: instrument.venue, interval: instrument.interval, subtitle: `venue: ${instrument.venue}`,
        source: { skill: "markets", action: "candles", as_of: new Date(rows[rows.length - 1].ts > 1e12 ? rows[rows.length - 1].ts : rows[rows.length - 1].ts * 1000).toISOString() },
        series: [{ name: "OHLC", type: "candlestick", data: rows.map(row => ({ time: row.ts > 1e12 ? Math.floor(row.ts / 1000) : row.ts, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume })) }],
      });
    }).catch(() => { if (!disposed) setError(true); }).finally(() => { clearTimeout(timeout); if (!disposed) setLoading(false); });
    return () => { disposed = true; controller.abort(); clearTimeout(timeout); };
  }, [instrument.id, instrument.interval, instrument.market, instrument.venue, market, sourceChart?.chart_id, refresh]);
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15_000);
    setNewsLoading(true);
    void callApi<NewsFeed>("/market/news", { signal: controller.signal }).then(result => {
      if (!result.ok) throw new Error("news unavailable");
      if (!disposed) setFeed({ rows: matchingResearchNews(result.items, instrument), asOf: result.fetched_at ? new Date(result.fetched_at * 1000).toISOString() : "", error: false });
    }).catch(() => { if (!disposed) setFeed(old => ({ rows: old?.rows || [], asOf: old?.asOf || "", error: true })); })
      .finally(() => { clearTimeout(timeout); if (!disposed) setNewsLoading(false); });
    return () => { disposed = true; controller.abort(); clearTimeout(timeout); };
    // Only an identity change or explicit refresh fetches a feed, not each streaming token.
  }, [instrument.id, instrument.market, instrument.name, newsRefresh]);
  const news = researchNews([...(instrument.news || []), ...(feed?.rows || [])]);
  const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : t("undated");
  return <div className={styles.detail} data-testid="research-instrument-panel">
    <div className={styles.heading}><div><p>{t("marketSnapshot")}</p><h2>{instrument.name}</h2><span>{instrument.market} · {instrument.venue}</span></div>
      <button type="button" className={styles.iconButton} disabled={loading || !instrument.venue} onClick={() => setRefresh(value => value + 1)} aria-label={t("refreshMarket")} title={t("refreshMarket")}><RefreshIcon size={15} /></button></div>
    {error && <p className={styles.notice} role="status">{chart ? t("staleMarket") : t("marketUnavailable")}</p>}
    {chart ? <AgentVisualChart key={chart.chart_id} visual={{ id: chart.chart_id, block: chart, seenAt: instrument.seenAt, source: instrument.venue }} />
      : <div className={styles.empty} role="status">{loading ? t("loadingMarket") : instrument.venue ? t("marketUnavailable") : t("missingVenue")}</div>}
    <section className={styles.news} aria-label={t("news")} data-testid="research-news">
      <div className={styles.newsHeading}><h3>{t("news")}</h3><button type="button" disabled={newsLoading} className={styles.iconButton} onClick={() => setNewsRefresh(value => value + 1)} aria-label={t("refreshNews")}><RefreshIcon size={14} /></button></div>
      <p className={styles.description}>{t("newsScope")}{(feed?.asOf || instrument.newsAsOf) && ` · ${date(feed?.asOf || instrument.newsAsOf)}`}</p>
      {feed?.error && <p className={styles.notice} role="status">{t("newsUnavailable")}</p>}
      {!news.length && <p className={styles.empty} role="status">{newsLoading ? t("loadingNews") : t("noMatchingNews")}</p>}
      {news.map(item => <article key={item.url} className={styles.newsItem}><div><span>{item.source}</span><time dateTime={item.published_at || undefined}>{date(item.published_at)}</time></div>
        <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}<NeryaGlyph name="arrowUpRight" size={14} /></a>{item.summary && <p>{item.summary}</p>}
      </article>)}
    </section>
  </div>;
}
