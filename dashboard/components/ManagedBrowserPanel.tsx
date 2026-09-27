"use client";
import { copy as i18nCopy } from "../lib/i18n";

import { useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { Card, Pill } from "./Page";
import { BrowserAgentAccess } from "./BrowserAgentAccess";
import { clientApi } from "../lib/clientApi";
import { confirm, toast } from "../lib/dialogs";
import type { DesktopBrowserResponse, DesktopExtension } from "../lib/browserDesktopTypes";

export function ManagedBrowserPanel() {
  const zh = useLocale().startsWith("zh");
  const text = (key: string, values?: Record<string, unknown>) => i18nCopy(zh, key, values);
  const [profile, setProfile] = useState("work");
  const [draftProfile, setDraftProfile] = useState("work");
  const [url, setUrl] = useState("https://example.com");
  const [state, setState] = useState<DesktopBrowserResponse>({ ok: true, running: false, tabs: [] });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const inflight = useRef(false);
  const [error, setError] = useState("");
  const [image, setImage] = useState("");
  const [input, setInput] = useState("");
  const [packagePath, setPackagePath] = useState("");
  const [review, setReview] = useState<DesktopExtension | null>(null);
  const [allowUi, setAllowUi] = useState(false);
  const [livePreview, setLivePreview] = useState(true);
  const epoch = useRef(0);
  const pollInFlight = useRef(false);
  const locked = busy || loading;
  const interactive = !!state.running && !state.paused && !state.agent_access?.occupied && !locked;

  useEffect(() => {
    if (!state.running) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!active) return;
      if (!document.hidden && !inflight.current && !pollInFlight.current) {
        pollInFlight.current = true;
        const version = epoch.current;
        try {
          const result = await clientApi.browserDesktop({ profile_id: profile, operation: livePreview ? "preview" : "status" });
          if (active && version === epoch.current && !result.ok) setImage("");
          if (active && version === epoch.current && result.ok) {
            const { image: nextImage, ...metadata } = result;
            setState((old) => ({ ...old, ...metadata }));
            if (result.paused || !result.running) setImage("");
            else if (livePreview) setImage(nextImage || "");
          }
        } catch { if (active && version === epoch.current) setImage(""); }
        finally { pollInFlight.current = false; }
      }
      if (active) timer = setTimeout(poll, livePreview ? 900 : 2000);
    };
    timer = setTimeout(poll, 900);
    const hidden = () => { if (document.hidden) { epoch.current++; setImage(""); } };
    document.addEventListener("visibilitychange", hidden);
    return () => { active = false; clearTimeout(timer); document.removeEventListener("visibilitychange", hidden); };
  }, [profile, state.running, livePreview]);

  useEffect(() => {
    let current = true;
    setLoading(true);
    epoch.current++;
    setState({ ok: true, running: false, paused: false, tabs: [] });
    setImage("");
    setReview(null);
    setError("");
    clientApi.browserDesktopStatus(profile).then((result) => {
      if (!current) return;
      if (!result.ok) throw new Error(result.error || "browser_status_failed");
      setState(result);
    }).catch((err: unknown) => {
      if (current) setError(err instanceof Error ? err.message : "browser_status_failed");
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [profile]);

  async function run(body: Record<string, unknown>, capture = false) {
    if (inflight.current || loading) return;
    inflight.current = true;
    setBusy(true);
    epoch.current++;
    setError("");
    if (body.command === "handoff" || body.operation === "close" || body.operation === "agent_revoke") setImage("");
    try {
      let result = await clientApi.browserDesktop({ ...body, profile_id: profile });
      if (!result.ok) throw new Error([result.error, result.hint].filter(Boolean).join(" · "));
      const { image: _firstImage, ...metadata } = result;
      setState((old) => ({ ...old, ...metadata }));
      if (capture && body.command !== "screenshot" && result.running && !result.paused && result.tabs?.length) {
        result = await clientApi.browserDesktop({ profile_id: profile, operation: "command", command: "screenshot" });
        if (!result.ok) throw new Error(result.error || "browser_capture_failed");
        const { image: _nextImage, ...nextMetadata } = result;
        setState((old) => ({ ...old, ...nextMetadata }));
      }
      setImage(result.paused ? "" : result.image || "");
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "browser_request_failed";
      setError(message);
      setImage("");
      toast({ tone: "error", message });
      // Never retry a timed-out click, navigation, or extension operation.
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  const command = (name: string, payload: Record<string, unknown> = {}, capture = true) =>
    run({ operation: "command", command: name, payload }, capture);

  async function inspect() {
    setReview(null);
    setAllowUi(false);
    const result = await run({ operation: "review_extension", path: packagePath });
    if (result?.review) setReview(result.review);
  }

  async function saveExtensions(extensions: DesktopExtension[]) {
    const accepted = await confirm({
      title: text("copy.components_ManagedBrowserPanel.001"),
      message: text("copy.components_ManagedBrowserPanel.002"),
      okLabel: text("copy.components_ManagedBrowserPanel.003"),
      tone: "warning",
    });
    if (!accepted) return;
    const result = await run({ operation: "configure", extensions });
    if (result?.ok) { setReview(null); setPackagePath(""); }
  }

  return (
    <div className="space-y-4" data-testid="managed-browser-panel">
      <Card title={text("copy.components_ManagedBrowserPanel.004")}
        description={text("copy.components_ManagedBrowserPanel.005")}
        actions={<Pill tone={state.paused ? "warn" : state.running ? "ok" : "neutral"}>{state.paused ? text("copy.components_ManagedBrowserPanel.006") : state.running ? text("copy.components_ManagedBrowserPanel.007") : text("copy.components_ManagedBrowserPanel.008")}</Pill>}>
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="space-y-1 text-xs text-ink-400">
              <span className="block">{text("copy.components_ManagedBrowserPanel.009")}</span>
              <input className="input w-40" aria-label={text("copy.components_ManagedBrowserPanel.010")}
                value={draftProfile} disabled={locked || !!state.running} maxLength={48}
                onChange={(e) => setDraftProfile(e.target.value)} />
            </label>
            <button type="button" className="btn btn-ghost" disabled={locked || !!state.running || draftProfile === profile}
              onClick={() => {
                if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(draftProfile)) { setError(text("copy.components_ManagedBrowserPanel.011")); return; }
                setProfile(draftProfile);
              }}>{text("copy.components_ManagedBrowserPanel.012")}</button>
            {!state.running ? <button type="button" className="btn btn-primary" disabled={locked}
              onClick={() => void run({ operation: "open", url }, true)}>{text("copy.components_ManagedBrowserPanel.013")}</button> : <>
              <button type="button" className="btn btn-ghost" disabled={locked} onClick={() => void command("handoff", {}, false)}>{text("copy.components_ManagedBrowserPanel.014")}</button>
              <button type="button" className="btn btn-ghost" disabled={locked} onClick={() => void run({ operation: "close" })}>{text("copy.components_ManagedBrowserPanel.015")}</button>
            </>}
            <button type="button" className="btn btn-ghost" disabled={locked} onClick={() => void run({ operation: "status" })}>{text("copy.components_ManagedBrowserPanel.016")}</button>
            <label className="flex items-center gap-2 text-xs text-ink-400"><input type="checkbox" checked={livePreview} onChange={(e) => { epoch.current++; setLivePreview(e.target.checked); setImage(""); }} />{text("copy.components_ManagedBrowserPanel.017")}</label>
          </div>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (interactive) void command("navigate", { url }); }}>
            <input className="input min-w-0 flex-1" aria-label={text("copy.components_ManagedBrowserPanel.018")} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" spellCheck={false} />
            <button type="submit" className="btn btn-primary" disabled={!interactive}>{text("copy.components_ManagedBrowserPanel.019")}</button>
          </form>
          {state.running && <div className="flex flex-wrap gap-1" aria-label={text("copy.components_ManagedBrowserPanel.020")}>
            {(["back", "forward", "reload", "new_tab", "close_tab"] as const).map((name) =>
              <button key={name} type="button" className="btn btn-ghost" disabled={!interactive} onClick={() => void command(name)}>{text(`copy.components_ManagedBrowserPanel.actions.${name}`)}</button>)}
            <button type="button" className="btn btn-ghost" disabled={!interactive} onClick={() => void command("screenshot")}>{text("copy.components_ManagedBrowserPanel.021")}</button>
          </div>}
          {!!state.tabs?.length && <div className="flex gap-2 overflow-x-auto border-b border-brand-500/10 pb-2" aria-label={text("copy.components_ManagedBrowserPanel.022")}>
            {state.tabs.map((tab) => <button key={tab.id} type="button" className={`btn shrink-0 ${tab.selected ? "btn-primary" : "btn-ghost"}`} disabled={locked || (!!state.agent_access?.occupied && !state.paused)}
              aria-pressed={tab.selected} onClick={() => { if (!state.agent_access?.occupied || state.paused) void command("select_tab", { tab_id: tab.id }); }}>
              <span className="max-w-64 truncate">{tab.protected ? "🔒 " : ""}{tab.url || "about:blank"}</span>
            </button>)}
          </div>}
          {state.paused ? <div className="rounded-lg border border-warn/30 p-5 text-sm" role="status">
            <p>{text("copy.components_ManagedBrowserPanel.023")}</p>
            <button type="button" className="btn btn-ghost mt-3" disabled={locked} onClick={async () => {
              if (await confirm({ message: text("copy.components_ManagedBrowserPanel.024") })) void command("resume");
            }}>{text("copy.components_ManagedBrowserPanel.025")}</button>
          </div> : image ? <button type="button" className="block w-full overflow-hidden rounded-lg border border-brand-500/10 text-left" disabled={!interactive}
            aria-label={text("copy.components_ManagedBrowserPanel.026")}
            onClick={(e) => {
              if (e.detail === 0) { void command("press", { key: "Enter" }); return; }
              const rect = e.currentTarget.getBoundingClientRect();
              void command("click", { x: (e.clientX - rect.left) / rect.width * 1280, y: (e.clientY - rect.top) / rect.height * 800 });
            }}>
            {/* In-memory authenticated viewport: no Next image optimizer or disk cache. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image} alt={text("copy.components_ManagedBrowserPanel.027")} className="block h-auto w-full" />
          </button> : <div className="rounded-lg border border-dashed border-brand-500/20 px-5 py-10 text-center text-sm text-ink-400">
            {text("copy.components_ManagedBrowserPanel.028")}
          </div>}
          {state.running && !state.paused && <div className="flex flex-wrap gap-2">
            <input className="input min-w-0 flex-1" aria-label={text("copy.components_ManagedBrowserPanel.029")} value={input} onChange={(e) => setInput(e.target.value)} autoComplete="off" placeholder={text("copy.components_ManagedBrowserPanel.030")} />
            <button type="button" className="btn btn-ghost" disabled={!interactive || !input} onClick={() => { const value = input; setInput(""); void command("type", { text: value }); }}>{text("copy.components_ManagedBrowserPanel.031")}</button>
            {(["Enter", "Tab", "Escape"] as const).map((key) => <button key={key} type="button" className="btn btn-ghost" disabled={!interactive} onClick={() => void command("press", { key })}>{key}</button>)}
            <button type="button" className="btn btn-ghost" disabled={!interactive} onClick={() => void command("scroll", { dy: -500 })}>{text("copy.components_ManagedBrowserPanel.032")}</button>
            <button type="button" className="btn btn-ghost" disabled={!interactive} onClick={() => void command("scroll", { dy: 500 })}>{text("copy.components_ManagedBrowserPanel.033")}</button>
          </div>}
          {error && <p className="break-words text-sm text-danger" role="alert">{error}</p>}
          <p className="text-xs text-ink-400" role="status">{locked ? text("copy.components_ManagedBrowserPanel.034") : text("copy.components_ManagedBrowserPanel.035")}</p>
        </div>
      </Card>
      <BrowserAgentAccess state={state} busy={locked} onAction={run} />
      <Card title={text("copy.components_ManagedBrowserPanel.036")} description={text("copy.components_ManagedBrowserPanel.037")}>
        <div className="space-y-4 text-sm">
          <p className="text-ink-400">{text("copy.components_ManagedBrowserPanel.038")}</p>
          {(state.config?.extensions || []).map((ext) => <div key={ext.digest} className="flex flex-wrap items-center justify-between gap-2 border-b border-brand-500/10 pb-3">
            <div><p className="font-medium">{ext.name} <span className="text-ink-400">{ext.version}</span></p><p className="text-xs text-ink-400">{ext.control_ui ? text("copy.components_ManagedBrowserPanel.039") : text("copy.components_ManagedBrowserPanel.040")}</p></div>
            <div className="flex gap-2">
              <button type="button" className="btn btn-ghost" disabled={!interactive || !ext.extension_id} onClick={() => void command("extension_open", { extension_id: ext.extension_id })}>{text("copy.components_ManagedBrowserPanel.041")}</button>
              <button type="button" className="btn btn-ghost" disabled={locked || !!state.running} onClick={() => void saveExtensions((state.config?.extensions || []).filter((item) => item.digest !== ext.digest))}>{text("copy.components_ManagedBrowserPanel.042")}</button>
            </div>
          </div>)}
          <details className="rounded-lg border border-brand-500/10 p-3">
            <summary className="cursor-pointer font-medium">{text("copy.components_ManagedBrowserPanel.043")}</summary>
            <div className="mt-3 space-y-3">
              <label className="block text-xs text-ink-400">{text("copy.components_ManagedBrowserPanel.044")}
                <input className="input mt-1 w-full" value={packagePath} disabled={locked || !!state.running} onChange={(e) => { setPackagePath(e.target.value); setReview(null); }} placeholder="/absolute/path/to/unpacked-extension" />
              </label>
              <button type="button" className="btn btn-ghost" disabled={locked || !!state.running || !packagePath} onClick={() => void inspect()}>{text("copy.components_ManagedBrowserPanel.045")}</button>
              {review && <div className="space-y-2 rounded-md border border-brand-500/10 p-3">
                <p className="font-medium">{review.name} · {review.version}</p>
                <p className="break-all text-xs text-ink-400">SHA-256: {review.digest}</p>
                <p className="break-words text-xs">{review.permissions.join(" · ") || text("copy.components_ManagedBrowserPanel.046")}</p>
                <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={allowUi} disabled={!review.extension_id} onChange={(e) => setAllowUi(e.target.checked)} />{text("copy.components_ManagedBrowserPanel.047")}</label>
                <button type="button" className="btn btn-primary" disabled={locked || !!state.running} onClick={() => void saveExtensions([...(state.config?.extensions || []).filter((e) => e.digest !== review.digest), { ...review, control_ui: allowUi }])}>{text("copy.components_ManagedBrowserPanel.048")}</button>
              </div>}
            </div>
          </details>
          <div className="space-y-2 border-t border-brand-500/10 pt-3 text-xs text-ink-400">
            <p>{text("copy.components_ManagedBrowserPanel.049")}</p>
            <p>{text("copy.components_ManagedBrowserPanel.050")}</p>
            <p>{text("copy.components_ManagedBrowserPanel.051")}</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
