"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { factorRequest, FactorRequestError, type Factor, type FactorDataset } from "../../lib/factorLibrary";
import { ErrorBanner } from "../Page";
import styles from "./Factors.module.css";

export function FactorValidation({ factor, factors, onComplete }: { factor: Factor; factors: Factor[]; onComplete: () => void }) {
  const zh = useLocale().startsWith("zh");
  const [datasets,setDatasets] = useState<FactorDataset[]>([]), [loading,setLoading] = useState(true);
  const [market,setMarket] = useState(factor.markets[0] || ""), [timeframe,setTimeframe] = useState(factor.timeframes[0] || "1h");
  const [start,setStart] = useState(""), [end,setEnd] = useState(""), [instrument,setInstrument] = useState("");
  const [fee,setFee] = useState("5"), [slippage,setSlippage] = useState("2"), [horizon,setHorizon] = useState("5"), [fraction,setFraction] = useState("0.3");
  const [compare,setCompare] = useState(""), [busy,setBusy] = useState(false), [error,setError] = useState(""), [loaded,setLoaded] = useState(0);
  useEffect(() => {
    const control = new AbortController(); setLoading(true);
    factorRequest<{datasets:FactorDataset[]}>("data",{},control.signal).then(result => { setDatasets(result.datasets); setError(""); }).catch(e => { if (!control.signal.aborted) setError(String(e.message || e)); }).finally(() => { if (!control.signal.aborted) setLoading(false); });
    return () => control.abort();
  },[loaded]);
  return <form className={styles.form} onSubmit={async event => {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    try {
      await factorRequest("evaluate",{factor_id:factor.factor_id,version:factor.version,market,timeframe,start,end,instrument_type:instrument,fee_bps:Number(fee),slippage_bps:Number(slippage),horizon:Number(horizon),test_fraction:Number(fraction),compare:compare ? [JSON.parse(compare)] : []});
      onComplete();
    } catch(e) {
      if (e instanceof FactorRequestError && e.run) onComplete();
      else setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }}>
    <p className={styles.notice}>{zh ? "仅使用已下载、已校验的本地数据；不会联网补数据或下单。当前支持 24/7 加密现货和永续时序研究，不能直接套用股票或外汇交易日历。" : "Uses verified local history only: no downloads or orders. Supports 24/7 crypto spot/perpetual time-series research, not equity or FX trading calendars."}</p>
    <label className={styles.field}>{zh ? "复用本地数据窗口" : "Reuse a local data window"}<select defaultValue="" onChange={event => {
      const dataset = datasets[Number(event.target.value)]; if (!dataset) return;
      setMarket(dataset.market); setTimeframe(dataset.timeframe);
      const match = /^(\d+)([smhdw])$/.exec(dataset.timeframe);
      const step = match ? Number(match[1]) * ({s:1,m:60,h:3600,d:86400,w:604800}[match[2]] || 0) : 0;
      setStart(new Date(dataset.first_ts * 1000).toISOString()); setEnd(new Date((dataset.last_ts + step) * 1000).toISOString());
    }} disabled={loading || busy}><option value="" disabled>{loading ? (zh ? "读取缓存…" : "Reading cache…") : (zh ? "选择已有窗口，或填写下方范围" : "Select a cached window or enter a range")}</option>{datasets.map((d,i) => <option value={i} key={`${d.market}:${d.timeframe}`}>{d.market} · {d.timeframe} · {d.verified_rows} {zh ? "已校验 K 线" : "verified bars"}</option>)}</select></label>
    {!loading && !datasets.length && <p className={styles.muted}>{zh ? "未找到缓存。先通过历史数据 Skill 下载所需品种和时间段；这里不会用样本数据替代。" : "No cached data. Use the historical-data tool to download the requested market and period; sample data will not be substituted."}</p>}
    <div className={styles.fields}>
      <label className={styles.field}>{zh ? "交易所：品种" : "VENUE:SYMBOL"}<input required value={market} onChange={e=>setMarket(e.target.value)} placeholder="BINANCE:ETH/USDT:USDT"/></label>
      <label className={styles.field}>{zh ? "周期" : "Timeframe"}<input required value={timeframe} onChange={e=>setTimeframe(e.target.value)}/></label>
      <label className={styles.field}>{zh ? "开始 UTC（包含）" : "Start UTC (inclusive)"}<input required value={start} onChange={e=>setStart(e.target.value)} placeholder="2025-01-01T00:00:00Z"/></label>
      <label className={styles.field}>{zh ? "结束 UTC（不包含）" : "End UTC (exclusive)"}<input required value={end} onChange={e=>setEnd(e.target.value)} placeholder="2026-01-01T00:00:00Z"/></label>
      <label className={styles.field}>{zh ? "实际市场类型" : "Actual instrument type"}<select required value={instrument} onChange={e=>setInstrument(e.target.value)}><option value="" disabled>{zh ? "请选择，不从名称推断" : "Select explicitly"}</option><option value="spot">{zh ? "加密现货" : "Crypto spot"}</option><option value="perpetual">{zh ? "加密永续" : "Crypto perpetual"}</option></select></label>
      <label className={styles.field}>{zh ? "预测跨度 · K 线数" : "Forward horizon · bars"}<input required type="number" min="1" max="1000" step="1" value={horizon} onChange={e=>setHorizon(e.target.value)}/></label>
      <label className={styles.field}>{zh ? "单边手续费 · bps" : "One-way fee · bps"}<input required type="number" min="0" max="1000" step="0.01" value={fee} onChange={e=>setFee(e.target.value)}/></label>
      <label className={styles.field}>{zh ? "单边滑点 · bps" : "One-way slippage · bps"}<input required type="number" min="0" max="1000" step="0.01" value={slippage} onChange={e=>setSlippage(e.target.value)}/></label>
      <label className={styles.field}>{zh ? "尾部样本外比例" : "Chronological test fraction"}<input required type="number" min="0.2" max="0.5" step="0.05" value={fraction} onChange={e=>setFraction(e.target.value)}/></label>
      <label className={styles.field}>{zh ? "相关性对照（可选）" : "Correlation comparison (optional)"}<select value={compare} onChange={e=>setCompare(e.target.value)}><option value="">{zh ? "不比较" : "None"}</option>{factors.filter(item=>item.factor_id!==factor.factor_id).map(item=><option key={item.factor_id} value={JSON.stringify({factor_id:item.factor_id,version:item.version})}>{item.name} · v{item.version}</option>)}</select></label>
    </div>
    <p className={styles.muted}>{zh ? "手续费 5 bps、滑点 2 bps 仅为可修改的研究假设，不是账户费率。1 bps = 0.01%。" : "5 bps fees and 2 bps slippage are editable research assumptions, not your account rates. 1 bps = 0.01%."}</p>
    {error && <ErrorBanner error={error}/>}
    <div className={styles.actions}><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? (zh ? "计算中…" : "Calculating…") : (zh ? "运行本地验证" : "Run local diagnostics")}</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>setLoaded(v=>v+1)}>{zh ? "刷新数据窗口" : "Refresh data windows"}</button></div>
  </form>;
}
