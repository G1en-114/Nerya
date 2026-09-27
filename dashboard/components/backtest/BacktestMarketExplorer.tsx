"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { createChart, type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp } from "lightweight-charts";
import type { BacktestChartData, BacktestPanel } from "../../lib/clientApi";
import { replayCandles, replayMarkers, replayNumber, replayTrades, type ReplayCandle, type ReplayMarker } from "../../lib/backtestMarket";
import { financeNumber } from "../../lib/financeDisplay";
import { useChartTheme } from "../../lib/chartTheme";
import { ChoiceSelect } from "../ChoiceSelect";
import { Icon } from "../icons";
import styles from "./BacktestMarketExplorer.module.css";

export function BacktestMarketExplorer({ panels, tables, meta }: {
  panels: BacktestPanel[]; tables: BacktestChartData["tables"]; meta: BacktestChartData["meta"];
}) {
  const locale = useLocale(), zh = locale.startsWith("zh"), id = useId();
  const availablePanels = useMemo<BacktestPanel[]>(() => {
    const recorded = replayTrades(tables, []).map(trade => trade.market);
    const declared = Array.isArray(meta.markets) ? meta.markets.filter((market): market is string => typeof market === "string") : [];
    const known = new Set(panels.map(panel => panel.market));
    const missing = [...new Set([...declared, ...recorded])].filter(market => !known.has(market));
    return [...panels, ...missing.map(market => ({ id: `missing:${market}`, market, title: market || (zh ? "未标注品种" : "Unattributed market"), type: "candlestick", series: [] } satisfies BacktestPanel))];
  }, [panels, tables, meta, zh]);
  const [picked, setPicked] = useState("");
  const panel = availablePanels.find(item => item.id === picked) || availablePanels[0];
  const candles = useMemo(() => panel ? replayCandles(panel) : [], [panel]);
  const markers = useMemo(() => panel ? replayMarkers(panel) : [], [panel]);
  const allTrades = useMemo(() => replayTrades(tables, availablePanels), [tables, availablePanels]);
  const trades = allTrades.filter(trade => panel?.market ? trade.market === panel.market : !panel || availablePanels.length === 1 || !trade.market);
  const [showTrades, setShowTrades] = useState(true), [showGBS, setShowGBS] = useState(true);
  const [selected, setSelected] = useState(""), [page, setPage] = useState(0), [fit, setFit] = useState(0);
  const [side, setSide] = useState("all");
  const rows = trades.filter(trade => side === "all" || trade.side === side);
  const pageSize = 25, currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / pageSize) - 1));
  const visibleMarkers = useMemo(() => markers.filter(marker => marker.kind === "gbs" ? showGBS : showTrades), [markers, showGBS, showTrades]);
  const selectedTrade = trades.find(trade => trade.id === selected);
  const selectedMarker = markers.find(marker => marker.id === selected);
  const gbsCount = markers.filter(marker => marker.kind === "gbs").length;
  const format = (value: unknown) => { const number = replayNumber(value); return number === null ? "—" : financeNumber(number, locale); };
  const when = (time: number | null | undefined) => time ? new Date(time * 1000).toISOString().replace("T", " ").slice(0, 19) : "—";
  useEffect(() => { setSelected(""); setPage(0); setSide("all"); }, [panel?.id]);
  function selectMarker(markerId: string) {
    setSelected(markerId); setSide("all");
    const index = trades.findIndex(trade => trade.id === markerId);
    if (index >= 0) {
      setPage(Math.floor(index / pageSize));
      requestAnimationFrame(() => document.getElementById(`${id}-${markerId}`)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
    }
  }
  function downloadTrades() {
    const columns = [...new Set(trades.flatMap(trade => Object.keys(trade.row)))];
    // CSV formula protection; displayed values and raw source remain unchanged.
    const cell = (value: unknown) => { let text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value); if (/^[=+@\t\r]/.test(text) || /^-[^\d.]/.test(text)) text = "'" + text; return '"' + text.replaceAll('"', '""') + '"'; };
    const csv = [columns.map(cell).join(","), ...trades.map(trade => columns.map(column => cell(trade.row[column])).join(","))].join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url;
    anchor.download = `backtest-${(panel?.market || "trades").replace(/[^a-z0-9_-]/gi, "-")}-displayed.csv`;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className={styles.explorer} data-testid="backtest-market-explorer" data-market={panel?.market || ""}>
    <div className={styles.toolbar}>
      <div className={styles.market}><label htmlFor={`${id}-market`}>{zh ? "交易品种" : "Instrument"}</label>
        <ChoiceSelect id={`${id}-market`} aria-label={zh ? "回测交易品种" : "Backtest instrument"} value={panel?.id || ""} onValueChange={setPicked}>
          {availablePanels.map(item => <option key={item.id} value={item.id}>{item.market || item.title || (zh ? "未标注品种" : "Unattributed market")}</option>)}
        </ChoiceSelect><span className={styles.interval}>{panel?.interval || String(meta.tf || "")} · UTC</span>
      </div>
      <div className={styles.legend} aria-label={zh ? "图上标记" : "Chart markers"}>
        <button type="button" className={styles.toggle} aria-pressed={showTrades} onClick={() => setShowTrades(value => !value)}><span className={styles.buy}>B</span><span className={styles.sell}>S</span>{zh ? "买卖点" : "Executions"}</button>
        <button type="button" className={styles.toggle} aria-pressed={showGBS} onClick={() => setShowGBS(value => !value)}><span className={styles.gbs}>●</span>GBS <span>{gbsCount}</span></button>
        <button type="button" className={styles.button} onClick={() => { setSelected(""); setFit(value => value + 1); }} title={zh ? "显示完整回测区间" : "Fit the replay range"}><Icon name="chart" size={14}/>{zh ? "全区间" : "Fit range"}</button>
      </div>
    </div>
    {candles.length > 0 && <p className={styles.notice} data-testid="backtest-loaded-range">
      {zh ? "已载入" : "Loaded"} {candles.length.toLocaleString(locale)} {zh ? "根 K 线" : "candles"} · {when(candles[0].time)} – {when(candles.at(-1)?.time)} UTC
      {selectedMarker ? (zh ? " · 当前聚焦单笔交易，可点“全区间”返回" : " · Focused on one execution; Fit range restores the whole replay") : ""}
    </p>}
    {candles.length > 0 ? <MarketPlot key={panel?.id} candles={candles} markers={visibleMarkers} selected={selectedMarker} onSelect={selectMarker} fit={fit} locale={locale}/>
      : <div className={styles.empty} role="status">{zh ? "本次回测没有可显示的历史 K 线。不会用当前行情替代。" : "This run has no recorded historical candles. Current prices will not be substituted."}</div>}
    <p className={styles.notice}>{zh ? "K 线与点位均来自本次回测。B 为买入成交，S 为卖出成交；点击交易可定位到对应 K 线与成交价。" : "Candles and markers come from this run. B is a buy fill; S is a sell fill. Select a trade to locate its candle and execution price."}</p>
    {!gbsCount && <p className={styles.notice} data-testid="backtest-gbs-empty">{zh ? "本次记录没有可展示的 GBS 信号；不会从普通买卖点推断或补画。" : "No recorded GBS signals can be plotted for this instrument. GBS is not inferred from ordinary executions."}</p>}
    {gbsCount > 0 && <p className={styles.notice}>{zh ? "GBS 圆点表示策略明确记录的历史信号，不等同于已成交订单。" : "GBS circles are explicitly recorded strategy signals, not necessarily filled orders."}</p>}
    <div className={styles.heading}><div><h3>{zh ? "成交明细" : "Executions"}<span>{trades.length}</span></h3></div>
      <div className={styles.legend}><ChoiceSelect aria-label={zh ? "成交方向" : "Execution side"} value={side} onValueChange={value => { setSide(value); setPage(0); }}>
        <option value="all">{zh ? "全部方向" : "All sides"}</option><option value="buy">{zh ? "买入" : "Buy"}</option><option value="sell">{zh ? "卖出" : "Sell"}</option>
      </ChoiceSelect><button type="button" className={styles.button} disabled={!trades.length} onClick={downloadTrades}>{zh ? "导出已载入记录" : "Export loaded rows"}</button></div>
    </div>
    {!rows.length ? <div className={styles.empty} role="status">{zh ? "当前品种与筛选条件下没有成交记录。" : "No executions match this instrument and filter."}</div>
      : <div className={styles.tableScroll}><table className={styles.table} aria-label={zh ? "回测成交明细" : "Backtest executions"}>
        <thead><tr>{(zh ? ["成交时间（UTC）", "方向", "成交价格", "数量", "手续费"] : ["Execution time (UTC)", "Side", "Price", "Quantity", "Fee"]).map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(trade => <tr key={trade.id} id={`${id}-${trade.id}`} className={styles.row} tabIndex={0} aria-selected={selected === trade.id} data-testid="backtest-trade-row" data-trade-id={trade.id} onClick={() => { setSelected(trade.id); setShowTrades(true); }} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(trade.id); setShowTrades(true); } }}>
          <td><time dateTime={trade.time ? new Date(trade.time * 1000).toISOString() : undefined}>{when(trade.time)}</time></td>
          <td className={trade.side === "buy" ? styles.buy : styles.sell}>{trade.side === "buy" ? (zh ? "买入" : "Buy") : trade.side === "sell" ? (zh ? "卖出" : "Sell") : trade.side || "—"}</td>
          <td title={String(trade.row.price ?? "")}>{format(trade.row.price)}</td><td title={String(trade.row.qty ?? trade.row.size ?? "")}>{format(trade.row.qty ?? trade.row.size)}</td><td title={String(trade.row.fee ?? "")}>{format(trade.row.fee)}</td>
        </tr>)}</tbody></table></div>}
    <div className={styles.pagination}><span>{rows.length ? `${currentPage * pageSize + 1}–${Math.min((currentPage + 1) * pageSize, rows.length)} / ${rows.length}` : "0"}
      {replayNumber(meta.trade_count) !== null && Number(meta.trade_count) > allTrades.length ? ` · ${zh ? "报告仅载入部分记录，完整成交见 trades.csv" : "Partial report; trades.csv retains every fill"}` : ""}</span>
      {rows.length > pageSize && <div><button type="button" className={styles.button} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{zh ? "上一页" : "Previous"}</button><button type="button" className={styles.button} disabled={(currentPage + 1) * pageSize >= rows.length} onClick={() => setPage(currentPage + 1)}>{zh ? "下一页" : "Next"}</button></div>}
    </div>
    {(selectedTrade || selectedMarker) && <section className={styles.selection} data-testid="backtest-execution-detail" aria-live="polite">
      <h4>{selectedMarker?.kind === "gbs" ? (zh ? "GBS 信号详情" : "GBS signal details") : (zh ? "成交详情" : "Execution details")}</h4>
      <dl>{[[zh ? "交易品种" : "Instrument", panel?.market || selectedTrade?.market || "—"], [zh ? "时间（UTC）" : "Time (UTC)", when(selectedTrade?.time ?? selectedMarker?.execution_ts ?? selectedMarker?.time)],
        [zh ? "成交 / 信号价格" : "Execution / signal price", format(selectedTrade?.row.price ?? selectedMarker?.price)], [zh ? "原因" : "Reason", String(selectedTrade?.row.reason || selectedMarker?.reason || "—")]].map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {!selectedMarker && <p className={styles.notice}>{zh ? "这条成交未匹配到已记录的 K 线，仍保留原始成交信息。" : "This execution does not match a recorded candle. Its original fill evidence is retained."}</p>}
      <details><summary>{zh ? "查看原始记录" : "View raw record"}</summary><pre>{JSON.stringify(selectedTrade?.row || selectedMarker, null, 2)}</pre></details>
    </section>}
  </div>;
}

function MarketPlot({ candles, markers, selected, onSelect, fit, locale }: {
  candles: ReplayCandle[]; markers: ReplayMarker[]; selected?: ReplayMarker;
  onSelect: (id: string) => void; fit: number; locale: string;
}) {
  const [node, setNode] = useState<HTMLDivElement | null>(null), [hover, setHover] = useState<ReplayCandle | null>(null);
  const theme = useChartTheme();
  const plot = useRef<{ api: IChartApi; series: ISeriesApi<"Candlestick">; line?: IPriceLine } | null>(null);
  const onSelectRef = useRef(onSelect); onSelectRef.current = onSelect;
  useEffect(() => {
    if (!node || !candles.length) return;
    const api = createChart(node, { height: 330, width: Math.max(1, node.clientWidth),
      layout: { background: { color: "transparent" }, textColor: theme.text, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: theme.grid } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: .16, bottom: .16 } },
      timeScale: { borderColor: theme.grid, timeVisible: true, secondsVisible: false },
      handleScroll: { mouseWheel: false, vertTouchDrag: false }, handleScale: { mouseWheel: false } });
    const smallest = candles.reduce((value, candle) => Math.min(value, candle.low), Infinity);
    const precision = Math.min(12, Math.max(2, 3 - Math.floor(Math.log10(smallest))));
    const series = api.addCandlestickSeries({ upColor: "#10d993", downColor: "#ef4560", wickUpColor: "#10d993", wickDownColor: "#ef4560", borderVisible: false,
      priceFormat: { type: "price", precision, minMove: 10 ** -precision }, lastValueVisible: true, priceLineVisible: false });
    series.setData(candles.map(candle => ({ ...candle, time: candle.time as UTCTimestamp })));
    plot.current = { api, series };
    const candleMap = new Map(candles.map(candle => [candle.time, candle]));
    api.subscribeCrosshairMove(event => { const candle = typeof event.time === "number" ? candleMap.get(event.time) : undefined; setHover(old => old?.time === candle?.time ? old : candle || null); });
    api.subscribeClick(event => { if (typeof event.hoveredObjectId === "string") onSelectRef.current(event.hoveredObjectId); });
    const observer = new ResizeObserver(() => api.applyOptions({ width: Math.max(1, node.clientWidth) }));
    observer.observe(node); api.timeScale().fitContent();
    return () => { observer.disconnect(); plot.current = null; api.remove(); };
  }, [node, candles, theme]);
  useEffect(() => {
    plot.current?.series.setMarkers(markers.map(marker => ({ ...marker, time: marker.time as UTCTimestamp, size: selected?.id === marker.id ? 1.5 : 1 })));
  }, [markers, selected?.id, node, candles, theme]);
  useEffect(() => {
    const current = plot.current;
    if (!current) return;
    if (current.line) { current.series.removePriceLine(current.line); current.line = undefined; }
    if (!selected) return;
    const index = candles.findIndex(candle => candle.time === selected.time);
    if (index >= 0) current.api.timeScale().setVisibleLogicalRange({ from: Math.max(-1, index - 18), to: Math.min(candles.length, index + 18) });
    if (selected.price !== null) current.line = current.series.createPriceLine({ price: selected.price, color: selected.color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: selected.text });
  }, [selected, node, candles, theme]);
  useEffect(() => { if (fit) plot.current?.api.timeScale().fitContent(); }, [fit]);
  const current = hover || candles.at(-1);
  return <div className={styles.plot}><div className={styles.readout} aria-hidden="true">{current && <><span>{new Date(current.time * 1000).toISOString().replace("T", " ").slice(0,16)} UTC</span>{(["open","high","low","close"] as const).map((key,index) => <span key={key}>{["O","H","L","C"][index]} <strong>{financeNumber(current[key], locale)}</strong></span>)}</>}</div>
    <div ref={setNode} className={styles.canvas} role="img" aria-label={locale.startsWith("zh") ? "历史 K 线与买卖、GBS 标记；完整信息也可在成交表中查看" : "Historical candles with buy, sell and GBS markers; execution details are also available in the table"} data-testid="backtest-market-chart" data-candle-count={candles.length} data-marker-count={markers.length} data-start={candles[0]?.time} data-end={candles.at(-1)?.time}/>
  </div>;
}
