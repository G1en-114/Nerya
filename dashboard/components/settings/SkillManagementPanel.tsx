"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import * as Dialog from "@radix-ui/react-dialog";
import { clientApi } from "../../lib/clientApi";
import { Markdown } from "../chat/Markdown";
import { ErrorBanner, Pill } from "../Page";
import { SkillFileTree } from "./SkillFileTree";
import { Field } from "./SettingsFields";
import { confirm } from "../../lib/dialogs";
import { mcpRequest, type SkillCatalog, type SkillFile, type SkillRow } from "../../lib/mcpSettings";

type Scope = "all" | "builtin" | "workspace" | "agent";

export default function SkillManagementPanel() {
  const t = useTranslations("settings.skillManagement");
  const common = useTranslations("common");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importSource, setImportSource] = useState("");
  const [importSubdir, setImportSubdir] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [view, setView] = useState<"core" | "professional" | "all">("all");
  const [methods, setMethods] = useState<Record<string, SkillRow[]>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const [loadingMethods, setLoadingMethods] = useState("");
  const [agent, setAgent] = useState("");
  const [roles, setRoles] = useState<{ name: string; catalog_parent?: string }[]>([]);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [rootSkill, setRootSkill] = useState<SkillRow | null>(null);
  const [selected, setSelected] = useState<SkillRow | null>(null);
  const [file, setFile] = useState<SkillFile | null>(null);
  const [content, setContent] = useState("");
  const [newId, setNewId] = useState("");
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dirty = creating || Boolean(file && content !== file.text);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  useEffect(() => {
    const abort = new AbortController();
    void mcpRequest<{ roles: { name: string; catalog_parent?: string }[] }>("/mcp-settings/roles", undefined, abort.signal).then(r => { setRoles(r.roles); setAgent(r.roles.find(role => !role.catalog_parent)?.name || r.roles[0]?.name || ""); })
      .catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (scope === "agent" && !agent) return;
    const abort = new AbortController();
    setLoading(true); setError(""); setCatalog(null); setSelected(null); setFile(null); setMethods({}); setExpanded([]);
    const params = new URLSearchParams({ scope, view, hierarchical: "true", agent_id: agent, query: search, offset: String(offset), limit: "30", include_unassigned: "true" });
    void mcpRequest<SkillCatalog>("/skills/catalog?" + params, undefined, abort.signal).then(setCatalog)
      .catch(e => { if (!abort.signal.aborted) setError(e.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [scope, view, agent, search, offset, epoch]);
  useEffect(() => {
    if (dirty || busy) return;
    const timer = window.setTimeout(() => { setSearch(query); setOffset(0); }, 250);
    return () => window.clearTimeout(timer);
  }, [query, dirty, busy]);
  async function toggleMethods(row: SkillRow, loadOnly = false) {
    if (!loadOnly && expanded.includes(row.id)) { setExpanded(ids => ids.filter(id => id !== row.id)); return; }
    if (methods[row.id]) { if (!loadOnly) setExpanded(ids => [...ids, row.id]); return; }
    setLoadingMethods(row.id); setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ scope, agent_id: agent, parent: row.id, limit: "200", include_unassigned: "true" });
      const rows: SkillRow[] = [];
      let next: number | null = 0;
      do {
        params.set("offset", String(next));
        const result: SkillCatalog = await mcpRequest<SkillCatalog>("/skills/catalog?" + params);
        rows.push(...result.skills); next = result.next_offset;
      } while (next !== null);
      setMethods(previous => ({ ...previous, [row.id]: rows })); if (!loadOnly) setExpanded(ids => [...ids, row.id]);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); setLoadingMethods(""); }
  }
  async function navigate(action: () => void) {
    if (dirty && !(await confirm({ title: t("discard"), message: t("discardFileHint"), tone: "warning" }))) return false;
    setCreating(false); action();
    return true;
  }
  async function openSkill(row: SkillRow) {
    const loaded = await read(row);
    if (!loaded) return;
    const root = row.catalog_parent ? catalog?.skills.find(item => item.id === row.catalog_parent) : row;
    setRootSkill(root || row);
    if (root?.method_count) await toggleMethods(root, true);
  }
  async function read(row: SkillRow, name = "SKILL.md") {
    if (!(await navigate(() => undefined))) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const params = new URLSearchParams({ skill_id: row.id, scope: scope === "agent" && !row.assigned ? "all" : scope,
        agent_id: agent, file: name, limit: "32000" });
      let result = await mcpRequest<SkillFile>("/skills/read?" + params);
      let text = result.text;
      while (result.next_offset !== null) {
        params.set("offset", String(result.next_offset));
        const page = await mcpRequest<SkillFile>("/skills/read?" + params);
        if (page.revision !== result.revision) throw new Error("Skill changed during reading; refresh before editing.");
        text += page.text; result = page;
      }
      setSelected(row); setFile({ ...result, text }); setContent(text); setCreating(false); setEditing(false);
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function applyChange(action: "create" | "update" | "delete" | "enable" | "disable", row = selected) {
    if (!catalog || (!creating && !row)) return;
    if (action === "delete" && !(await confirm({ title: t("remove"), message: t("deleteHint", { name: `${row!.id}/${file?.file || "SKILL.md"}` }), tone: "danger" }))) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const binding = action === "enable" || action === "disable";
      const revision = binding ? (scope === "agent" ? catalog.binding_revision : catalog.enabled_revision) : creating ? "missing" : file?.revision;
      await mcpRequest<{ applied: boolean }>("/skills/manage", {
        action, skill_id: creating ? newId : row!.id, scope: creating ? "workspace" : scope,
        agent_id: scope === "agent" ? agent : "", file: binding ? "SKILL.md" : file?.file || "SKILL.md",
        revision, content: binding || action === "delete" ? "" : creating ? content.replace(/^name:.*$/m, "name: " + newId.trim()) : content,
      });
      setNotice(t("saved"));
      if (!binding) { setCreating(false); setSelected(null); setFile(null); setContent(""); }
      setEpoch(value => value + 1);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function importSkill() {
    if (!importSource.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const result = await clientApi.skillsInstall({ source: importSource.trim(), subdir: importSubdir.trim() || undefined });
      if (result.error || result.ok === false || result.status === "rejected") throw new Error(String(result.error || result.status));
      setNotice(t("imported")); setImporting(false); setImportSource(""); setImportSubdir(""); setEpoch(value => value + 1);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function removeSkill(row: SkillRow) {
    if (!await confirm({ title: t("remove"), message: t("deleteHint", { name: row.id }), tone: "danger" })) return;
    setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ skill_id: row.id, scope, file: "SKILL.md" });
      const current = await mcpRequest<SkillFile>("/skills/read?" + params);
      await mcpRequest("/skills/manage", { action: "delete", skill_id: row.id, scope, file: "SKILL.md", revision: current.revision });
      setNotice(t("saved")); setEpoch(value => value + 1);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  function skillRow(row: SkillRow): JSX.Element {
    return <div key={row.id + row.source} data-skill-id={row.id} className="min-w-0 border-b border-[color:var(--line)] py-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><button type="button" className="min-w-0 break-all text-left text-sm font-medium underline-offset-4 hover:underline" aria-pressed={selected?.id === row.id} disabled={busy || dirty} onClick={() => void openSkill(row)}>{row.id}</button><Pill tone={row.enabled ? "ok" : "neutral"}>{row.enabled ? t("enabled") : t("disabled")}</Pill></div>
      <p className="mt-1 line-clamp-3 break-words text-xs text-[color:var(--text-muted)]">{row.description}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2"><span className="text-xs text-[color:var(--text-muted)]">{row.source === "builtin" ? t("builtin") : ["workspace", "workspace_installed"].includes(row.source) ? t("workspace") : row.source}{scope === "agent" ? ` · ${row.assigned ? t("assigned") : t("unassigned")}` : ""}</span>
        <button type="button" className="relative inline-flex h-6 w-10 shrink-0 items-center rounded-full bg-[color:var(--line-hi)] transition-colors aria-checked:bg-brand-500 disabled:opacity-40" aria-label={scope === "agent" ? row.assigned ? t("unassign") : t("assign") : row.enabled ? t("disable") : t("enable")} role="switch" aria-checked={scope === "agent" ? Boolean(row.assigned) : row.enabled} disabled={busy || dirty} onClick={() => void applyChange((scope === "agent" ? row.assigned : row.enabled) ? "disable" : "enable", row)}><span aria-hidden className={"h-4 w-4 rounded-full bg-white transition-transform " + ((scope === "agent" ? row.assigned : row.enabled) ? "translate-x-5" : "translate-x-1")} /></button>
        {scope !== "agent" && ["workspace", "workspace_installed"].includes(row.source) && <button type="button" className="btn btn-ghost text-danger text-xs" disabled={busy || dirty} onClick={() => void removeSkill(row)}>{common("delete")}</button>}
        {Boolean(row.method_count) && <button type="button" className="btn btn-ghost text-xs" aria-expanded={expanded.includes(row.id)} aria-controls={`methods-${row.id}`} disabled={busy || dirty} onClick={() => void toggleMethods(row)}>{loadingMethods === row.id ? t("loading") : t("methods", { count: row.method_count || 0 })}</button>}
      </div>
      {row.catalog_parent && (view === "all" || search) && <p className="mt-1 break-all text-xs text-[color:var(--text-muted)]">{t("partOf", { name: row.catalog_parent })}</p>}
      {expanded.includes(row.id) && <div id={`methods-${row.id}`} className="mt-2 pl-3" aria-label={t("methods", { count: methods[row.id]?.length || 0 })}>{methods[row.id]?.map(skillRow)}</div>}
    </div>;
  }
  return <section className="mx-auto w-full max-w-4xl" aria-label={t("title")}>
    <div className="space-y-5"><ErrorBanner error={error} onRetry={() => void navigate(() => setEpoch(v => v + 1))} />
      {notice && <p role="status" className="text-sm">{notice}</p>}
      <fieldset disabled={busy || dirty} className="grid gap-3 border-0 p-0 sm:grid-cols-2">

        <Field label={t("scope")}><select className="input-dark w-full" value={scope} onChange={e => { setOffset(0); setScope(e.target.value as Scope); }}><option value="all">{t("all")}</option><option value="builtin">{t("builtin")}</option><option value="workspace">{t("workspace")}</option><option value="agent">{t("agent")}</option></select></Field>
        {scope === "agent" && <Field label={t("role")}><select className="input-dark w-full" value={agent} onChange={e => { setOffset(0); setAgent(e.target.value); }}><optgroup label={t("primaryRoles")}>{roles.filter(r => !r.catalog_parent).map(r => <option key={r.name}>{r.name}</option>)}</optgroup><optgroup label={t("profileRoles")}>{roles.filter(r => r.catalog_parent).map(r => <option key={r.name}>{r.name}</option>)}</optgroup></select></Field>}
        <Field label={t("search")}><input className="input-dark w-full" placeholder={t("searchHint")} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); setSearch(query); setOffset(0); setEpoch(v => v + 1); } }} /></Field>

      </fieldset>
      <details open={filtersOpen} onToggle={event => setFiltersOpen(event.currentTarget.open)}><summary className="cursor-pointer text-xs text-[color:var(--text-muted)]">{t("view")}</summary><div className="mt-3 max-w-xs"><Field label={t("view")}><select className="input-dark w-full" value={view} onChange={e => { setOffset(0); setView(e.target.value as typeof view); }}><option value="core">{t("coreView")}</option><option value="professional">{t("professionalView")}</option><option value="all">{t("allView")}</option></select></Field></div></details>
      <div className="flex flex-wrap items-center gap-3"><button type="button" className="btn btn-ghost" disabled={busy || dirty} onClick={() => setEpoch(v => v + 1)}>{t("refresh")}</button><button type="button" className="btn btn-ghost" disabled={busy || !catalog || scope === "agent"} onClick={() => void navigate(() => { setNotice(""); setError(""); setCreating(true); setSelected(null); setFile(null); setNewId("new_skill"); setContent("---\nname: new_skill\ndescription: Describe when this Skill should be used.\n---\n\n# Workflow\n\n"); })}>{t("create")}</button>
        <button type="button" className="btn btn-ghost" disabled={busy || dirty} onClick={() => { setError(""); setImporting(true); }}>{t("import")}</button>
        {dirty && <button type="button" className="btn btn-ghost" onClick={() => void navigate(() => { setContent(file?.text || ""); })}>{t("discard")}</button>}
        {catalog && <span role="status" className="text-xs text-[color:var(--text-muted)]">{t(search || view === "all" ? "entryCount" : "workflowCount", { count: catalog.total })}</span>}
      </div>
      {scope === "agent" && <p className="text-sm text-[color:var(--text-muted)]">{t("roleHint")}</p>}
      {loading && <p role="status">{t("loading")}</p>}
      {catalog?.skills.length === 0 && <p className="text-sm">{t("empty")}</p>}
      <div className="min-w-0">
        <div data-testid="skill-catalog" className="min-w-0">{Array.from(new Set(catalog?.skills.map(row => row.source))).map(source => <section key={source} className="mb-6"><h3 className="border-b border-[color:var(--line)] py-2 text-sm font-semibold">{source === "builtin" ? t("builtin") : source === "workspace" || source === "workspace_installed" ? t("workspace") : source}</h3>{catalog?.skills.filter(row => row.source === source).map(skillRow)}</section>)}</div>
        <Dialog.Root open={Boolean(file) || creating} onOpenChange={open => { if (!open && !busy) void navigate(() => { setSelected(null); setFile(null); setContent(""); }); }}>
        <Dialog.Portal>
        <Dialog.Overlay className="ui-modal-overlay" />
        <Dialog.Content aria-describedby={undefined} className="ui-dialog" style={{ width: "min(1120px, calc(100vw - 24px))" }}>
        <div className="mb-4 flex items-center justify-between gap-3"><Dialog.Title className="min-w-0 break-all text-lg font-semibold">{creating ? t("create") : rootSkill?.id || selected?.id}</Dialog.Title><Dialog.Close className="btn btn-ghost" disabled={busy}>{common("close")}</Dialog.Close></div>
        <div className={creating ? "" : "grid min-w-0 gap-5 md:grid-cols-[240px_minmax(0,1fr)]"}>
        {!creating && file && <aside className="max-h-[65vh] min-w-0 space-y-4 overflow-auto border-b border-[color:var(--line)] pb-4 md:border-b-0 md:border-r md:pr-4">
          {rootSkill && <button type="button" className="btn btn-ghost w-full justify-start" disabled={busy} onClick={() => void read(rootSkill)}>{t("mainSkill")}: {rootSkill.id}</button>}
          {!!rootSkill?.method_count && <section><h3 className="mb-2 text-sm font-semibold">{t("subSkills")}</h3>{loadingMethods ? <p role="status">{t("loading")}</p> : methods[rootSkill.id]?.map(row => <button key={row.id} type="button" disabled={busy} aria-pressed={selected?.id === row.id} onClick={() => void read(row)} className={"mb-1 w-full break-all rounded px-2 py-2 text-left text-xs " + (selected?.id === row.id ? "bg-brand-500/10 text-brand-500" : "hover:bg-brand-500/10")}>{row.id}</button>)}</section>}
          <section><h3 className="mb-2 break-all text-sm font-semibold">{selected?.id} /</h3><SkillFileTree files={file.files} selected={file.file} disabled={busy} onSelect={name => { if (selected) void read(selected, name); }} /></section>
        </aside>}
        <div className="min-w-0 space-y-3">
          <ErrorBanner error={error} />
          {notice && <p role="status" className="text-sm">{notice}</p>}
          {!file && !creating && <p className="text-sm text-[color:var(--text-muted)]">{t("select")}</p>}
          {creating && <Field label={t("id")}><input className="input-dark w-full" value={newId} onChange={e => setNewId(e.target.value.trim())} /></Field>}
          {file && <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--line)] pb-3"><span className="min-w-0 break-all font-mono text-xs">{selected?.id} / {file.file}</span><div className="flex gap-2"><button type="button" className="btn btn-ghost" aria-pressed={!editing} disabled={busy} onClick={() => setEditing(false)}>{t("preview")}</button><button type="button" className="btn btn-ghost" aria-pressed={editing} disabled={busy || scope === "agent" || content.includes("***REDACTED***")} onClick={() => setEditing(true)}>{t("edit")}</button></div></div>}
          {file && !editing && !creating && <div className="max-h-[60vh] min-w-0 overflow-auto">{/\.md$/i.test(file.file) ? <Markdown>{content.replace(/^(?:\s*<!--[\s\S]*?-->\s*)*---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim()}</Markdown> : <pre className="whitespace-pre-wrap break-words rounded bg-[color:var(--bg)] p-4 font-mono text-xs leading-6">{content}</pre>}</div>}
          {(creating || (file && editing)) && <><Field label={t("content")}><textarea className="input-dark min-h-[22rem] w-full font-mono text-xs leading-6" rows={18} value={content} onChange={e => setContent(e.target.value)} spellCheck={false} readOnly={busy || scope === "agent" || Boolean(file?.text.includes("***REDACTED***"))} /></Field>
            {file?.source === "builtin" && <p className="text-sm text-[color:var(--text-muted)]">{t("overrides")}</p>}
            {file?.text.includes("***REDACTED***") && <p className="text-sm text-danger">{t("redacted")}</p>}
            {scope !== "agent" && <div className="flex flex-wrap gap-2"><button type="button" className="btn btn-primary" disabled={busy || !dirty || (creating && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(newId)) || Boolean(file?.text.includes("***REDACTED***"))} onClick={() => void applyChange(creating ? "create" : "update")}>{t("save")}</button>
              {file && ["workspace", "workspace_installed"].includes(file.source) && <button type="button" className="btn btn-ghost" disabled={busy || dirty} onClick={() => void applyChange("delete")}>{t("remove")}</button>}</div>}
          </>}
        </div>
        </div>
        </Dialog.Content></Dialog.Portal></Dialog.Root>
      </div>
      {catalog && (offset > 0 || catalog.next_offset !== null) && <div className="flex gap-2"><button type="button" className="btn btn-ghost" disabled={!offset || busy || dirty} onClick={() => setOffset(Math.max(0, offset - 30))}>{t("back")}</button><button type="button" className="btn btn-ghost" disabled={catalog.next_offset === null || busy || dirty} onClick={() => setOffset(catalog.next_offset || 0)}>{t("next")}</button></div>}
      <Dialog.Root open={importing} onOpenChange={open => { if (!busy) setImporting(open); }}><Dialog.Portal><Dialog.Overlay className="ui-modal-overlay" /><Dialog.Content className="ui-dialog p-6" aria-describedby="skill-import-help"><Dialog.Title className="text-lg font-semibold">{t("import")}</Dialog.Title><Dialog.Description id="skill-import-help" className="my-3 text-sm text-[color:var(--text-muted)]">{t("importHint")}</Dialog.Description><form className="space-y-4" onSubmit={event => { event.preventDefault(); void importSkill(); }}><ErrorBanner error={error} /><Field label={t("importSource")}><input className="input-dark w-full" value={importSource} onChange={event => setImportSource(event.target.value)} disabled={busy} required /></Field><Field label={t("importSubdir")}><input className="input-dark w-full" value={importSubdir} onChange={event => setImportSubdir(event.target.value)} disabled={busy} /></Field><div className="flex justify-end gap-2"><Dialog.Close className="btn btn-ghost" disabled={busy}>{common("cancel")}</Dialog.Close><button className="btn btn-primary" disabled={busy || !importSource.trim()}>{busy ? t("busy") : t("import")}</button></div></form></Dialog.Content></Dialog.Portal></Dialog.Root>
      {busy && <p role="status">{t("busy")}</p>}
    </div>
  </section>;
}
