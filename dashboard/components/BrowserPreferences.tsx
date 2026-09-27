"use client";
import { Icon as NeryaGlyph } from "./icons";
import { copy as i18nCopy } from "../lib/i18n";
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale } from 'next-intl';
import { clientApi } from '../lib/clientApi';
import { GlobeIcon } from './icons';

export function BrowserPreferences(){
  const zh=useLocale().startsWith('zh');
  const [automatic,setAutomatic]=useState(true),[busy,setBusy]=useState(true),[error,setError]=useState('');
  useEffect(()=>{let active=true;clientApi.browserDesktop({operation:'preferences'}).then(r=>{if(active){if(!r.ok)throw new Error(r.error);setAutomatic(r.preferences?.automatic??true);}}).catch(e=>{if(active)setError(String(e.message||e));}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;};},[]);
  async function change(value:boolean){const previous=automatic;setAutomatic(value);setBusy(true);setError('');try{const r=await clientApi.browserDesktop({operation:'preferences',automatic:value});if(!r.ok)throw new Error(r.error);setAutomatic(r.preferences?.automatic??value);}catch(e){setAutomatic(previous);setError(e instanceof Error?e.message:'browser_preferences_failed');}finally{setBusy(false);}}
  return <section className="mx-auto w-full max-w-2xl rounded-xl border border-[color:var(--line)] bg-[color:var(--card)] p-6" data-testid="browser-preferences">
    <div className="mb-6 flex items-center gap-3"><GlobeIcon size={23}/><div><h2 className="text-base font-semibold">{i18nCopy(zh, "copy.components_BrowserPreferences.001")}</h2><p className="mt-1 text-xs text-[color:var(--text-muted)]">Chromium · {i18nCopy(zh, "copy.components_BrowserPreferences.002")}</p></div></div>
    <label className="flex items-center justify-between gap-6"><span className="text-sm font-medium">{i18nCopy(zh, "copy.components_BrowserPreferences.003")}</span><input type="checkbox" role="switch" checked={automatic} disabled={busy} onChange={e=>void change(e.target.checked)}/></label>
    <p className="mt-3 text-sm leading-relaxed text-[color:var(--text-muted)]">{i18nCopy(zh, "copy.components_BrowserPreferences.004")}</p>
    <p className="mt-4 text-xs leading-relaxed text-[color:var(--text-muted)]">{i18nCopy(zh, "copy.components_BrowserPreferences.005")}</p>
    {error&&<p className="mt-4 text-sm text-danger" role="alert">{error}</p>}
    <Link className="btn btn-primary mt-6 inline-flex" href="/browsers">{i18nCopy(zh, "copy.browserChrome.openStandalone")} <NeryaGlyph name="arrowUpRight" size={16} /></Link>
  </section>;
}
