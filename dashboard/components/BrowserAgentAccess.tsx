"use client";
import { copy as i18nCopy } from "../lib/i18n";

import { useState } from "react";
import { useLocale } from "next-intl";
import { Card, Pill } from "./Page";
import { confirm } from "../lib/dialogs";
import type { DesktopBrowserResponse } from "../lib/browserDesktopTypes";

export function BrowserAgentAccess({ state, busy, onAction }: {
  state: DesktopBrowserResponse;
  busy: boolean;
  onAction: (body: Record<string, unknown>) => Promise<DesktopBrowserResponse | undefined>;
}) {
  const zh = useLocale().startsWith("zh");
  const text = (key: string, values?: Record<string, unknown>) => i18nCopy(zh, key, values);
  const [sites, setSites] = useState("");
  const [vision, setVision] = useState(false);
  const [downloads, setDownloads] = useState(false);
  const [error, setError] = useState("");
  const [readingFile, setReadingFile] = useState(false);
  const access = state.agent_access;
  const disabled = busy || !state.running || readingFile;

  async function grant() {
    setError("");
    const origins = sites.split(/[\s,]+/).filter(Boolean);
    if (!origins.length) { setError(text("copy.components_BrowserAgentAccess.001")); return; }
    if (!await confirm({ title: text("copy.components_BrowserAgentAccess.002"),
      message: <div className="space-y-3"><p>{text("copy.components_BrowserAgentAccess.003")}</p><p className="break-all">{origins.join(" · ")}</p>{vision && <p>{text("copy.components_BrowserAgentAccess.004")}</p>}</div>, tone: "warning" })) return;
    await onAction({ operation: "agent_grant", origins, ttl_s: 3600, screenshots: vision, downloads });
  }

  async function stageFile(file?: File) {
    if (!file || disabled) return;
    setError("");
    if (file.size > 10 * 1024 * 1024) { setError(text("copy.components_BrowserAgentAccess.005")); return; }
    if (!await confirm({ message: text("copy.components_BrowserAgentAccess.006", { value0: file.name }) })) return;
    setReadingFile(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
        reader.onerror = () => reject(new Error("file_read_failed"));
        reader.readAsDataURL(file);
      });
      await onAction({ operation: "agent_upload", name: file.name, data });
      await onAction({ operation: "status" });
    } catch {
      setError(text("copy.components_BrowserAgentAccess.007"));
    } finally { setReadingFile(false); }
  }

  return <Card title={text("copy.components_BrowserAgentAccess.008")}
    description={text("copy.components_BrowserAgentAccess.009")}
    actions={<Pill tone={access?.enabled ? "ok" : "neutral"}>{access?.occupied ? text("copy.components_BrowserAgentAccess.010") : access?.enabled ? text("copy.components_BrowserAgentAccess.011") : text("copy.components_BrowserAgentAccess.012")}</Pill>}>
    <div className="space-y-3">
      <label className="block text-xs text-ink-400">{text("copy.components_BrowserAgentAccess.013")}
        <textarea className="input mt-1 w-full" rows={3} value={sites} onChange={(e) => setSites(e.target.value)} placeholder="https://example.com" />
      </label>
      <div className="flex flex-wrap gap-4 text-xs">
        <label className="flex items-center gap-2"><input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} />{text("copy.components_BrowserAgentAccess.014")}</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={downloads} onChange={(e) => setDownloads(e.target.checked)} />{text("copy.components_BrowserAgentAccess.015")}</label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => void grant()}>{text("copy.components_BrowserAgentAccess.016")}</button>
        <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => void onAction({ operation: "agent_revoke" })}>{text("copy.components_BrowserAgentAccess.017")}</button>
      </div>
      {access?.origins?.length ? <p className="break-words text-xs text-ink-400">{access.origins.join(" · ")}</p> : null}
      <label className="block text-xs text-ink-400">{text("copy.components_BrowserAgentAccess.018")}
        <input type="file" className="mt-2 block max-w-full" disabled={disabled || !access?.enabled} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; void stageFile(file); }} />
      </label>
      {access?.uploads?.map((file) => <p className="text-xs" key={file.id}>{file.name} <code>{file.id}</code></p>)}
      {access?.last_actions?.length ? <p role="status" className="text-xs text-ink-400">{text("copy.components_BrowserAgentAccess.019")}{access.last_actions.map((e) => e.action || e.kind).join(" → ")}</p> : null}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  </Card>;
}
