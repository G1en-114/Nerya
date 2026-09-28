"use client";

import { Suspense, useCallback, useEffect, useId, useMemo, useState } from "react";
import { useLocale } from "next-intl";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { PageBody, PageHeader, ErrorBanner } from "../../components/Page";
import { WorkspaceTabs } from "../../components/chat/WorkspaceTabs";
import { PlusIcon, SkillsIcon } from "../../components/icons";
import { FactorEditor, categories, categoryLabel } from "../../components/factors/FactorEditor";
import { FactorValidation } from "../../components/factors/FactorValidation";
import { FactorEvidence } from "../../components/factors/FactorEvidence";
import { FactorResearchButton } from "../../components/factors/FactorResearchButton";
import { FactorSkillAccess } from "../../components/factors/FactorSkillAccess";
import { factorRequest, type Factor, type FactorDetail, type FactorSource } from "../../lib/factorLibrary";
import styles from "../../components/factors/Factors.module.css";

function FactorLibrary() {
  const zh = useLocale().startsWith("zh"), search = useSearchParams(), tabsId = `factors-${useId().replace(/:/g,"")}`;
  const requestedId = search?.get("id") || "", requestedVersion = Number(search?.get("version")) || undefined;
  const source = useMemo<FactorSource | undefined>(() => search?.get("strategy_id") && search?.get("ts") ? {strategy_id:search.get("strategy_id")!,ts:search.get("ts")!,proposal_id:search.get("proposal_id")} : undefined, [search]);
  const [factors,setFactors] = useState<Factor[]>([]), [loading,setLoading] = useState(true), [error,setError] = useState("");
  const [selected,setSelected] = useState(requestedId), [version,setVersion] = useState<number | undefined>(requestedVersion);
  const [detail,setDetail] = useState<FactorDetail | null>(null), [detailError,setDetailError] = useState(""), [detailLoading,setDetailLoading] = useState(false);
  const [query,setQuery] = useState(""), [category,setCategory] = useState(""), [status,setStatus] = useState("");
  const [tab,setTab] = useState("definition"), [editor,setEditor] = useState<"create"|"edit"|null>(null), [runIndex,setRunIndex] = useState(0);
  const [revision,setRevision] = useState(0), [exporting,setExporting] = useState(false);
  useEffect(()=>{setSelected(requestedId);setVersion(requestedVersion);},[requestedId,requestedVersion]);
  const refresh = useCallback(()=>setRevision(value=>value+1),[]);
  useEffect(()=>{
    const controller = new AbortController(); setLoading(true);
    factorRequest<{factors:Factor[]}>("list",{},controller.signal).then(result=>{setFactors(result.factors);setError("");}).catch(e=>{if(!controller.signal.aborted)setError(String(e.message||e));}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[revision]);
  useEffect(()=>{
    if(!selected){setDetail(null);setDetailError("");return;}
    const controller = new AbortController();setDetail(null);setDetailLoading(true);setDetailError("");setRunIndex(0);
    factorRequest<FactorDetail>("get",{factor_id:selected,version},controller.signal).then(result=>{if(!controller.signal.aborted)setDetail(result);}).catch(e=>{if(!controller.signal.aborted)setDetailError(String(e.message||e));}).finally(()=>{if(!controller.signal.aborted)setDetailLoading(false);});
    return ()=>controller.abort();
  },[selected,version,revision]);
  const filtered = useMemo(()=>factors.filter(f=>(!category||f.category===category)&&(!status||f.status===status)&&(!query||`${f.name} ${f.factor_id} ${f.expression} ${f.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase()))),[factors,category,status,query]);
  const current = detail?.factor, run = detail?.runs[runIndex];
  const stateLabel = (state:string) => zh ? ({candidate:"候选",retired:"已停用",rejected:"已否定"}[state] || state) : state;
  return <PageBody>
    <PageHeader eyebrow={zh ? "研究资产 / FACTOR LIBRARY" : "RESEARCH ASSETS / FACTOR LIBRARY"} title={zh ? "因子库" : "Factor library"}
      description={zh ? "从策略研究中沉淀可复用因子。每个公式、每次验证、每次策略引用，都有明确版本。" : "Reusable factors from strategy research. Every definition, experiment and strategy reference has an explicit version."}
      actions={<><FactorResearchButton source={source}/><button className="btn btn-primary" onClick={()=>setEditor("create")}><PlusIcon size={15}/>{zh ? "添加因子" : "Add factor"}</button></>}/>
    {source && <div className={styles.source}><div><strong className="text-sm">{zh ? "来自本次回测的研究" : "Research from this backtest"}</strong><p className={styles.muted}>{source.strategy_id} · {source.ts}</p><p className={styles.muted}>{zh ? "新候选因子将保留这次回测的来源，不会反写为当时已使用的因子。" : "New candidates retain this source; they are not retroactively declared as used in the run."}</p></div><FactorResearchButton source={source}/></div>}
    {error && <div className="mb-4"><ErrorBanner error={error}/><button className="btn btn-ghost" onClick={refresh}>{zh ? "重新连接" : "Retry connection"}</button></div>}
    <FactorSkillAccess/>
    <div className={styles.layout}>
      <aside className={styles.catalog} aria-label={zh ? "因子目录" : "Factor catalog"}>
        <div className={styles.toolbar}><span className={styles.eyebrow}>{zh ? "可复用定义" : "REUSABLE DEFINITIONS"} / {factors.length.toString().padStart(2,"0")}</span><button className="ml-auto text-xs text-[color:var(--text-muted)]" onClick={refresh} disabled={loading}>{zh ? "刷新" : "Refresh"}</button></div>
        <input className={styles.search} type="search" aria-label={zh ? "搜索因子" : "Search factors"} placeholder={zh ? "搜索名称、公式、标签…" : "Search name, formula, tags…"} value={query} onChange={e=>setQuery(e.target.value)}/>
        <div className={styles.fields}><select className={styles.select} aria-label={zh ? "因子分类" : "Factor category"} value={category} onChange={e=>setCategory(e.target.value)}><option value="">{zh ? "全部分类" : "All categories"}</option>{categories.map(c=><option key={c} value={c}>{categoryLabel(c,zh)}</option>)}</select><select className={styles.select} aria-label={zh ? "研究状态" : "Research status"} value={status} onChange={e=>setStatus(e.target.value)}><option value="">{zh ? "全部状态" : "All statuses"}</option>{["candidate","retired","rejected"].map(s=><option key={s} value={s}>{stateLabel(s)}</option>)}</select></div>
        <div className={styles.list} aria-busy={loading}>{loading && !factors.length ? <p className={styles.muted} role="status">{zh ? "载入因子库…" : "Loading library…"}</p> : filtered.map(f=><button key={f.factor_id} type="button" className={styles.item} data-active={selected===f.factor_id} aria-pressed={selected===f.factor_id} onClick={()=>{setSelected(f.factor_id);setVersion(undefined);setTab("definition");}}><span className={styles.itemTitle}>{f.name}<span className={styles.badge}>v{f.version}</span></span><code className={styles.itemFormula}>{f.expression}</code><span className={styles.itemMeta}><span>{categoryLabel(f.category,zh)} · {stateLabel(f.status)}</span><span>{f.run_count || 0} {zh ? "次诊断" : "runs"}</span></span></button>)}</div>
        {!loading && !filtered.length && <p className={styles.muted}>{factors.length ? (zh ? "没有匹配的因子。" : "No matching factors.") : (zh ? "因子库为空，不预置未经验证的因子。" : "No factors yet. Unverified defaults are not seeded.")}</p>}
      </aside>
      <section className={styles.detail} data-testid="factor-detail" aria-label={zh ? "所选因子" : "Selected factor"}>
        {detailLoading ? <div className={styles.empty} role="status">{zh ? "读取因子版本与实验记录…" : "Loading version and experiments…"}</div> : detailError ? <div className={styles.content}><ErrorBanner error={detailError}/><button className="btn btn-ghost" onClick={refresh}>{zh ? "重新读取" : "Retry"}</button></div> : !current ? <div className={styles.empty}><SkillsIcon size={36}/><h2>{zh ? "让研究成果成为下一条策略的起点" : "Make research the starting point of your next strategy"}</h2><p className={styles.muted}>{factors.length ? (zh ? "选择左侧因子，查看公式、固定版本与独立验证记录。" : "Select a factor to inspect its formula, pinned versions and independent evidence.") : (zh ? "从已有策略提取，或保存一个清晰的研究假设。验证结果和失败记录会随版本保留。" : "Extract from an existing strategy or save an explicit hypothesis. Evidence and failed experiments stay with each version.")}</p><FactorResearchButton source={source}/></div> : <>
          <header className={styles.detailHeader}><div className={styles.eyebrow}>{current.factor_id}</div><div className="flex flex-wrap items-center gap-3"><h2 className={styles.heading}>{current.name}</h2><span className={styles.badge}>{stateLabel(current.status)}</span><label className="ml-auto text-xs"><span className="sr-only">{zh ? "选择版本" : "Select version"}</span><select className={styles.select} value={current.version} onChange={e=>setVersion(Number(e.target.value))}>{detail!.versions.map(v=><option key={v.version} value={v.version}>v{v.version}{v.version===detail!.versions[0].version ? (zh ? " · 最新" : " · latest") : ""}</option>)}</select></label></div>
            <pre className={styles.formula}>{current.expression}</pre><p className={styles.muted}>{current.hypothesis || current.description || (zh ? "尚未记录市场假设。保存前请补充可解释的研究逻辑。" : "No hypothesis recorded. Add an explainable research rationale.")}</p>
            <div className={styles.actions}><FactorResearchButton factor={current}/><button className="btn btn-ghost" disabled={current.version!==detail!.versions[0].version} onClick={()=>setEditor("edit")}>{zh ? "编辑" : "Edit"}</button><button className="btn btn-ghost" disabled={exporting} onClick={async()=>{setExporting(true);try{const result=await factorRequest<{files:Record<string,string>}>("export",{factor_id:current.factor_id,version:current.version});const url=URL.createObjectURL(new Blob([result.files["factors.json"]],{type:"application/json"}));const link=document.createElement("a");link.href=url;link.download=`${current.factor_id}.v${current.version}.factors.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){setDetailError(String(e));}finally{setExporting(false);}}}>{zh ? "导出固定版本" : "Export pinned version"}</button></div>
          </header>
          <WorkspaceTabs id={tabsId} label={zh ? "因子详情" : "Factor details"} value={tab} onChange={setTab} tabs={[{id:"definition",label:zh?"定义与来源":"Definition & source"},{id:"validation",label:zh?"验证因子":"Run diagnostics"},{id:"evidence",label:zh?"验证记录":"Evidence",meta:detail?.runs.length || "0"}]}/>
          <div className={styles.content} role="tabpanel" id={`${tabsId}-panel-${tab}`} aria-labelledby={`${tabsId}-tab-${tab}`}>
            {tab==="definition" && <><dl className={styles.facts}>{[[zh?"数据输入":"Inputs",current.inputs.join(", ")],[zh?"最少回看":"Minimum lookback",`${current.lookback} bars`],[zh?"可用时间":"Available at",zh?"K 线收盘后":"Bar close"],[zh?"适用品种":"Markets",current.markets.join(", ")||(zh?"未限制（非已验证）":"Unrestricted, not validated")],[zh?"适用周期":"Timeframes",current.timeframes.join(", ")||(zh?"未限制":"Unrestricted")],[zh?"方向":"Direction",current.direction==="higher_is_bullish"?(zh?"越高越偏多":"Higher is bullish"):(zh?"越低越偏多":"Lower is bullish")]].map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl><section className="mt-6"><h3 className={styles.subheading}>{zh?"参数":"Parameters"}</h3><pre className={styles.formula}>{JSON.stringify(current.parameters,null,2)}</pre></section>{current.source_backtest && <p className={styles.notice}>{zh?"来源回测":"Source backtest"}: {current.source_backtest.strategy_id} · {current.source_backtest.ts}<br/>{zh?"来源仅证明提取出处，不证明该因子贡献了策略收益。":"Source indicates extraction provenance, not causal strategy attribution."}</p>}<div className="mt-5"><p className={styles.muted}>{zh?"本次修改":"Change reason"}: {current.change_reason}</p><p className={styles.muted}>{zh?"版本校验":"Definition hash"}: {current.definition_hash}</p></div><p className={`${styles.notice} mt-5`}>{zh?"通过 Skill 导出后，将 factors.json 放入新策略包，再使用 nerya.sdk.factors.calculate_factor 计算。只使用收盘数据；固定版本，不在运行时跟随最新定义。":"Export via the Skill, keep factors.json in the strategy package and compute with nerya.sdk.factors.calculate_factor. Supply closed bars only and pin the version, never resolve latest during execution."}</p></>}
            {tab==="validation" && <FactorValidation key={`${current.factor_id}:${current.version}`} factor={current} factors={factors} onComplete={()=>{refresh();setTab("evidence");}}/>}
            {tab==="evidence" && (detail?.runs.length ? <><div className={styles.runs}>{detail.runs.map((r,i)=><button type="button" aria-pressed={runIndex===i} key={r.run_id} onClick={()=>setRunIndex(i)}>{r.created_at.slice(0,19).replace("T"," ")} UTC · {r.status}</button>)}</div>{run && <FactorEvidence run={run}/>}</> : <div className={styles.empty}><h2>{zh?"这个版本还没有验证记录":"No evidence for this version"}</h2><p className={styles.muted}>{zh?"不会继承旧版本的结论，也不会用未经计算的示例指标填充。":"Evidence is not inherited from old versions or populated with example metrics."}</p><button className="btn btn-secondary" onClick={()=>setTab("validation")}>{zh?"开始本地验证":"Run local diagnostics"}</button></div>)}
          </div>
        </>}
      </section>
    </div>
    <p className={`${styles.muted} mt-6`}>{zh ? "因子诊断不等于完整策略回测，也不会自动启用策略或进行交易。" : "Factor diagnostics are not full strategy backtests and never activate strategies or trade."} <Link className="underline" href="/agents?tab=skills">{zh?"管理研究 Skill":"Manage research skills"}</Link></p>
    {editor && <FactorEditor factor={editor==="edit" ? current : undefined} source={editor==="create" ? source : undefined} onClose={()=>setEditor(null)} onSaved={f=>{setEditor(null);setSelected(f.factor_id);setVersion(f.version);setTab("definition");refresh();}}/>}
  </PageBody>;
}

export default function FactorsPage(){return <Suspense fallback={<PageBody><p role="status">Loading…</p></PageBody>}><FactorLibrary/></Suspense>;}
