"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { factorRequest, factorSourceUrl, type Factor, type BacktestFactorsData } from "../../lib/factorLibrary";
import { FactorResearchButton } from "../factors/FactorResearchButton";
import { ErrorBanner } from "../Page";
import styles from "../factors/Factors.module.css";

export function BacktestFactors({strategyId,ts,proposalId}:{strategyId:string;ts:string;proposalId?:string|null}){
  const zh=useLocale().startsWith("zh");
  const [data,setData]=useState<BacktestFactorsData|null>(null),[error,setError]=useState(""),[retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();setData(null);setError("");
    factorRequest<BacktestFactorsData>("backtest",{strategy_id:strategyId,ts,proposal_id:proposalId||null},controller.signal).then(setData).catch(e=>{if(!controller.signal.aborted)setError(String(e.message||e));});
    return ()=>controller.abort();
  },[strategyId,ts,proposalId,retry]);
  const source={strategy_id:strategyId,ts,proposal_id:proposalId};
  const row=(factor:Factor)=><Link key={`${factor.factor_id}:${factor.version}`} className={styles.item} href={`/factors?id=${encodeURIComponent(factor.factor_id)}&version=${factor.version}`}><span className={styles.itemTitle}>{factor.name}<span className={styles.badge}>v{factor.version}</span></span><code className={styles.itemFormula}>{factor.expression}</code><span className={styles.muted}>{factor.factor_id} · {factor.definition_hash?.slice(0,12)}</span></Link>;
  return <section className="space-y-5" data-testid="backtest-factors">
    <div><h3 className="text-sm font-semibold">{zh?"从回测走向可复用研究":"From replay to reusable research"}</h3><p className={styles.muted}>{zh?"策略整体收益与单因子价值分开记录；不会根据买卖点或总收益编造因子贡献。":"Overall strategy performance and single-factor evidence are separate. Trade markers and total return do not establish factor attribution."}</p></div>
    {error ? <><ErrorBanner error={error}/><button className="btn btn-ghost" onClick={()=>setRetry(v=>v+1)}>{zh?"重新加载":"Retry"}</button></> : !data ? <p role="status" className={styles.muted}>{zh?"读取本次回测的因子记录…":"Loading this replay’s factor records…"}</p> : <>
      <section><h4 className={styles.subheading}>{zh?"本次回测声明引用的固定版本":"Pinned definitions declared by this replay"}</h4><div className="grid gap-2">{data.used_factors.length?data.used_factors.map(row):<p className={styles.notice}>{zh?"本次报告没有记录 factors.json 引用快照。不能据此断言策略没有指标或因子，也不会用当前策略内容补写历史证据。":"No factors.json reference snapshot was recorded. This does not prove the strategy used no indicators; current source is not substituted for historical evidence."}</p>}</div></section>
      <section><h4 className={styles.subheading}>{zh?"从这次回测研究中提取的候选因子":"Candidates subsequently extracted from this research"}</h4><div className="grid gap-2">{data.extracted_factors.length?data.extracted_factors.map(row):<p className={styles.muted}>{zh?"尚未提取。可让 Agent 读取本次冻结源码、提取可解释公式并保存候选因子。":"None yet. Ask the Agent to inspect this frozen source, extract an explainable expression and save a candidate."}</p>}</div></section>
    </>}
    <div className={styles.actions}><FactorResearchButton source={source}/><Link className="btn btn-ghost" href={factorSourceUrl(source)}>{zh?"打开因子库":"Open factor library"}</Link></div>
    <p className={styles.muted}>{zh?"提取不会修改原策略或原回测。后续验证会创建独立实验，失败结果同样保留。":"Extraction does not modify the original strategy or backtest. Validation creates separate experiments and retains failures."}</p>
  </section>;
}
