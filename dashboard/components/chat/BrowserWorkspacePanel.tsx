"use client";
import { copy as i18nCopy } from "../../lib/i18n";

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { clientApi } from '../../lib/clientApi';
import { browserAddress } from '../../lib/browserNavigation';
import type { DesktopBrowserResponse, DesktopExtension } from '../../lib/browserDesktopTypes';
import { mergeBrowserEvents, type BrowserCall, type BrowserTrace, type BrowserTraceEvent } from '../../lib/browserTrace';
import { confirm } from '../../lib/dialogs';
import { GlobeIcon, Icon as NeryaGlyph, type IconName } from '../icons';
import { BrowserNetworkPanel } from './BrowserNetworkPanel';
import { BrowserOperatorDialog } from './BrowserOperatorDialog';
import { BROWSER_VIEWPORT_PRESETS, DEFAULT_BROWSER_VIEWPORT, boundedBrowserViewport, browserViewportPoint, fitBrowserViewport, validBrowserViewport, type BrowserViewport, type BrowserViewportMode } from '../../lib/browserViewport';
import styles from './BrowserWorkspacePanel.module.css';

const glyphs: Record<string, IconName> = {
  back: 'arrowLeft', forward: 'arrowRight', reload: 'refresh', plus: 'plus', close: 'x',
  native: 'arrowUpRight', extensions: 'puzzle', key: 'key',
};
function BrowserGlyph({name}:{name:string}) { return <NeryaGlyph name={glyphs[name] || 'arrowUpRight'} size={18} />; }

const EMPTY: BrowserTrace = { ok:true, status:'pending', events:[], cursor:0 };
const labels: Record<string, string> = { navigate: "copy.browserPanelActions.001", open: "copy.browserPanelActions.002", batch: "copy.browserPanelActions.003", click: "copy.browserPanelActions.004", click_xy: "copy.browserPanelActions.005", fill: "copy.browserPanelActions.006", select: "copy.browserPanelActions.007", select_text: "copy.browserPanelActions.008", check: "copy.browserPanelActions.009", press: "copy.browserPanelActions.010", move: "copy.browserPanelActions.011", dom: "copy.browserPanelActions.012", snapshot: "copy.browserPanelActions.013", read: "copy.browserPanelActions.014", scroll: "copy.browserPanelActions.015", wait_for: "copy.browserPanelActions.016", screenshot: "copy.browserPanelActions.017", hover: "copy.browserPanelActions.018", drag: "copy.browserPanelActions.019", new_tab: "copy.browserPanelActions.020", select_tab: "copy.browserPanelActions.021", close_tab: "copy.browserPanelActions.022", extension_open: "copy.browserPanelActions.023" };
const shortUrl = (url: string) => { try { const u=new URL(url); return u.hostname + (u.pathname === '/' ? '' : u.pathname); } catch { return url || 'New tab'; } };

export function BrowserWorkspacePanel({ conversationId, calls = [], active = true, expanded = false, onToggleSize, onClose }: {
  conversationId: string; calls?: BrowserCall[]; active?: boolean; expanded?: boolean;
  onToggleSize?: () => void; onClose?: () => void;
}) {
  const zh = useLocale().startsWith('zh');
  const t = (key: string, values?: Record<string, unknown>) => i18nCopy(zh, key, values);
  const nb = (key: string) => t(`copy.browserChrome.${key}`);
  const actionName = (op:string) => labels[op] ? t(labels[op]) : op;
  const [chosen,setChosen] = useState('');
  const selected = calls.find(c=>c.id===chosen) || calls.filter(c=>!['network','api_requests','network_detail'].includes(c.operation)).at(-1) || calls.at(-1);
  const callId = selected?.id || '';
  const profile = selected?.profileId || 'work';
  const [surface,setSurface] = useState<DesktopBrowserResponse>({ok:true});
  const [trace,setTrace] = useState<BrowserTrace>(EMPTY);
  const [historyFrame,setHistoryFrame] = useState<number | null>(null);
  const [section,setSection] = useState('page');
  const [timelineOpen,setTimelineOpen] = useState(false);
  const [address,setAddress] = useState('');
  const [history,setHistory] = useState<NonNullable<DesktopBrowserResponse['history']>>([]);
  const [query,setQuery] = useState('');
  const [extensionPath,setExtensionPath] = useState('');
  const [review,setReview] = useState<DesktopExtension | null>(null);
  const [error,setError] = useState('');
  const [connectionError,setConnectionError] = useState(false);
  const [traceError,setTraceError] = useState(false);
  const [busy,setBusy] = useState(false);
  const [refresh,setRefresh] = useState(0);
  const epoch = useRef(0), inFlight=useRef(false);
  const keyboard=useRef<HTMLTextAreaElement>(null);
  const omnibox=useRef<HTMLInputElement>(null);
  const viewportRef=useRef<HTMLDivElement>(null);
  const stageRef=useRef<HTMLDivElement>(null), imageRef=useRef<HTMLImageElement>(null);
  const [available,setAvailable]=useState<BrowserViewport>({width:0,height:0});
  const [viewportMode,setViewportMode]=useState<BrowserViewportMode>('fill');
  const [customViewport,setCustomViewport]=useState(DEFAULT_BROWSER_VIEWPORT);
  const [sizeDraft,setSizeDraft]=useState({width:'1280',height:'800'});
  const [imageSize,setImageSize]=useState(DEFAULT_BROWSER_VIEWPORT);
  const [resizing,setResizing]=useState(false);
  const resizeInFlight=useRef(false);
  useEffect(()=>{
    const stage=stageRef.current;if(!active||!stage)return;
    const measure=()=>{
      const next={width:stage.clientWidth,height:stage.clientHeight};
      if(next.width&&next.height)setAvailable(previous=>previous.width===next.width&&previous.height===next.height?previous:next);
    };
    measure();const observer=new ResizeObserver(measure);observer.observe(stage);
    return()=>observer.disconnect();
  },[active,section]);
  const desiredViewport=viewportMode==='fill'?boundedBrowserViewport(available):viewportMode==='custom'?customViewport:BROWSER_VIEWPORT_PRESETS[viewportMode];
  const wheelBuffer=useRef<{dx:number;dy:number;version:number;tabId:string;url:string}|null>(null);
  const wheelTimer=useRef<ReturnType<typeof setTimeout>>();
  const wheelHandler=useRef<(event:WheelEvent)=>void>(()=>{});
  const flushWheel=useRef<()=>void>(()=>{});
  useEffect(()=>{
    const element=viewportRef.current;if(!element)return;
    const listener=(event:WheelEvent)=>wheelHandler.current(event);
    element.addEventListener('wheel',listener,{passive:false});
    return()=>{element.removeEventListener('wheel',listener);clearTimeout(wheelTimer.current);wheelTimer.current=undefined;wheelBuffer.current=null;};
  },[section,active]);
  const surfaceRef=useRef(surface); surfaceRef.current=surface;
  const inputPending=useRef(0), surfaceVersion=useRef(0);
  const inputQueue=useRef(Promise.resolve());
  function acceptSurface(data: DesktopBrowserResponse) {
    const next = {...surfaceRef.current, ...data};
    if ('running' in data) next.image = data.image;
    surfaceRef.current = next;
    setSurface(next);
  }
  function errorText(error: unknown) {
    const code = error instanceof Error ? error.message : 'browser_operation_failed';
    if (code === 'chrome_unavailable' || (code === 'managed_browser_failed' && surfaceRef.current.config?.engine === 'chrome')) return nb('chromeUnavailable');
    if (['browser_tab_changed', 'browser_page_changed', 'browser_session_changed', 'human_control_changed', 'browser_viewport_changed'].includes(code)) return nb('pageChanged');
    if (code === 'protected_browser_ui_use_native_window') return nb('protected');
    return code;
  }
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;epoch.current++;};},[]);
  useEffect(()=>{setTrace(EMPTY);setHistoryFrame(null);setReview(null);setError('');epoch.current++;},[conversationId,callId]);

  useEffect(()=>{setSurface({ok:true});setHistory([]);setAddress('');setConnectionError(false);epoch.current++;},[conversationId,profile]);

  // Independent reads keep the view responsive while the Chromium queue is busy.
  useEffect(()=>{
    if(!active) return;
    let alive=true; let timer:ReturnType<typeof setTimeout>; let request:AbortController;
    const poll=async()=>{
      if(!alive)return;
      if(document.hidden || inFlight.current || inputPending.current){timer=setTimeout(poll,200);return;}
      const version=epoch.current, snapshot=surfaceVersion.current;
      request=new AbortController(); const deadline=setTimeout(()=>request.abort(),12000);
      try {
        const data=await clientApi.browserSurface({operation:'surface',profile_id:profile},request.signal);
        if(!alive || version!==epoch.current || snapshot!==surfaceVersion.current)return;
        if(!data.ok)throw new Error(data.error);
        acceptSurface(data);setConnectionError(false);
      }catch{if(alive && version===epoch.current && snapshot===surfaceVersion.current){setConnectionError(true);setSurface(s=>({...s,image:undefined}));}}
      finally{clearTimeout(deadline);if(alive)timer=setTimeout(poll,surfaceRef.current.human_control?300:650);}
    };
    void poll();
    const hidden=()=>{if(document.hidden){request?.abort();setSurface(s=>({...s,image:undefined}));}};
    document.addEventListener('visibilitychange',hidden);
    return()=>{alive=false;clearTimeout(timer);request?.abort();document.removeEventListener('visibilitychange',hidden);};
  },[active,profile,conversationId,refresh]);

  useEffect(()=>{
    if(!active || !callId || !conversationId)return;
    let alive=true,cursor=0,pending=0; let timer:ReturnType<typeof setTimeout>; let request:AbortController;
    const version=epoch.current;
    const poll=async()=>{
      if(!alive)return;
      if(document.hidden){timer=setTimeout(poll,800);return;}
      request=new AbortController(); const deadline=setTimeout(()=>request.abort(),8000);
      let delay=220;
      try{
        const data=await clientApi.browserTrace({operation:'trace',conversation_id:conversationId,call_id:callId,after:cursor,...(historyFrame?{frame_id:historyFrame}:{})},request.signal);
        if(!alive || epoch.current!==version)return;
        if(!data.ok)throw new Error(data.error);
        cursor=data.cursor;setTrace(old=>({...data,events:mergeBrowserEvents(old.events,data.events)}));setTraceError(false);
        if(data.status==='pending' && ++pending>120)return;
        if(!['queued','running','pending'].includes(data.status))delay=1200;
        if(data.frame_state==='expired')return;
      }catch{if(alive && epoch.current===version){setTraceError(true);setTrace(s=>({...s,frame:null}));}delay=1500;}
      finally{clearTimeout(deadline);}
      if(alive)timer=setTimeout(poll,delay);
    };
    void poll();
    const hidden=()=>{if(document.hidden){request?.abort();setTrace(s=>({...s,frame:null}));}};
    document.addEventListener('visibilitychange',hidden);
    return()=>{alive=false;clearTimeout(timer);request?.abort();document.removeEventListener('visibilitychange',hidden);};
  },[active,conversationId,callId,historyFrame,refresh]);

  const human=surface.human_control === true;
  const owned=!!surface.agent_access?.occupied;
  const locked=busy || connectionError || !!historyFrame || resizing;
  const engine=surface.config?.engine || surface.engine || 'chromium';
  const currentUrl=surface.tabs?.find(tab=>tab.selected)?.url || trace.frame?.url || '';
  useEffect(()=>{if(document.activeElement!==omnibox.current)setAddress(currentUrl==='about:blank'?'':currentUrl);},[currentUrl]);
  const blank=!historyFrame && !surface.sensitive && (!surface.running || currentUrl==='about:blank' || !currentUrl);
  const frame=surface.sensitive ? undefined : historyFrame ? trace.frame?.image : human ? surface.image : surface.agent_access?.executing ? trace.frame?.image : (surface.image || trace.frame?.image);
  const visual=historyFrame ? trace.frame?.visual : trace.visual;
  const displayedUrl=historyFrame || !surface.image || surface.agent_access?.executing ? trace.frame?.url : currentUrl;
  const sourceViewport=(historyFrame || frame!==surface.image ? trace.frame?.viewport : surface.viewport) || imageSize;
  const frameSize=frame&&!blank?sourceViewport:desiredViewport;
  const frameStyle=available.width&&available.height?fitBrowserViewport(frameSize,available):{width:'100%',height:'100%'};
  const showVisual=!human && !!frame && !!visual && (!visual.url || visual.url===displayedUrl)
    && (!visual.viewport || (visual.viewport.width===sourceViewport.width&&visual.viewport.height===sourceViewport.height));

  // Serialize debounced dock resizing with input, never interrupt an Agent batch.
  useEffect(()=>{
    if(!active||section!=='page'||!available.width||!available.height||!surface.running
        ||surface.sensitive||surface.agent_access?.executing||historyFrame||busy||connectionError)return;
    if(surface.viewport?.width===desiredViewport.width&&surface.viewport?.height===desiredViewport.height)return;
    let alive=true;let timer:ReturnType<typeof setTimeout>;
    const version=epoch.current;
    const sync=()=>{
      if(!alive)return;
      if(inFlight.current||inputPending.current||resizeInFlight.current){timer=setTimeout(sync,180);return;}
      resizeInFlight.current=true;setResizing(true);inputPending.current++;surfaceVersion.current++;
      inputQueue.current=inputQueue.current.then(async()=>{
        try{
          if(!alive||!mounted.current||epoch.current!==version)return;
          const data=await clientApi.browserDesktop({operation:'viewport',profile_id:profile,viewport:desiredViewport});
          if(!alive||!mounted.current||epoch.current!==version)return;
          if(!data.ok)throw new Error(data.error);
          acceptSurface(data);
        }catch(e){if(alive&&mounted.current&&epoch.current===version)setError(errorText(e));}
        finally{resizeInFlight.current=false;inputPending.current--;surfaceVersion.current++;if(mounted.current)setResizing(false);}
      });
    };
    timer=setTimeout(sync,220);
    return()=>{alive=false;clearTimeout(timer);};
  },[active,section,profile,available.width,available.height,desiredViewport.width,desiredViewport.height,
    surface.running,surface.sensitive,surface.agent_access?.executing,surface.viewport?.width,surface.viewport?.height,historyFrame,busy,connectionError,refresh]);
  function chooseViewport(mode:BrowserViewportMode){
    if(mode==='custom'){setCustomViewport(desiredViewport);setSizeDraft({width:String(desiredViewport.width),height:String(desiredViewport.height)});}
    setViewportMode(mode);setError('');
  }
  function applyViewport(){
    const next={width:Number(sizeDraft.width),height:Number(sizeDraft.height)};
    if(!validBrowserViewport(next)){setError(nb('sizeInvalid'));return;}
    setCustomViewport(next);setError('');
  }
  const steps=useMemo(()=>{
    const map=new Map<number,BrowserTraceEvent>();
    for(const e of trace.events)if(e.kind==='step' && typeof e.index==='number')map.set(e.index,e);
    return [...map.values()].sort((a,b)=>(a.index||0)-(b.index||0));
  },[trace.events]);

  async function run(body:Record<string,unknown>):Promise<DesktopBrowserResponse | null>{
    if(inFlight.current)return null;
    inFlight.current=true;setBusy(true);setError('');const version=++epoch.current;
    try{
      await inputQueue.current;
      const data=await clientApi.browserDesktop({profile_id:profile,...body});
      if(!mounted.current || epoch.current!==version)return null;
      if(!data.ok)throw new Error(data.error || 'browser_operation_failed');
      if(data.history)setHistory(data.history);
      if(data.review)setReview(data.review);
      if(data.preferences || data.config || 'running' in data)acceptSurface(data);
      return data;
    }catch(e){if(mounted.current)setError(errorText(e));return null;}
    finally{inFlight.current=false;if(mounted.current){setBusy(false);setRefresh(n=>n+1);}}
  }
  async function takeOver(){
    setHistoryFrame(null);setTrace(s=>({...s,frame:null}));
    const sid=surface.agent_access?.session_id;
    return run({operation:'command',command:sid?'trace_control':'handoff',payload:sid?{session_id:sid,control:'handoff',focus:false}:{focus:false}});
  }
  async function releaseControl(){
    const sid=surface.agent_access?.session_id;
    await run({operation:'command',command:sid?'trace_control':'resume',payload:sid?{session_id:sid,control:'resume'}:{}});
  }
  async function openBrowser(){return run({operation:'open',human:true});}
  function manual(command:string,payload:Record<string,unknown>={}){
    if(locked || inFlight.current || resizeInFlight.current)return;
    if(!surface.running && !['navigate','new_tab'].includes(command))return;
    const version=epoch.current;
    const tab=surface.tabs?.find(tab=>tab.selected);
    const guarded=['click','type','press','scroll'].includes(command);
    const viewportRevision=surface.viewport_revision;
    inputPending.current++;surfaceVersion.current++;setError('');
    inputQueue.current=inputQueue.current.then(async()=>{
      try{
        if(version!==epoch.current || !mounted.current)return;
        let state=surfaceRef.current;
        const opened=!state.running;
        if(opened || !state.human_control || !state.control_id){
          const sid=state.agent_access?.session_id;
          state=await clientApi.browserDesktop({profile_id:profile,...(opened?{operation:'open',human:true}:{operation:'command',command:sid?'trace_control':'handoff',payload:sid?{session_id:sid,control:'handoff',focus:false}:{focus:false}})});
          if(!state.ok)throw new Error(state.error);
          if(version!==epoch.current || !mounted.current)return;
          acceptSurface(state);setTrace(s=>({...s,frame:null}));
        }
        if(opened && command==='new_tab')return;
        const data=await clientApi.browserDesktop({operation:'human_command',profile_id:profile,
          session_id:state.agent_access?.session_id || '',control_id:state.control_id,command,payload,
          ...(guarded&&tab?{expected_tab_id:tab.id,expected_url:tab.url,expected_viewport_revision:viewportRevision}:{})});
        if(!data.ok)throw new Error(data.error);
        if(version===epoch.current && mounted.current)acceptSurface(data);
      }catch(e){epoch.current++;if(mounted.current){setError(errorText(e));setRefresh(n=>n+1);}}
      finally{inputPending.current--;surfaceVersion.current++;}
    });
  }
  // Coalesce trackpad bursts and prevent the outer dashboard from scrolling.
  flushWheel.current=()=>{
    const pending=wheelBuffer.current;wheelBuffer.current=null;wheelTimer.current=undefined;
    const tab=surfaceRef.current.tabs?.find(t=>t.selected);
    if(!pending||pending.version!==epoch.current||pending.tabId!==tab?.id||pending.url!==tab?.url)return;
    manual('scroll',{dx:pending.dx,dy:pending.dy});
  };
  wheelHandler.current=event=>{
    if(locked||blank||surface.sensitive||!frame||!surface.running)return;
    event.preventDefault();event.stopPropagation();
    const tab=surface.tabs?.find(t=>t.selected);if(!tab)return;
    const pending=wheelBuffer.current??{dx:0,dy:0,version:epoch.current,tabId:tab.id,url:tab.url};
    const scale=event.deltaMode===1?16:event.deltaMode===2?sourceViewport.height:1;
    pending.dx=Math.max(-3000,Math.min(3000,pending.dx+event.deltaX*scale));
    pending.dy=Math.max(-3000,Math.min(3000,pending.dy+event.deltaY*scale));
    wheelBuffer.current=pending;
    if(!wheelTimer.current)wheelTimer.current=setTimeout(()=>flushWheel.current(),60);
  };
  async function switchEngine(value: 'chromium' | 'chrome') {
    if(value === engine)return true;
    if(!await confirm({message:nb('switchConfirm')}))return false;
    return !!await run({operation:'engine_apply',engine:value});
  }
  async function native(destination='focus') {
    if(destination==='extensions'||destination==='settings'){await showSection(destination);return;}
    if(destination==='web_store'){setSection('page');manual('navigate',{url:'https://chromewebstore.google.com/'});return;}
    // Do not open invisible privileged pages or spawn desktop windows as fallback.
    setSection('settings');setError(nb('systemUiUnavailable'));
  }
  function navigateAddress() {
    const internal:Record<string,string>={'chrome://extensions':'extensions','chrome://settings':'settings','chrome://downloads':'downloads','chrome://bookmarks':'bookmarks','chrome://password-manager/passwords':'passwords'};
    const destination=internal[address.trim().replace(/\/$/,'')];
    if(destination){void native(destination);return;}
    try{manual('navigate',{url:browserAddress(address)});setSection('page');}
    catch{setError(nb('invalidAddress'));}
  }
  function browserShortcut(e: import('react').KeyboardEvent<HTMLElement>) {
    if(e.nativeEvent.isComposing)return;
    const modifier=e.ctrlKey||e.metaKey, key=e.key.toLowerCase();
    if(modifier&&key==='l'){e.preventDefault();setSection('page');requestAnimationFrame(()=>{omnibox.current?.focus();omnibox.current?.select();});}
    else if(modifier&&!e.shiftKey&&['t','w','r'].includes(key)){e.preventDefault();setSection('page');manual(({t:'new_tab',w:'close_tab',r:'reload'} as Record<string,string>)[key]);}
    else if(e.altKey&&['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();manual(e.key==='ArrowLeft'?'back':'forward');}
    else if(modifier&&/^[1-9]$/.test(key)){e.preventDefault();const tabs=surface.tabs||[],tab=tabs[key==='9'?tabs.length-1:Number(key)-1];if(tab){manual('select_tab',{tab_id:tab.id});setSection('page');}}
  }
  async function showSection(value:string){
    setSection(value);
    if(value==='history')await run({operation:'history'});
  }
  async function changeAutomatic(value:boolean){
    const previous=surface.preferences?.automatic??true;
    setSurface(s=>({...s,preferences:{automatic:value}}));
    if(!await run({operation:'preferences',automatic:value}))setSurface(s=>({...s,preferences:{automatic:previous}}));
  }
  async function applyExtensions(extensions:DesktopExtension[]){
    if(surface.running && !human && !await takeOver())return;
    if(!await confirm({message:t("copy.components_chat_BrowserWorkspacePanel.001")}))return;
    if(await run({operation:'extension_apply',extensions})){setReview(null);setExtensionPath('');}
  }
  const status=connectionError ? t("copy.components_chat_BrowserWorkspacePanel.002") : surface.sensitive ? t("copy.components_chat_BrowserWorkspacePanel.003")
    : human ? t("copy.components_chat_BrowserWorkspacePanel.004") : owned ? t("copy.components_chat_BrowserWorkspacePanel.005") : t("copy.components_chat_BrowserWorkspacePanel.006");

  return <section className={styles.panel} onKeyDown={browserShortcut} data-testid="browser-workspace" aria-label={t("copy.components_chat_BrowserWorkspacePanel.007")}>
    <header className={styles.header}>
      <div className={styles.title}><GlobeIcon size={16}/><span>{t("copy.components_chat_BrowserWorkspacePanel.008")}</span><span className={styles.status} role="status">{status}</span></div>
      <div className={styles.tools}>
        {surface.running ? <button className="btn btn-ghost text-xs" disabled={busy} onClick={()=>void(human?releaseControl():takeOver())}>{human?t("copy.components_chat_BrowserWorkspacePanel.009"):t("copy.components_chat_BrowserWorkspacePanel.010")}</button>
          : <button className="btn btn-ghost text-xs" disabled={busy} onClick={()=>void openBrowser()}>{t("copy.components_chat_BrowserWorkspacePanel.011")}</button>}
        <select className={styles.sizeSelect} aria-label={nb('sizeLabel')} title={nb('sizeHint')} value={viewportMode} disabled={busy||!!historyFrame} onChange={e=>chooseViewport(e.target.value as BrowserViewportMode)}>
          {(['fill','desktop','laptop','tablet','phone','custom'] as const).map(mode=><option key={mode} value={mode}>{nb(`size_${mode}`)}</option>)}
        </select>
        <Menu.Root>
          <Menu.Trigger asChild><button type="button" className={styles.icon} aria-label={t("copy.components_chat_BrowserWorkspacePanel.012")} title={t("copy.components_chat_BrowserWorkspacePanel.013")}><NeryaGlyph name="ellipsis" size={18} /></button></Menu.Trigger>
          <Menu.Portal><Menu.Content className="ui-select-menu min-w-48" align="end" sideOffset={6} collisionPadding={8}>
            {[['tabs',t("copy.components_chat_BrowserWorkspacePanel.014")],['extensions',t("copy.components_chat_BrowserWorkspacePanel.015")],['history',t("copy.components_chat_BrowserWorkspacePanel.016")],['network',t("copy.components_chat_BrowserWorkspacePanel.017")],['settings',t("copy.components_chat_BrowserWorkspacePanel.018")]].map(([id,label])=>
              <Menu.Item className="ui-select-option" key={id} onSelect={()=>void showSection(id)}>{label}{id==='tabs'&&<span className="ml-auto text-xs text-[color:var(--text-muted)]">{surface.tabs?.length||0}</span>}</Menu.Item>)}
            <Menu.Separator className="my-1 h-px bg-[color:var(--line)]"/>

            <Menu.Item className="ui-select-option" asChild><a href="/browsers">{nb('openStandalone')}</a></Menu.Item>
            {surface.running&&<Menu.Item className="ui-select-option" disabled={busy} onSelect={()=>void run({operation:'close'})}>{nb('closeBrowser')}</Menu.Item>}
            <Menu.Item className="ui-select-option" onSelect={()=>{setSection('page');setTimelineOpen(true);}}>{t("copy.components_chat_BrowserWorkspacePanel.019")}</Menu.Item>
            {(onToggleSize||onClose)&&<Menu.Separator className="my-1 h-px bg-[color:var(--line)]"/>}
            {onToggleSize&&<Menu.Item className="ui-select-option" onSelect={onToggleSize}>{expanded?t("copy.components_chat_BrowserWorkspacePanel.020"):t("copy.components_chat_BrowserWorkspacePanel.021")}</Menu.Item>}
            {onClose&&<Menu.Item className="ui-select-option" onSelect={onClose}>{t("copy.components_chat_BrowserWorkspacePanel.022")}</Menu.Item>}
          </Menu.Content></Menu.Portal>
        </Menu.Root>
      </div>
    </header>
    <div className={styles.tabStrip} role="tablist" aria-label={t('copy.components_chat_BrowserWorkspacePanel.029')} onKeyDown={e=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
      const buttons=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
      const index=buttons.indexOf(document.activeElement as HTMLButtonElement);if(index<0||!buttons.length)return;
      e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
      buttons[next].focus();buttons[next].click();
    }}>
      {(surface.tabs||[]).map(tab=><div key={tab.id} className={styles.chromeTab} data-selected={tab.selected&&section==='page'}>
        <button type="button" role="tab" aria-selected={tab.selected&&section==='page'} tabIndex={tab.selected?0:-1} disabled={locked} title={tab.url} onClick={()=>{manual('select_tab',{tab_id:tab.id});setSection('page');}}><GlobeIcon size={14}/><span>{tab.url==='about:blank'?nb('newTab'):shortUrl(tab.url)}</span></button>
        <button type="button" className={styles.closeTab} disabled={locked} aria-label={`${t('copy.components_chat_BrowserWorkspacePanel.030')} ${shortUrl(tab.url)}`} onClick={()=>manual('close_tab',{tab_id:tab.id})}><BrowserGlyph name="close"/></button>
      </div>)}
      {!surface.tabs?.length&&<div className={styles.chromeTab} data-selected="true"><button type="button" role="tab" aria-selected="true" onClick={()=>setSection('page')}><GlobeIcon size={14}/><span>{nb('newTab')}</span></button></div>}
      <button type="button" className={styles.icon} disabled={locked} aria-label={nb('newTab')} title={nb('newTab')} onClick={()=>{manual('new_tab');setSection('page');}}><BrowserGlyph name="plus"/></button>
    </div>
    {section!=='page'&&<div className={styles.sectionHeading}><button type="button" className={styles.icon} onClick={()=>setSection('page')} aria-label={t("copy.components_chat_BrowserWorkspacePanel.023")}>←</button><h3>{({tabs:t("copy.components_chat_BrowserWorkspacePanel.024"),extensions:t("copy.components_chat_BrowserWorkspacePanel.025"),history:t("copy.components_chat_BrowserWorkspacePanel.026"),network:t("copy.components_chat_BrowserWorkspacePanel.027"),settings:t("copy.components_chat_BrowserWorkspacePanel.028")} as Record<string,string>)[section]}</h3></div>}
    {section==='tabs'&&<div className={styles.tabs} aria-label={t("copy.components_chat_BrowserWorkspacePanel.029")}>
      {(surface.tabs||trace.frame?.tabs||[]).map(tab=><div key={tab.id} className={styles.tab} data-selected={tab.selected}>
        <button className="min-w-0 flex-1 truncate px-3 py-2 text-left" title={tab.url} disabled={locked} aria-pressed={tab.selected} onClick={()=>{manual('select_tab',{tab_id:tab.id});setSection('page');}}>{shortUrl(tab.url)}</button>
        <button className="px-2 py-1" disabled={locked} aria-label={`${t("copy.components_chat_BrowserWorkspacePanel.030")} ${tab.id}`} onClick={()=>manual('close_tab',{tab_id:tab.id})}><NeryaGlyph name="x" size={14} /></button>
      </div>)}
      <button className={styles.icon} disabled={locked || !surface.running} aria-label={t("copy.components_chat_BrowserWorkspacePanel.031")} onClick={()=>manual('new_tab')}><NeryaGlyph name="plus" size={18} /></button>
    </div>}
    {section==='page'&&<form className={styles.address} onSubmit={e=>{e.preventDefault();navigateAddress();omnibox.current?.blur();}}>
      {(['back','forward','reload'] as const).map((command,i)=><button key={command} type="button" className={styles.icon} disabled={locked || !surface.running} aria-label={[t("copy.components_chat_BrowserWorkspacePanel.032"),t("copy.components_chat_BrowserWorkspacePanel.033"),t("copy.components_chat_BrowserWorkspacePanel.034")][i]} onClick={()=>manual(command)}><BrowserGlyph name={command}/></button>)}
      <div className={styles.omnibox}><GlobeIcon size={15}/><input ref={omnibox} aria-label={t('copy.components_chat_BrowserWorkspacePanel.035')} value={address} onChange={e=>setAddress(e.target.value)} onFocus={e=>e.currentTarget.select()} disabled={locked} placeholder={nb('search')} spellCheck={false} autoComplete="off" autoCapitalize="none"/><button type="submit" className={styles.icon} disabled={locked||!address.trim()} aria-label={nb('go')}><BrowserGlyph name="forward"/></button></div>
      <button type="button" className={styles.icon} title={nb('extensions')} aria-label={nb('extensions')} onClick={()=>void showSection('extensions')}><BrowserGlyph name="extensions"/></button>

    </form>}
    {section==='page'&&viewportMode==='custom'&&<form className={styles.sizeBar} onSubmit={e=>{e.preventDefault();applyViewport();}}>
      <label>{nb('sizeWidth')}<input type="number" min={240} max={3840} step={1} aria-label={nb('sizeWidth')} value={sizeDraft.width} onChange={e=>setSizeDraft(s=>({...s,width:e.target.value}))}/></label>
      <span aria-hidden="true">×</span>
      <label>{nb('sizeHeight')}<input type="number" min={180} max={3840} step={1} aria-label={nb('sizeHeight')} value={sizeDraft.height} onChange={e=>setSizeDraft(s=>({...s,height:e.target.value}))}/></label>
      <button className="btn btn-ghost text-xs" type="submit" disabled={busy||!!historyFrame}>{nb('sizeApply')}</button>
      <button className="btn btn-ghost text-xs" type="button" disabled={busy||!!historyFrame} onClick={()=>{
        const next={width:customViewport.height,height:customViewport.width};
        if(validBrowserViewport(next)){setCustomViewport(next);setSizeDraft({width:String(next.width),height:String(next.height)});}
      }}>{nb('sizeRotate')}</button>
    </form>}
    {error && <div role="alert" className="mx-3 mt-2 rounded border border-danger/30 px-3 py-2 text-xs text-danger">{error}</div>}
    {['waiting','handoff_required'].includes(surface.challenge?.state||'')&&<p role="status" className={styles.challengeNotice}>{surface.challenge?.state==='waiting'?t("copy.components_chat_BrowserWorkspacePanel.037"):t("copy.components_chat_BrowserWorkspacePanel.038")}</p>}
    <div className={styles.body} data-page={section==='page'}>
      {section==='network'&&<BrowserNetworkPanel key={profile} profile={profile} active={active}/>}
      {section==='page' && <>
        <div ref={stageRef} className={styles.viewportStage} data-testid="browser-viewport-stage" data-mode={viewportMode}>
        <div className={styles.viewport} style={frameStyle} data-testid="browser-viewport" aria-busy={resizing} onClick={e=>{
          if(locked || !frame || blank || surface.sensitive || !imageRef.current?.complete || !imageRef.current.naturalWidth)return;
          const point=browserViewportPoint(e.clientX,e.clientY,e.currentTarget.getBoundingClientRect(),sourceViewport);
          if(point){manual('click',point);keyboard.current?.focus({preventScroll:true});}
        }} ref={viewportRef}>
          {blank&&!connectionError?<div className={styles.newTabPage} data-testid="browser-new-tab"><GlobeIcon size={34}/><h2>Nerya</h2><p>{nb('ready')}</p><form className={styles.newTabSearch} onSubmit={e=>{e.preventDefault();navigateAddress();}}><input aria-label={nb('search')} placeholder={nb('search')} value={address} onChange={e=>setAddress(e.target.value)} disabled={locked} autoComplete="off"/><button type="submit" className={styles.icon} disabled={locked||!address.trim()} aria-label={nb('go')}><BrowserGlyph name="forward"/></button></form><div className={styles.quickLinks}><button type="button" disabled={busy} onClick={()=>void native('web_store')}>{nb('store')}</button><button type="button" disabled={busy} onClick={()=>void showSection('extensions')}>{nb('extensions')}</button></div></div>:frame && !connectionError && !(traceError&&!human&&!surface.image) && !surface.sensitive ? <img ref={imageRef} src={frame} alt={t("copy.components_chat_BrowserWorkspacePanel.039")} draggable={false} onLoad={e=>{const image=e.currentTarget;if(image.naturalWidth&&image.naturalHeight)setImageSize(previous=>previous.width===image.naturalWidth&&previous.height===image.naturalHeight?previous:{width:image.naturalWidth,height:image.naturalHeight});}}/> : <div className={styles.empty}>
            <GlobeIcon size={28}/>{surface.sensitive&&surface.tabs?.some(tab=>tab.protected)&&<button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>manual('close_tab',{tab_id:surface.tabs?.find(tab=>tab.protected)?.id})}>{nb('closeProtected')}</button>}<p>{surface.sensitive?nb('protected'):connectionError||traceError?t("copy.components_chat_BrowserWorkspacePanel.041"):trace.frame_state==='expired'?t("copy.components_chat_BrowserWorkspacePanel.042"):t("copy.components_chat_BrowserWorkspacePanel.043")}</p>
          </div>}
          {showVisual && visual && <svg className={styles.visual} viewBox={`0 0 ${sourceViewport.width} ${sourceViewport.height}`} data-dom={visual.action==='dom'} data-testid="browser-action-overlay" aria-label={actionName(visual.action||'')}>
            {(visual.boxes||[]).map((box,i)=><rect key={i} {...box} rx={4}/>)}
            {visual.cursor && <g className={styles.cursor} transform={`translate(${visual.cursor.x} ${visual.cursor.y})`}><path d="M0 0 L0 26 L7 19 L13 31 L18 28 L12 17 L22 17 Z"/></g>}
          </svg>}
          {!human && surface.running && !blank && !surface.sensitive && <div className={styles.takeoverHint} role="status">{nb('takeover')}</div>}
        </div>
        <span className={styles.viewportStatus} role="status" data-testid="browser-viewport-size">{resizing?nb('resizing'):`${frameSize.width} × ${frameSize.height}`}</span>
        </div>
        <textarea ref={keyboard} className="sr-only" aria-label={t("copy.components_chat_BrowserWorkspacePanel.045")} disabled={locked||!!surface.sensitive} autoComplete="off" autoCorrect="off" spellCheck={false} onChange={e=>{if(!(e.nativeEvent as InputEvent).isComposing&&e.target.value){manual('type',{text:e.target.value});e.target.value='';}}} onCompositionEnd={e=>{manual('type',{text:e.currentTarget.value});e.currentTarget.value='';}}
          onKeyDown={e=>{if(e.nativeEvent.isComposing)return;const modifier=e.ctrlKey||e.metaKey;
            if(modifier&&['a','z','y'].includes(e.key.toLowerCase())&&(!e.shiftKey||e.key.toLowerCase()==='z')){e.preventDefault();manual('press',{key:`ControlOrMeta+${e.shiftKey?'Shift+':''}${e.key.toLowerCase()}`});}
            else if(!modifier&&['Enter','Tab','Escape','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(e.key)){e.preventDefault();manual('press',{key:`${e.shiftKey?'Shift+':''}${e.key}`});}}}/>
        {calls.length>0&&<details className={styles.steps} open={timelineOpen} onToggle={e=>setTimelineOpen(e.currentTarget.open)} data-testid="browser-operation-details">
          <summary className={styles.activitySummary}><span>{showVisual?actionName(visual?.action||''):t("copy.components_chat_BrowserWorkspacePanel.046")}</span><span>{steps.filter(e=>e.phase==='completed').length}/{steps.length} <NeryaGlyph name="chevronDown" size={14} /></span></summary>
          <div className="pt-3">
          {calls.length>0 && <div className="mb-3 flex items-center gap-2"><select className={styles.callSelect} aria-label={t("copy.components_chat_BrowserWorkspacePanel.047")} value={callId} onChange={e=>{setChosen(e.target.value);setHistoryFrame(null);}}>{calls.map((c,i)=><option key={c.id} value={c.id}>{i+1}. {actionName(c.operation)}</option>)}</select><button className="text-xs text-[color:var(--text-muted)]" onClick={()=>{setChosen('');setHistoryFrame(null);setTrace(s=>({...s,frame:null}));}}>{t("copy.components_chat_BrowserWorkspacePanel.048")}</button></div>}
          {historyFrame && <button className="mb-2 text-xs text-brand-300" onClick={()=>{setHistoryFrame(null);setTrace(s=>({...s,frame:null}));}}>{t("copy.components_chat_BrowserWorkspacePanel.049")}</button>}
          <ol aria-label={t("copy.components_chat_BrowserWorkspacePanel.050")}>{steps.map(e=><li className={styles.step} key={e.index} data-browser-step={e.index}><span className={e.phase==='failed'?'text-danger':e.phase==='completed'?'text-ok':'text-[color:var(--text-muted)]'}><NeryaGlyph name={e.phase==='completed'?'check':e.phase==='failed'?'warning':e.phase==='skipped'?'x':'circle'} size={14} /></span><span className="min-w-0 flex-1 break-words">{actionName(e.action||'')} {e.target}<span className="ml-2 text-[color:var(--text-muted)]">{e.phase==='started'?t("copy.components_chat_BrowserWorkspacePanel.051"):e.phase==='skipped'?t("copy.components_chat_BrowserWorkspacePanel.052"):e.phase==='failed'?t("copy.components_chat_BrowserWorkspacePanel.053"):t("copy.components_chat_BrowserWorkspacePanel.054")}</span></span>{!!e.frame_id&&<button onClick={()=>{setHistoryFrame(e.frame_id!);setTrace(s=>({...s,frame:null}));}}>{t("copy.components_chat_BrowserWorkspacePanel.055")}</button>}</li>)}</ol>
          </div>
        </details>}
      </>}
      {section==='tabs'&&<p className={`${styles.content} ${styles.muted}`}>{human?t("copy.components_chat_BrowserWorkspacePanel.056"):nb('takeover')}</p>}
      {section==='history' && <div className={styles.content}><div className="flex gap-2"><input className="input min-w-0 flex-1" aria-label={t("copy.components_chat_BrowserWorkspacePanel.058")} value={query} onChange={e=>setQuery(e.target.value)} placeholder={t("copy.components_chat_BrowserWorkspacePanel.059")}/><button className="btn btn-ghost" disabled={busy} onClick={async()=>{if(await confirm({message:t("copy.components_chat_BrowserWorkspacePanel.060")}))await run({operation:'history_clear'});}}>{t("copy.components_chat_BrowserWorkspacePanel.061")}</button></div><div className={styles.rows}>{history.slice().reverse().filter(r=>r.url.toLowerCase().includes(query.toLowerCase())).map(r=><button key={r.id} className={`${styles.row} text-left`} disabled={locked} onClick={()=>{manual('navigate',{url:r.url});setSection('page');}}><span className="block break-all">{shortUrl(r.url)}</span><time className={styles.muted}>{new Date(r.at*1000).toLocaleString()}</time></button>)}</div>{!history.length&&<p className={styles.muted}>{t("copy.components_chat_BrowserWorkspacePanel.062")}</p>}<p className={styles.muted}>{t("copy.components_chat_BrowserWorkspacePanel.063")}</p></div>}
      {section==='extensions' && <div className={styles.content}>
        <div className={styles.nativeActions}><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void native('web_store')}>{nb('store')}</button></div>
        <p className={styles.description}>{nb('extensionHint')}</p>
        {engine==='chromium'&&<>
        {(surface.config?.extensions||[]).map((extension,i)=><div key={extension.path} className={styles.row}><div className="flex items-center justify-between gap-3"><span className="min-w-0 truncate font-medium">{extension.name} <small>{extension.version}</small></span><button className="btn btn-ghost" disabled={locked||!extension.extension_id||extension.enabled===false} onClick={()=>{manual('extension_open',{extension_id:extension.extension_id});setSection('page');}}>{t("copy.components_chat_BrowserWorkspacePanel.064")}</button></div><div className="mt-2 flex flex-wrap items-center gap-4"><span className={styles.muted}>{extension.enabled!==false?t("copy.components_chat_BrowserWorkspacePanel.065"):t("copy.components_chat_BrowserWorkspacePanel.066")}</span><button className="text-[color:var(--text-muted)]" disabled={busy} onClick={()=>void applyExtensions((surface.config?.extensions||[]).map((v,j)=>i===j?{...v,enabled:extension.enabled===false}:v))}>{extension.enabled!==false?t("copy.components_chat_BrowserWorkspacePanel.067"):t("copy.components_chat_BrowserWorkspacePanel.068")}</button><button className="text-[color:var(--text-muted)]" disabled={busy} onClick={()=>void applyExtensions((surface.config?.extensions||[]).filter((_,j)=>i!==j))}>{t("copy.components_chat_BrowserWorkspacePanel.069")}</button><span className={styles.muted}>{extension.control_ui?t("copy.components_chat_BrowserWorkspacePanel.070"):t("copy.components_chat_BrowserWorkspacePanel.071")}</span></div></div>)}
        <form className="mt-4 space-y-3" onSubmit={e=>{e.preventDefault();void run({operation:'review_extension',path:extensionPath});}}><label className="block">{t("copy.components_chat_BrowserWorkspacePanel.072")}<input className="input mt-2 w-full" aria-label={t("copy.components_chat_BrowserWorkspacePanel.073")} value={extensionPath} onChange={e=>{setExtensionPath(e.target.value);setReview(null);}} placeholder="/path/to/unpacked-extension"/></label><button className="btn btn-ghost" disabled={busy||!extensionPath}>{t("copy.components_chat_BrowserWorkspacePanel.074")}</button></form>
        {review&&<div className="mt-3 rounded border border-[color:var(--line)] p-3"><p className="font-medium">{review.name} · {review.version}</p><p className={`${styles.muted} break-all`}>{review.permissions.join(', ')||t("copy.components_chat_BrowserWorkspacePanel.075")}</p><label className="mt-3 block"><input type="checkbox" checked={review.control_ui} disabled={!review.extension_id} onChange={e=>setReview({...review,control_ui:e.target.checked})}/> {t("copy.components_chat_BrowserWorkspacePanel.076")}</label><button className="btn btn-primary mt-3" disabled={busy} onClick={()=>void applyExtensions([...(surface.config?.extensions||[]).filter(e=>e.path!==review.path),review])}>{t("copy.components_chat_BrowserWorkspacePanel.077")}</button></div>}
        </>}
        <p className={`${styles.muted} mt-4`}>{nb('nativeHint')}</p>
      </div>}
      {section==='settings'&&<div className={styles.content}><label className={styles.engineRow}><span>{nb('engine')}</span><select value={engine} disabled={busy} onChange={e=>void switchEngine(e.target.value as 'chromium'|'chrome')} aria-label={nb('engine')}><option value="chromium">{nb('chromium')}</option><option value="chrome">{nb('chrome')}</option></select></label><p className={styles.description}>{nb('profileHint')}</p><p className={styles.description}>{nb('passkeyHint')}</p><label className="flex items-center justify-between gap-4"><span>{t("copy.components_chat_BrowserWorkspacePanel.080")}</span><input type="checkbox" role="switch" checked={surface.preferences?.automatic??true} disabled={busy} onChange={e=>void changeAutomatic(e.target.checked)}/></label><p className={`${styles.muted} mt-3`}>{t("copy.components_chat_BrowserWorkspacePanel.081")}</p></div>}
    </div>
    <BrowserOperatorDialog active={active&&human} profile={profile} controlId={surface.control_id} label={nb}/>
  </section>;
}
