"use client";
import { Icon as NeryaGlyph } from "../icons";
import { copy as i18nCopy } from "../../lib/i18n";

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import { clientApi } from '../../lib/clientApi';
import { mergeBrowserEvents, type BrowserCall, type BrowserTrace, type BrowserTraceEvent } from '../../lib/browserTrace';
import { confirm } from '../../lib/dialogs';

const actionNames: Record<string, string> = { open: "copy.browserTraceActions.001", navigate: "copy.browserTraceActions.002", batch: "copy.browserTraceActions.003", click: "copy.browserTraceActions.004", click_xy: "copy.browserTraceActions.005", fill: "copy.browserTraceActions.006", type: "copy.browserTraceActions.007", select: "copy.browserTraceActions.008", check: "copy.browserTraceActions.009", press: "copy.browserTraceActions.010", hover: "copy.browserTraceActions.011", drag: "copy.browserTraceActions.012", scroll: "copy.browserTraceActions.013", wait_for: "copy.browserTraceActions.014", snapshot: "copy.browserTraceActions.015", screenshot: "copy.browserTraceActions.016", new_tab: "copy.browserTraceActions.017", select_tab: "copy.browserTraceActions.018", close_tab: "copy.browserTraceActions.019", close: "copy.browserTraceActions.020", handoff: "copy.browserTraceActions.021", upload: "copy.browserTraceActions.022", save_download: "copy.browserTraceActions.023", downloads: "copy.browserTraceActions.024", back: "copy.browserTraceActions.025", forward: "copy.browserTraceActions.026", reload: "copy.browserTraceActions.027", extension_open: "copy.browserTraceActions.028" };
const empty: BrowserTrace = { ok: true, status: 'pending', events: [], cursor: 0, frame: null };

export function BrowserConversationTrace({ conversationId, calls, live }: {
  conversationId: string; calls: BrowserCall[]; live: boolean;
}) {
  const zh = useLocale().startsWith('zh');
  const text = (key: string, values?: Record<string, unknown>) => i18nCopy(zh, key, values);
  const name = (op: string) => actionNames[op] ? text(actionNames[op]) : op;
  const [chosen, setChosen] = useState<string | null>(null);
  const selected = calls.find(c => c.id === chosen) || calls[calls.length - 1];
  const [state, setState] = useState<BrowserTrace>(empty);
  const [historyFrame, setHistoryFrame] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(true);
  const [retry, setRetry] = useState(0);
  const epoch = useRef(0);
  const container = useRef<HTMLElement>(null);
  const callId = selected?.id || '';

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '300px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => { setHistoryFrame(null); setState(empty); setError(''); }, [callId, conversationId]);

  useEffect(() => {
    if (!callId || !conversationId || !visible) return;
    let active = true, cursor = 0, pendingReads = 0;
    let timer: ReturnType<typeof setTimeout>;
    let request: AbortController | undefined;
    const version = ++epoch.current;
    const poll = async () => {
      if (!active) return;
      if (document.hidden) { timer = setTimeout(poll, 1000); return; }
      request = new AbortController();
      const deadline = setTimeout(() => request?.abort(), 8000);
      let delay = 220;
      try {
        const result = await clientApi.browserTrace({ operation: 'trace', conversation_id: conversationId, call_id: callId,
          after: cursor, ...(historyFrame ? { frame_id: historyFrame } : {}) }, request.signal);
        if (!active || epoch.current !== version) return;
        if (!result.ok) throw new Error(result.error || 'browser_trace_failed');
        cursor = result.cursor;
        setState(old => ({ ...result, events: mergeBrowserEvents(old.events, result.events) }));
        setError('');
        if (result.status === 'pending') pendingReads++;
        // Older servers/historical calls do not have a trace. Never poll forever.
        if (pendingReads > (live ? 150 : 4)) { setError(text("copy.components_chat_BrowserConversationTrace.001")); return; }
        if (!['pending', 'queued', 'running'].includes(result.status)) delay = result.controllable ? 1500 : 5000;
        if (result.frame_state === 'expired' && !result.controllable) return;
      } catch (err) {
        if (!active || epoch.current !== version) return;
        setState(old => ({ ...old, frame: null }));
        setError(text("copy.components_chat_BrowserConversationTrace.002"));
        delay = 1500;
      } finally { clearTimeout(deadline); }
      if (active) timer = setTimeout(poll, delay);
    };
    void poll();
    const hidden = () => { if (document.hidden) { request?.abort(); setState(old => ({ ...old, frame: null })); } };
    document.addEventListener('visibilitychange', hidden);
    return () => { active = false; clearTimeout(timer); request?.abort(); document.removeEventListener('visibilitychange', hidden); };
  }, [callId, conversationId, visible, historyFrame, retry, live, zh]);

  const steps = useMemo(() => {
    const rows = new Map<number, BrowserTraceEvent>();
    for (const event of state.events) if (event.kind === 'step' && typeof event.index === 'number') rows.set(event.index, event);
    return [...rows.values()].sort((a, b) => (a.index || 0) - (b.index || 0));
  }, [state.events]);
  const current = steps.find(s => s.phase === 'started');
  const finished = steps.filter(s => s.phase === 'completed').length;
  const running = !error && ['queued', 'running', 'pending'].includes(state.status) && !state.paused;
  const status = error ? text("copy.components_chat_BrowserConversationTrace.003") : state.paused ? text("copy.components_chat_BrowserConversationTrace.004")
    : state.status === 'failed' ? text("copy.components_chat_BrowserConversationTrace.005") : running ? text("copy.components_chat_BrowserConversationTrace.006")
    : state.status === 'interrupted' ? text("copy.components_chat_BrowserConversationTrace.007") : text("copy.components_chat_BrowserConversationTrace.008");

  async function control() {
    if (!state.controllable || busy) return;
    if (state.paused && !await confirm({ message: text("copy.components_chat_BrowserConversationTrace.009") })) return;
    const controlVersion = ++epoch.current;
    setBusy(true);
    setState(old => ({ ...old, frame: null }));
    try {
      const result = await clientApi.browserTrace({ operation: 'trace_control', conversation_id: conversationId, call_id: callId,
        control: state.paused ? 'resume' : 'handoff' });
      if (controlVersion !== epoch.current) return;
      if (!result.ok) throw new Error(result.error || 'control_failed');
      setState(result); setHistoryFrame(null);
    } catch { if (controlVersion === epoch.current) setError(text("copy.components_chat_BrowserConversationTrace.010")); }
    finally { setBusy(false); setRetry(v => v + 1); }
  }

  if (!selected) return null;
  return <section ref={container} data-testid="chat-browser-trace" aria-label={text("copy.components_chat_BrowserConversationTrace.011")}
    className="mb-5 max-h-screen overflow-auto rounded-xl border border-[color:var(--line)] bg-[color:var(--card)] text-[color:var(--text-base)]">
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--line)] px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-semibold"><span aria-hidden>▣</span>{text("copy.components_chat_BrowserConversationTrace.012")}
        <span role="status" className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${running ? 'bg-ok/10 text-ok' : 'bg-ink-500/10 text-[color:var(--text-muted)]'}`}>{status}</span>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="btn btn-ghost text-xs" disabled={!state.controllable || busy} onClick={() => void control()}>
          {busy ? text("copy.components_chat_BrowserConversationTrace.013") : state.paused ? text("copy.components_chat_BrowserConversationTrace.014") : text("copy.components_chat_BrowserConversationTrace.015")}
        </button>
        <button type="button" className="btn btn-ghost text-xs" onClick={() => void container.current?.requestFullscreen().catch(() => setError(text("copy.components_chat_BrowserConversationTrace.016")))}>{text("copy.components_chat_BrowserConversationTrace.017")}</button>
      </div>
    </header>
    {calls.length > 1 && <nav aria-label={text("copy.components_chat_BrowserConversationTrace.018")} className="flex gap-1 overflow-x-auto border-b border-[color:var(--line)] px-3 py-2">
      {calls.map((call, i) => <button type="button" key={call.id} aria-pressed={call.id === callId} onClick={() => { setChosen(call.id); setHistoryFrame(null); }}
        className={`shrink-0 rounded-md px-3 py-1.5 text-xs ${call.id === callId ? 'bg-brand-500/10 text-brand-300' : 'text-[color:var(--text-muted)]'}`}>{i + 1}. {name(call.operation)}</button>)}
      <button type="button" onClick={() => { setChosen(null); setHistoryFrame(null); }} className="shrink-0 px-3 text-xs text-[color:var(--text-muted)]">{text("copy.components_chat_BrowserConversationTrace.019")}</button>
    </nav>}
    <div className="flex min-h-8 items-center gap-2 border-b border-[color:var(--line)] px-4 py-2 text-[11px] text-[color:var(--text-muted)]">
      <NeryaGlyph name="arrowUpRight" size={16} /><span className="min-w-0 truncate" title={state.frame?.url}>{state.frame?.url || text("copy.components_chat_BrowserConversationTrace.020")}</span>
      {historyFrame && <button className="ml-auto shrink-0 text-brand-300" onClick={() => setHistoryFrame(null)}>{text("copy.components_chat_BrowserConversationTrace.021")}</button>}
    </div>
    {!!state.frame?.tabs?.length && <div className="flex gap-3 overflow-x-auto px-4 py-1 text-[10px] text-[color:var(--text-muted)]" aria-label={text("copy.components_chat_BrowserConversationTrace.022")}>
      {state.frame.tabs.map(tab => <span key={tab.id} className={`max-w-48 shrink-0 truncate ${tab.selected ? 'font-semibold text-[color:var(--text-base)]' : ''}`}>{tab.selected ? '● ' : ''}{tab.url || 'about:blank'}</span>)}
    </div>}
    <div className="flex aspect-[8/5] max-h-[65vh] w-full items-center justify-center overflow-hidden bg-ink-950/5">
      {state.frame?.image && !state.paused && !error ? <>
        {/* Operator pixels stay local to this component, never the transcript/cache. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={state.frame.image} alt={text("copy.components_chat_BrowserConversationTrace.023")} className="h-full w-full object-contain" />
      </> : <p className="max-w-md px-6 text-center text-sm text-[color:var(--text-muted)]">
        {state.paused ? text("copy.components_chat_BrowserConversationTrace.024")
          : error || (state.frame_state === 'expired' || (!running && !state.frame) ? text("copy.components_chat_BrowserConversationTrace.025")
          : text("copy.components_chat_BrowserConversationTrace.026"))}
      </p>}
    </div>
    <div className="border-t border-[color:var(--line)] px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2 text-xs"><span className="font-semibold">{current ? `${name(current.action || '')} ${current.target || ''}` : text("copy.components_chat_BrowserConversationTrace.027")}</span><span className="shrink-0 tabular-nums text-[color:var(--text-muted)]">{finished}/{steps.length} {text("copy.components_chat_BrowserConversationTrace.028")}</span></div>
      <ol className="max-h-64 space-y-0.5 overflow-y-auto" aria-label={text("copy.components_chat_BrowserConversationTrace.029")}>
        {steps.map(step => <li key={step.index} data-browser-step={step.index} className="flex items-start gap-2 rounded px-1 py-1.5 text-xs">
          <span className={`w-4 shrink-0 ${step.phase === 'failed' ? 'text-danger' : step.phase === 'completed' ? 'text-ok' : 'text-[color:var(--text-muted)]'}`} aria-hidden><NeryaGlyph name={step.phase === 'completed' ? 'check' : step.phase === 'failed' ? 'warning' : step.phase === 'skipped' ? 'x' : 'circle'} size={14} /></span>
          <span className="min-w-0 flex-1 break-words"><span className="font-medium">{(step.index || 0) + 1}. {name(step.action || '')}</span>{step.target ? ` · ${step.target}` : ''}
            <span className="ml-2 text-[10px] text-[color:var(--text-muted)]">{step.phase === 'started' ? text("copy.components_chat_BrowserConversationTrace.030") : step.phase === 'failed' ? text("copy.components_chat_BrowserConversationTrace.031") : step.phase === 'skipped' ? text("copy.components_chat_BrowserConversationTrace.032") : text("copy.components_chat_BrowserConversationTrace.033")}</span>
            {step.error && <span className="block text-danger">{step.error}</span>}
          </span>
          {!!step.frame_id && <button type="button" className="shrink-0 text-[10px] text-brand-300" onClick={() => setHistoryFrame(step.frame_id!)}>{text("copy.components_chat_BrowserConversationTrace.034")}</button>}
        </li>)}
      </ol>
      {state.events.filter(e => ['request_failed', 'replayed'].includes(e.kind)).map(e => <p key={e.seq} className="mt-2 break-words text-xs text-[color:var(--text-muted)]">{e.kind === 'replayed' ? text("copy.components_chat_BrowserConversationTrace.035") : e.error}</p>)}
      <p className="mt-3 text-[10px] leading-relaxed text-[color:var(--text-muted)]">{text("copy.components_chat_BrowserConversationTrace.036")}</p>
      {state.storage_error && <p role="alert" className="mt-1 text-xs text-warn">{text("copy.components_chat_BrowserConversationTrace.037")}</p>}
    </div>
  </section>;
}
