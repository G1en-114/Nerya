"use client";
import { copy as i18nCopy, type ResourceTranslator } from "../../lib/i18n";
import { useEffect, useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import { clientApi } from '../../lib/clientApi';
import type { BrowserNetworkRequest } from '../../lib/browserDesktopTypes';
import styles from './BrowserWorkspacePanel.module.css';

export function BrowserNetworkPanel({profile, active=true}:{profile:string;active?:boolean}) {
  const activeRef=useRef(active);
  activeRef.current=active;
  const zh=useLocale().startsWith('zh');
  const t = ((key: string, values?: Record<string, unknown>) => i18nCopy(zh, key, values)) as ResourceTranslator;
  const [rows,setRows]=useState<BrowserNetworkRequest[]>([]);
  const [query,setQuery]=useState(''),[kind,setKind]=useState('');
  const [error,setError]=useState(''),[listening,setListening]=useState(false);
  const [dropped,setDropped]=useState(0);
  const [selected,setSelected]=useState(''),[detail,setDetail]=useState<BrowserNetworkRequest|null>(null);
  const [detailTab,setDetailTab]=useState('headers'),[detailError,setDetailError]=useState('');
  const [offset,setOffset]=useState(0),[loading,setLoading]=useState(false);
  const generation=useRef(0);
  useEffect(()=>{
    let alive=true,cursor=0,instance:string|undefined,timer:ReturnType<typeof setTimeout>,request:AbortController;
    setRows([]);setSelected('');setDetail(null);generation.current++;
    const poll=async()=>{
      if(document.hidden || !activeRef.current){timer=setTimeout(poll,750);return;}
      request=new AbortController();const deadline=setTimeout(()=>request.abort(),6000);
      let delay=750;
      try {
        const data=await clientApi.browserSurface({operation:'network',profile_id:profile,after:cursor,generation:instance,limit:100,filter:query,resource_type:kind},request.signal);
        if(!alive || !activeRef.current)return;
        if(!data.ok)throw new Error(data.error||'network_unavailable');
        const reset=data.reset===true || (data.cursor??0)<cursor || (!!instance&&instance!==data.generation);
        if(reset){generation.current++;setSelected('');setDetail(null);}
        instance=data.generation;
        cursor=data.cursor??0;
        setRows(old=>[...new Map([...(reset?[]:old),...(data.requests||[])].map(r=>[r.id,r])).values()].sort((a,b)=>a.seq-b.seq).slice(-500));
        setListening(data.listening===true);setDropped(data.dropped||0);setError('');
        if(data.attach_errors)setError(t("copy.components_chat_BrowserNetworkPanel.001"));
        if(data.has_more)delay=40;
      }catch(e){if(alive){setError(e instanceof Error?e.message:'network_unavailable');setListening(false);}delay=1500;}
      finally{clearTimeout(deadline);if(alive)timer=setTimeout(poll,delay);}
    };
    const start=setTimeout(()=>void poll(),180);
    return()=>{alive=false;generation.current++;clearTimeout(start);clearTimeout(timer);request?.abort();};
  },[profile,query,kind]);
  useEffect(()=>{
    setDetail(null);setDetailError('');
    if(!selected)return;
    let alive=true;const version=generation.current;
    setLoading(true);
    clientApi.browserDesktop({operation:'network_detail',profile_id:profile,network_id:selected,include_body:detailTab==='response',offset,max_chars:6000})
      .then(data=>{if(!alive||generation.current!==version)return;if(!data.ok||!data.request)throw new Error(data.error||'network_request_missing_or_expired');setDetail(data.request);})
      .catch(e=>{if(alive)setDetailError(e.message||'network_detail_failed');})
      .finally(()=>{if(alive)setLoading(false);});
    return()=>{alive=false;};
  },[profile,selected,detailTab,offset]);
  const choose=(id:string)=>{setSelected(id);setOffset(0);setDetailTab('headers');};
  return <section className={styles.network} data-testid="browser-network">
    <div className={styles.networkStatus}><span role="status">{listening?t("copy.components_chat_BrowserNetworkPanel.002"):t("copy.components_chat_BrowserNetworkPanel.003")}</span><span>{rows.length}{dropped?` · ${t("copy.components_chat_BrowserNetworkPanel.004")}`:''}</span></div>
    <div className={styles.networkFilters}>
      <input aria-label={t("copy.components_chat_BrowserNetworkPanel.005")} value={query} onChange={e=>setQuery(e.target.value)} placeholder={t("copy.components_chat_BrowserNetworkPanel.006")}/>
      <select aria-label={t("copy.components_chat_BrowserNetworkPanel.007")} value={kind} onChange={e=>setKind(e.target.value)}><option value="">{t("copy.components_chat_BrowserNetworkPanel.008")}</option><option value="fetch">{t("copy.components_chat_BrowserNetworkPanel.020")}</option><option value="xhr">{t("copy.components_chat_BrowserNetworkPanel.021")}</option><option value="document">{t("copy.components_chat_BrowserNetworkPanel.022")}</option><option value="script">{t("copy.components_chat_BrowserNetworkPanel.023")}</option></select>
    </div>
    {error&&<p role="alert" className="text-xs text-danger">{error}</p>}
    <div className={styles.networkList} role="list" aria-label={t("copy.components_chat_BrowserNetworkPanel.009")}>
      {rows.slice().reverse().map(row=><button key={row.id} type="button" role="listitem" className={styles.networkRow} data-selected={selected===row.id} onClick={()=>choose(row.id)}>
        <span className={row.state==='failed'||(row.status||0)>=400?'text-danger':''}>{row.status??'…'}</span>
        <span>{row.method}</span><span className="min-w-0 truncate" title={row.url}>{row.url.replace(/^https?:\/\//,'')}</span><span>{Math.round(row.duration_ms)}ms</span>
      </button>)}
      {!rows.length&&<p className={styles.muted}>{t("copy.components_chat_BrowserNetworkPanel.010")}</p>}
    </div>
    {selected&&<div className={styles.networkDetail}>
      <nav aria-label={t("copy.components_chat_BrowserNetworkPanel.011")} className={styles.networkDetailTabs}>{[['headers',t("copy.components_chat_BrowserNetworkPanel.012")],['payload',t("copy.components_chat_BrowserNetworkPanel.013")],['response',t("copy.components_chat_BrowserNetworkPanel.014")]].map(([id,label])=><button key={id} aria-pressed={detailTab===id} onClick={()=>{setDetailTab(id);setOffset(0);}}>{label}</button>)}</nav>
      {loading&&<p className={styles.muted}>{t("copy.components_chat_BrowserNetworkPanel.015")}</p>}
      {detailError&&<p role="alert" className="text-xs text-danger">{detailError}</p>}
      {detail&&<><p className={`${styles.muted} break-all`}>{detail.method} {detail.url}</p>
        <pre>{detailTab==='headers'?JSON.stringify({request:detail.request_headers,response:detail.response_headers},null,2):detailTab==='payload'?(detail.request_body||t("copy.components_chat_BrowserNetworkPanel.016")):(detail.body??detail.body_state??t("copy.components_chat_BrowserNetworkPanel.017"))}</pre>
        {detailTab==='response'&&detail.next_offset!=null&&<button className="btn btn-ghost text-xs" onClick={()=>setOffset(detail.next_offset!)}>{t("copy.components_chat_BrowserNetworkPanel.018")}</button>}
      </>}
    </div>}
    <p className={styles.muted}>{t("copy.components_chat_BrowserNetworkPanel.019")}</p>
  </section>;
}
