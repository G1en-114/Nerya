"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Advanced, ErrorBanner, Pill } from "../Page";
import { SwitchControl } from "../SwitchControl";
import { Field, Row, SettingsGroup } from "./SettingsFields";
import { confirm } from "../../lib/dialogs";
import { mcpRequest, mergeTunnelRuntime, type McpStatus } from "../../lib/mcpSettings";

export default function McpSettingsPanel() {
  const text = useTranslations("settings.mcpSettings");
  const [saved, setSaved] = useState<McpStatus | null>(null);
  const [draft, setDraft] = useState<McpStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dirty = Boolean(saved && (JSON.stringify(saved) !== JSON.stringify(draft) || apiKey || clearKey));
  const syncTunnel = useCallback((live: Partial<McpStatus["openai_tunnel"]>) => {
    setSaved(previous => previous ? mergeTunnelRuntime(previous, live) : previous);
    setDraft(previous => previous ? mergeTunnelRuntime(previous, live) : previous);
  }, []);
  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await mcpRequest<McpStatus>("/mcp-settings", undefined, signal);
    setSaved(result); setDraft(result); setApiKey(""); setClearKey(false);
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal).catch((e) => { if (!abort.signal.aborted) setError(String(e.message || e)); });
    return () => abort.abort();
  }, [load]);
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [dirty]);
  const installing = Boolean(saved?.openai_tunnel.installing);
  const connecting = Boolean(saved?.openai_tunnel.running && !saved?.openai_tunnel.ready);
  useEffect(() => {
    if (!installing && !connecting) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await mcpRequest<McpStatus>("/mcp-settings", undefined, abort.signal);
        if (abort.signal.aborted) return;
        syncTunnel(result.openai_tunnel);
        if (installing && !result.openai_tunnel.installing && result.openai_tunnel.installed && !result.openai_tunnel.install_error) {
          setNotice(text("clientInstalled"));
        }
      } catch (e) {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(poll, 2000);
      }
    };
    timer = setTimeout(poll, 1000);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [installing, connecting, syncTunnel, text]);
  async function refresh() {
    if (dirty && !(await confirm({ title: text("discard"), message: text("discardHint"), tone: "warning" }))) return;
    await run("refresh", async () => { await load(); });
  }
  useEffect(() => {
    const handler = () => void refresh();
    window.addEventListener("nerya:mcp-refresh", handler);
    return () => window.removeEventListener("nerya:mcp-refresh", handler);
  });
  async function run(name: string, action: () => Promise<void>) {
    setBusy(name); setError(""); setNotice("");
    try { await action(); } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(text.has(message) ? text(message) : message);
    }
    finally { setBusy(""); }
  }
  if (!draft || !saved) return <section aria-label="MCP"><ErrorBanner error={error} onRetry={() => void refresh()} />{!error && <p role="status">{text("loading")}</p>}</section>;
  const update = (value: Partial<McpStatus>) => setDraft({ ...draft, ...value });
  const tunnel = draft.openai_tunnel;
  const setTunnel = (value: Partial<McpStatus["openai_tunnel"]>) => update({ openai_tunnel: { ...tunnel, ...value } });
  const canEnable = saved.sdk_installed && saved.admin_password_configured;
  async function save() {
    if (!draft || !saved) return;
    await run("save", async () => {
      await mcpRequest("/mcp-settings", { revision: saved.revision, enabled: draft.enabled,
        public_url: draft.public_url,
        openai_tunnel: { enabled: draft.enabled && tunnel.enabled, tunnel_id: tunnel.tunnel_id,
          ...(apiKey ? { api_key: apiKey } : {}), clear_api_key: clearKey } });
      await load(); setNotice(text("saved"));
    });
  }
  return <section aria-label="MCP" className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{text("title")}</h2><p className="mt-1 max-w-3xl text-sm text-[color:var(--text-muted)]">{text("intro")}</p></div><Pill tone={saved.enabled ? "ok" : "neutral"}>{saved.enabled ? text("ready") : text("off")}</Pill></div>
    <ErrorBanner error={error} onRetry={() => void refresh()} />
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <fieldset disabled={Boolean(busy)} className="space-y-5 border-0 p-0">
      <SettingsGroup title={text("auth")}>
        <Row label={text("enabled")} desc={text("enabledHint")}><SwitchControl label={text("enabled")} checked={draft.enabled} disabled={!draft.enabled && !canEnable} onCheckedChange={(enabled) => update({ enabled, openai_tunnel: { ...tunnel, enabled: enabled && tunnel.enabled } })} /></Row>
        <Row label={text("password")}><Pill tone={saved.admin_password_configured ? "ok" : "warn"}>{saved.admin_password_configured ? text("configured") : text("missing")}</Pill></Row>
        {!saved.admin_password_configured && <p className="px-4 py-3 text-sm"><a href="/settings#access" className="underline">{text("passwordHint")}</a></p>}
        {!saved.sdk_installed && <p className="px-4 py-3 text-sm">{text("sdkHint")}</p>}
        <div className="space-y-3 p-4"><Field label={text("url")} hint={text("urlHint")}><input className="input-dark w-full" value={draft.public_url} onChange={e => update({ public_url: e.target.value })} placeholder={saved.detected_public_urls[0] || "https://nerya.example.com"} spellCheck={false} /></Field>
          <div><span className="text-xs text-[color:var(--text-muted)]">{text("endpoint")}</span><div className="mt-1 flex flex-wrap items-center gap-2"><code className="break-all text-sm">{saved.endpoint}</code><button type="button" className="btn btn-ghost" onClick={() => void run("copy", async () => { try { await navigator.clipboard.writeText(saved.endpoint); setNotice(text("copied")); } catch { throw new Error(text("copiedError")); } })}>{text("copy")}</button></div></div>
        </div>
      </SettingsGroup>
      <SettingsGroup title={text("tunnel")} description={text("tunnelHint")}>
        <Row label={text("tunnelEnable")} desc={text("tunnelEnableHint")}><SwitchControl label={text("tunnelEnable")} checked={tunnel.enabled} disabled={!draft.enabled} onCheckedChange={enabled => setTunnel({ enabled })} /></Row>
        <div className="grid gap-4 p-4 md:grid-cols-2">
          <Field label={text("id")}><input className="input-dark w-full font-mono" placeholder="tunnel_…" value={tunnel.tunnel_id} onChange={e => setTunnel({ tunnel_id: e.target.value })} spellCheck={false} /></Field>
          <Field label={text("key")} hint={text("keyHint")}><input className="input-dark w-full" type="password" autoComplete="new-password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={tunnel.api_key_configured ? text("keySaved") : text("keyNone")} /></Field>
          {tunnel.api_key_configured && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={clearKey} onChange={e => setClearKey(e.target.checked)} />{text("forget")}</label>}
          {clearKey && <p className="text-sm text-[color:var(--text-muted)]">{text("forgetHint")}</p>}
          <p className="text-sm text-[color:var(--text-muted)] md:col-span-2">{text("browser")}</p>
          <div className="space-y-2 text-sm md:col-span-2" aria-live="polite">
            {tunnel.installed && !tunnel.installing && !tunnel.install_error ? <Pill tone="ok">{text("clientInstalled")}</Pill> : <>
              <button type="button" className="btn btn-primary" disabled={tunnel.installing || !tunnel.install_supported} onClick={() => void run("install", async () => {
                const result = await mcpRequest<Partial<McpStatus["openai_tunnel"]>>("/mcp-settings/tunnel/install", {});
                syncTunnel(result);
                if (result.installed && !result.installing && !result.install_error) setNotice(text("clientInstalled"));
              })}>{tunnel.installing ? text("installing") : tunnel.install_error ? text("installRetry") : text("install")}</button>
              <p className="text-[color:var(--text-muted)]">{text(tunnel.install_supported ? "installHint" : "installRequiresHomebrew")}</p>
              {!tunnel.install_supported && <code className="break-all">{tunnel.install_command}</code>}
            </>}
            {tunnel.install_error && <p role="alert" className="text-danger">{text.has(tunnel.install_error) ? text(tunnel.install_error) : text("installFailed")}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2 md:col-span-2"><Pill tone={saved.openai_tunnel.ready ? "ok" : saved.openai_tunnel.running ? "warn" : "neutral"}>{saved.openai_tunnel.ready ? text("connected") : saved.openai_tunnel.running ? text("connecting") : text("stopped")}</Pill>
            <button type="button" className="btn btn-ghost" disabled={dirty || !saved.enabled || !saved.openai_tunnel.enabled || !tunnel.installed || tunnel.installing || Boolean(tunnel.install_error) || saved.openai_tunnel.running} onClick={() => void run("connect", async () => { await mcpRequest("/mcp-settings/tunnel/start", {}); await load(); })}>{text("connect")}</button>
            <button type="button" className="btn btn-ghost" disabled={dirty || !saved.openai_tunnel.running} onClick={() => void run("disconnect", async () => { await mcpRequest("/mcp-settings/tunnel/stop", { revision: saved.revision }); await load(); })}>{text("disconnect")}</button>
            <button type="button" className="btn btn-ghost" onClick={() => void refresh()}>{text("refreshTunnel")}</button>
          </div>
          {saved.openai_tunnel.error && <p role="alert" className="text-sm text-danger md:col-span-2">{saved.openai_tunnel.error}</p>}
          {tunnel.tunnel_id && <div className="md:col-span-2"><Advanced title={text("api")}><pre className="overflow-auto text-xs">{JSON.stringify({ ...tunnel.api_tool, tunnel_id: tunnel.tunnel_id }, null, 2)}</pre></Advanced></div>}
        </div>
      </SettingsGroup>
      <div className="flex flex-wrap items-center gap-3"><button type="button" className="btn btn-primary" disabled={!dirty} onClick={() => void save()}>{busy === "save" ? text("saving") : text("save")}</button>
        {dirty && <span className="text-sm text-[color:var(--text-muted)]">{text("unsaved")}</span>}
        <button type="button" className="btn btn-ghost" disabled={dirty || !saved.enabled} onClick={() => void run("revoke", async () => { if (await confirm({ title: text("revoke"), message: text("revokeHint"), tone: "warning" })) { await mcpRequest("/mcp-settings/revoke", { revision: saved.revision }); await load(); setNotice(text("revoked")); } })}>{text("revoke")}</button>
        {busy && <span role="status" className="text-sm">{text("busy")}</span>}
      </div>
    </fieldset>
  </section>;
}
