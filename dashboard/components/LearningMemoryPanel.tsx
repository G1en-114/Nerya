"use client";
import { copy as i18nCopy } from "../lib/i18n";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { Empty, ErrorBanner, LoadingState } from "./Page";
import { ChoiceSelect } from "./ChoiceSelect";
import { SearchField } from "./ListControls";
import { ChevronRightIcon, PlusIcon } from "./icons";
import { callApi, clientApi } from "../lib/clientApi";
import { confirm, prompt, toast } from "../lib/dialogs";
import ui from "./learning.module.css";

type Domain = { scope: "global" | "strategy" | "workflow"; strategy_id: string; workflow_id: string };
type Memory = Domain & { memory_id: string; stable_key: string; category: string; content: string; source_ref: string; evidence_refs: string[]; updated_at: number };
type Result = { ok: boolean; error?: string; skip_reason?: string };
const GLOBAL: Domain = { scope: "global", strategy_id: "", workflow_id: "" };

export function LearningMemoryPanel() {
  const zh = useLocale().startsWith("zh");
  const text = (key: string, values?: Record<string, unknown>) => i18nCopy(zh, key, values);
  const [domains, setDomains] = useState<Domain[]>([GLOBAL]);
  const [domain, setDomain] = useState<Domain>(GLOBAL);
  const [query, setQuery] = useState("");
  const [records, setRecords] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [domainsLoading, setDomainsLoading] = useState(true);
  const [editing, setEditing] = useState<Memory | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [content, setContent] = useState("");
  const [key, setKey] = useState("");
  const [category, setCategory] = useState("learning");
  const [notesOpen, setNotesOpen] = useState(false);
  const generation = useRef(0);
  const domainGeneration = useRef(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const queryRef = useRef(query);
  queryRef.current = query;
  const categories: Record<string, string> = {
    learning: text("copy.components_LearningMemoryPanel.001"), decision: text("copy.components_LearningMemoryPanel.002"),
    preference: text("copy.components_LearningMemoryPanel.003"), error: text("copy.components_LearningMemoryPanel.004"),
    session_summary: text("copy.components_LearningMemoryPanel.005"),
  };

  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true); setError(null);
    try {
      const response = await callApi<Result & { records: Memory[] }>("/memory/records", {
        method: "POST", body: { ...domain, query: queryRef.current, limit: 100 },
      });
      if (request !== generation.current) return;
      if (!response.ok) throw new Error(response.error || "memory_read_failed");
      setRecords(response.records);
    } catch (e) {
      if (request === generation.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [domain]);

  const loadDomains = useCallback(async () => {
    const request = ++domainGeneration.current;
    setDomainsLoading(true); setDomainError(null);
    try {
      const response = await callApi<Result & { domains: Domain[] }>("/memory/domains");
      if (request !== domainGeneration.current) return;
      if (!response.ok || !Array.isArray(response.domains)) throw new Error(response.error || "memory_domains_failed");
      setDomains(response.domains);
    } catch (e) {
      if (request === domainGeneration.current) setDomainError(e instanceof Error ? e.message : String(e));
    } finally {
      if (request === domainGeneration.current) setDomainsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDomains();
    return () => { domainGeneration.current++; generation.current++; };
  }, [loadDomains]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), query ? 250 : 0);
    return () => { window.clearTimeout(timer); generation.current++; };
  }, [load, query]);
  useEffect(() => { if (draftOpen) textarea.current?.focus(); }, [draftOpen, editing]);
  useEffect(() => {
    if (!draftOpen || content === (editing?.content || "")) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draftOpen, content, editing]);

  function explain(result: Result) {
    const code = result.error || result.skip_reason || "unknown_error";
    const messages: Record<string, string> = {
      update_conflict: text("copy.components_LearningMemoryPanel.006"),
      unsafe_content: text("copy.components_LearningMemoryPanel.007"),
      unknown_workflow: text("copy.components_LearningMemoryPanel.008"),
      unknown_strategy: text("copy.components_LearningMemoryPanel.009"),
    };
    return messages[code] || code;
  }

  function startDraft(record?: Memory) {
    setEditing(record || null);
    setContent(record?.content || "");
    setKey(record?.stable_key || crypto.randomUUID());
    setCategory(record?.category || "learning");
    setError(null); setDraftOpen(true);
  }

  async function closeDraft() {
    if (content !== (editing?.content || "") && !await confirm({
      message: text("copy.components_LearningMemoryPanel.010"),
      okLabel: text("copy.components_LearningMemoryPanel.011"),
    })) return;
    setDraftOpen(false); setEditing(null); addButton.current?.focus();
  }

  async function save() {
    setBusy(true); setError(null);
    try {
      const result = await callApi<Result>("/memory/capture", {
        method: "POST", body: { ...domain, content, key, category, expected_memory_id: editing?.memory_id || "" },
      });
      if (!result.ok && result.skip_reason !== "unchanged") throw new Error(explain(result));
      setDraftOpen(false); setEditing(null); setContent(""); setKey("");
      await load(); addButton.current?.focus();
      toast({ message: text("copy.components_LearningMemoryPanel.012"), tone: "ok" });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function forget(record: Memory) {
    if (!await confirm({
      message: text("copy.components_LearningMemoryPanel.013"),
      okLabel: text("copy.components_LearningMemoryPanel.014"), tone: "danger",
    })) return;
    setBusy(true); setError(null);
    try {
      const result = await callApi<Result>("/memory/forget", {
        method: "POST", body: { ...domain, ...(record.stable_key ? { key: record.stable_key } : { memory_id: record.memory_id }) },
      });
      if (!result.ok) throw new Error(explain(result));
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  function domainLabel(item: Domain) {
    if (item.scope === "global") return text("copy.components_LearningMemoryPanel.015");
    if (item.scope === "strategy") return text("copy.components_LearningMemoryPanel.016") + item.strategy_id;
    const workflow = item.workflow_id === "execution" ? text("copy.components_LearningMemoryPanel.017") : item.workflow_id === "evolution" ? text("copy.components_LearningMemoryPanel.018") : item.workflow_id;
    return [item.strategy_id || text("copy.components_LearningMemoryPanel.019"), workflow].join(" / ");
  }

  return <div className={ui.root}>
    <div className={ui.toolbar}>
      <div className={ui.scope}>
        <ChoiceSelect className="w-full justify-between" aria-label={text("copy.components_LearningMemoryPanel.020")} value={JSON.stringify(domain)} disabled={busy || draftOpen || domainsLoading || Boolean(domainError)}
          onValueChange={(value) => { setRecords([]); setDomain(JSON.parse(value) as Domain); }}>
          {domains.map((item) => <option key={JSON.stringify(item)} value={JSON.stringify(item)}>{domainLabel(item)}</option>)}
        </ChoiceSelect>
      </div>
      <div className={ui.search}>
        <SearchField value={query} onChange={setQuery} label={text("copy.components_LearningMemoryPanel.021")} placeholder={text("copy.components_LearningMemoryPanel.022")} disabled={busy} />
      </div>
      <button ref={addButton} className="btn btn-primary" disabled={busy || draftOpen || domainsLoading || Boolean(domainError)} onClick={() => startDraft()}>
        <PlusIcon size={15} />{text("copy.components_LearningMemoryPanel.023")}
      </button>
    </div>
    <div className={ui.hint}>
      <p>{domain.scope === "global" ? text("copy.components_LearningMemoryPanel.024") : text("copy.components_LearningMemoryPanel.025")}</p>
      {!loading && !domainsLoading && !error && !domainError && <span>{text(records.length === 100 ? "copy.components_LearningMemoryPanel.countCapped" : "copy.components_LearningMemoryPanel.count", { count: records.length })}</span>}
    </div>
    {(error || domainError) && <ErrorBanner error={error || domainError} onRetry={() => { void loadDomains(); void load(); }} />}

    {draftOpen && <form className={ui.editor} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className={ui.editorTitle}><h2>{editing ? text("copy.components_LearningMemoryPanel.026") : text("copy.components_LearningMemoryPanel.027")}</h2><span>{domainLabel(domain)}</span></div>
      <label className="sr-only" htmlFor="learning-memory-content">{text("copy.components_LearningMemoryPanel.028")}</label>
      <textarea ref={textarea} id="learning-memory-content" className="input-dark" required maxLength={12000} disabled={busy} value={content}
        onChange={(e) => setContent(e.target.value)} placeholder={text("copy.components_LearningMemoryPanel.029")} />
      <details className={ui.options}>
        <summary>{text("copy.components_LearningMemoryPanel.030")}</summary>
        <div className={ui.optionFields}>
          <label>{text("copy.components_LearningMemoryPanel.031")}<select className="input-dark" disabled={busy || Boolean(editing)} value={category} onChange={(e) => setCategory(e.target.value)}>
            {Object.entries(categories).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select></label>
        </div>
      </details>
      <div className={ui.editorActions}>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void closeDraft()}>{text("copy.components_LearningMemoryPanel.032")}</button>
        <button className="btn btn-primary" disabled={busy || !content.trim() || !key.trim()}>{busy ? text("copy.components_LearningMemoryPanel.033") : text("copy.components_LearningMemoryPanel.034")}</button>
      </div>
    </form>}

    <div className={ui.list} aria-busy={loading || domainsLoading}>
      {loading || domainsLoading ? <LoadingState rows={3} /> : error || domainError ? null : !records.length ? <Empty
        title={query ? text("copy.components_LearningMemoryPanel.035") : text("copy.components_LearningMemoryPanel.036")}
        subtitle={query ? text("copy.components_LearningMemoryPanel.037") : text("copy.components_LearningMemoryPanel.038")} /> : records.map((record) => <details key={record.memory_id} className={ui.row}>
        <summary className={ui.summary}>
          <div className={ui.preview}>
            <p className={ui.content}>{record.content}</p>
            <div className={ui.meta}>
              <span>{categories[record.category] || record.category}</span><span aria-hidden="true">·</span>
              <time dateTime={new Date(record.updated_at * 1000).toISOString()}>{new Date(record.updated_at * 1000).toLocaleDateString(zh ? "zh-CN" : "en-US", { month: "short", day: "numeric" })}</time>
            </div>
          </div>
          <ChevronRightIcon size={16} className={ui.chevron} />
        </summary>
        <div className={ui.detail}>
          <div className={ui.actions}>
            {record.stable_key && <button className={ui.textButton} disabled={busy || draftOpen} onClick={() => startDraft(record)}>{text("copy.components_LearningMemoryPanel.039")}</button>}
            <button className={ui.textButton} disabled={busy || draftOpen} onClick={() => void forget(record)}>{text("copy.components_LearningMemoryPanel.040")}</button>
          </div>
          <details className={ui.source}>
            <summary>{text("copy.components_LearningMemoryPanel.041")}</summary>
            <p>{record.source_ref || text("copy.components_LearningMemoryPanel.042")}</p>
            {record.evidence_refs.map((ref) => <p key={ref}>{ref}</p>)}
            {/^session:[A-Za-z0-9_-]+$/.test(record.source_ref)&&<a className="inline-flex min-h-11 items-center underline" href={"/chat/"+encodeURIComponent(record.source_ref.slice(8))}>{zh?"查看来源任务":"View source task"}</a>}
            <p>{zh?"适用范围：":"Applies to: "}{record.scope}{record.strategy_id?" · "+record.strategy_id:""}{record.workflow_id?" · "+record.workflow_id:""}</p>
            <p>{text("copy.components_LearningMemoryPanel.043")}{record.stable_key || record.memory_id}</p>
          </details>
        </div>
      </details>)}
    </div>
    {records.length === 100 && <p className={ui.hint}>{text("copy.components_LearningMemoryPanel.044")}</p>}
    <section className={ui.pinned}>
      <button className={ui.sectionButton} aria-expanded={notesOpen} aria-controls="global-memory-notes" onClick={() => setNotesOpen(!notesOpen)}>
        <ChevronRightIcon size={14} className={notesOpen ? "rotate-90" : ""} />{text("copy.components_LearningMemoryPanel.045")}
      </button>
      {notesOpen && <div id="global-memory-notes"><GlobalNotes /></div>}
    </section>
  </div>;
}

function GlobalNotes() {
  const zh = useLocale().startsWith("zh");
  const [notes, setNotes] = useState<{ agent: string[]; operator: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const data = await clientApi.memoryNotebookList();
    setNotes({ agent: data.agent.entries, operator: data.operator.entries });
  }, []);
  useEffect(() => { void load().catch((e) => setError(String(e))); }, [load]);

  async function mutate(target: "agent" | "operator", action: "add" | "replace" | "remove", entry = "") {
    let content = "";
    if (action === "remove") {
      if (!await confirm({ message: i18nCopy(zh, "copy.components_LearningMemoryPanel.046"), tone: "danger" })) return;
    } else {
      const value = await prompt({ message: i18nCopy(zh, "copy.components_LearningMemoryPanel.047"), defaultValue: entry });
      if (!value?.trim()) return;
      content = value.trim();
    }
    setBusy(true); setError(null);
    try {
      const result = await clientApi.memoryNotebookMutate({ target, action, content, old_text: entry });
      if (!result.ok) throw new Error(result.error || result.message || "notebook_update_failed");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return <>
    {error && <ErrorBanner error={error} />}
    <p className={ui.pinnedIntro}>{i18nCopy(zh, "copy.components_LearningMemoryPanel.048")}</p>
    {notes ? <div className={ui.notes}>{(["agent", "operator"] as const).map((target) => <section key={target}>
      <div className={ui.noteHeader}>
        <h3>{target === "agent" ? (i18nCopy(zh, "copy.components_LearningMemoryPanel.049")) : (i18nCopy(zh, "copy.components_LearningMemoryPanel.050"))}</h3>
        <button className={ui.textButton} disabled={busy} onClick={() => void mutate(target, "add")}>{i18nCopy(zh, "copy.components_LearningMemoryPanel.051")}</button>
      </div>
      {notes[target].length ? notes[target].map((entry, i) => <div key={i} className={ui.note}>
        <p>{entry}</p>
        <div className={ui.actions}>
          <button className={ui.textButton} disabled={busy} onClick={() => void mutate(target, "replace", entry)}>{i18nCopy(zh, "copy.components_LearningMemoryPanel.052")}</button>
          <button className={ui.textButton} disabled={busy} onClick={() => void mutate(target, "remove", entry)}>{i18nCopy(zh, "copy.components_LearningMemoryPanel.053")}</button>
        </div>
      </div>) : <p className={ui.noteEmpty}>{i18nCopy(zh, "copy.components_LearningMemoryPanel.054")}</p>}
    </section>)}</div> : !error && <LoadingState />}
  </>;
}
