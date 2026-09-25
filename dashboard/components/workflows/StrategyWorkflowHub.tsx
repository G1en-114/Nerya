"use client";
import { Icon as NeryaGlyph } from "../icons";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ModePill } from "../ModePill";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { clientApi, invalidateReadCache } from "../../lib/clientApi";
import { confirm, prompt, toast } from "../../lib/dialogs";
import { workflowApi } from "../../lib/workflowApi";
import type { WorkflowSummary, WorkflowView } from "../../lib/workflowTypes";
import { StrategyImportButton, StrategyExportButton } from "./StrategyTransfer";
import { StrategyWorkflowPanel, confirmDiscard } from "./StrategyWorkflowPanel";
import { useWorkflowText } from "./WorkflowCanvas";
import styles from "./WorkflowStudio.module.css";
import ui from "./WorkflowNative.module.css";
import { stateLabel } from "../../lib/workflowPresentation";
import { strategyLanding } from "../../lib/strategyLanding";
import { useTranslations } from "next-intl";

export function StrategyWorkflowHub({ onLegacyView }: { onLegacyView?: () => void }) {
  const t = useWorkflowText();
  const wx = useTranslations("workflowExperience");
  const transfer = useTranslations("strategyTransfer");
  const router = useRouter();
  const params = useSearchParams();
  const sourceSession=params?.get("session_id");
  const requestedStrategy = params?.get("strategy_id");
  const requestedProposal = params?.get("proposal_id");
  const [rows, setRows] = useState<WorkflowSummary[]>([]);
  const [selection, setSelection] = useState<{ strategyId: string; proposalId: string | null } | null>(null);
  const [query, setQuery] = useState("");
  const [allVersions, setAllVersions] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [selectionEpoch, setSelectionEpoch] = useState(0);
  const switching = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [managing, setManaging] = useState(false);
  const [dirty, setDirty] = useState(false);
  const load = useCallback(async () => {
    setError(""); setLoading(true);
    try {
      const result = await workflowApi.list();
      setRows(result.workflows);

    } catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!requestedStrategy) { setSelection(null); setDirty(false); return; }
    const match = rows.find((row) => row.strategy_id === requestedStrategy && row.proposal_id === requestedProposal)
      || (!requestedProposal ? rows.find((row) => row.strategy_id === requestedStrategy) : undefined);
    setSelection({ strategyId: requestedStrategy, proposalId: match?.proposal_id || requestedProposal || null });
  }, [requestedStrategy, requestedProposal, rows]);
  const filtered = useMemo(() => rows.filter((row) => `${row.title} ${row.strategy_id} ${row.state} ${row.mode} ${row.markets?.join(" ") || ""}`.toLowerCase().includes(query.toLowerCase())), [query, rows]);
  const visibleRows = allVersions ? filtered : [...new Set(filtered.map((row) => row.strategy_id))].map((id) => filtered.find((row) => row.strategy_id === id && selection?.strategyId === id && row.proposal_id === selection.proposalId) || filtered.find((row) => row.strategy_id === id && !row.proposal_id) || filtered.find((row) => row.strategy_id === id)!);
  const acceptLeave = useCallback(async () => !dirty || confirmDiscard(t("copy.components_workflows_StrategyWorkflowHub.001")), [dirty, t]);
  function updateSelection(strategyId: string, proposalId: string | null) {
    setSelection({ strategyId, proposalId }); setDirty(false);
    const url = new URL(window.location.href);
    url.searchParams.set("strategy_id", strategyId);
    url.searchParams.delete("workflow_log"); url.searchParams.delete("workflow_run");
    if (proposalId) url.searchParams.set("proposal_id", proposalId); else url.searchParams.delete("proposal_id");
    router.push(url.pathname + url.search);
  }
  async function select(row: WorkflowSummary, edit = false) {
    if (switching.current) return;
    setSwitcherOpen(false);
    if (selection?.strategyId === row.strategy_id && selection.proposalId === row.proposal_id && (edit || strategyLanding(row.status, false, row.proposal_id) === "workflow")) return;
    switching.current = true;
    try { if (await acceptLeave()) {
      if (!edit && strategyLanding(row.status, false, row.proposal_id) === "performance") {
        router.push(`/strategies/${encodeURIComponent(row.strategy_id)}?tab=performance`);
      } else { updateSelection(row.strategy_id, row.proposal_id); setSelectionEpoch((n) => n + 1); }
    } }
    finally { switching.current = false; }
  }
  function onSaved(value: WorkflowView) { updateSelection(value.strategy_id, value.source.proposal_id); void load(); }
  async function manage(action: "rename" | "delete", target = selection) {
    if (!target || managing) return;
    setManageOpen(false);
    if (!await acceptLeave()) return;
    const current = rows.find((row) => row.strategy_id === target.strategyId && row.proposal_id === target.proposalId);
    const title = current?.title || target.strategyId;
    setManaging(true); setError("");
    try {
      if (action === "rename") {
        const value = await prompt({ title: t("copy.components_workflows_StrategyWorkflowHub.002"), message: t("copy.components_workflows_StrategyWorkflowHub.003"), defaultValue: title, okLabel: t("copy.components_workflows_StrategyWorkflowHub.004") });
        if (value === null || value.trim() === title) return;
        if (!value.trim() || value.trim().length > 200) throw new Error(t("copy.components_workflows_StrategyWorkflowHub.005"));
        if (target.proposalId) {
          const workflow = await workflowApi.get(target.strategyId, target.proposalId);
          const root = workflow.strategy.nodes.find((node) => node.kind === "strategy");
          if (!root) throw new Error(t("copy.components_workflows_StrategyWorkflowHub.006"));
          const out = await workflowApi.propose({ strategy_id: target.strategyId, proposal_id: target.proposalId, base_revision: workflow.revision, changes: [{ node_id: root.id, config: { title: value.trim() } }] });
          if (selection) updateSelection(target.strategyId, out.proposal_id);
        } else {
          const out = await clientApi.strategyUpdate(target.strategyId, { title: value.trim(), reason: "operator rename from strategy canvas" });
          if (!out.ok) throw new Error(t("copy.components_workflows_StrategyWorkflowHub.007"));
        }
        toast({ message: target.proposalId ? t("copy.components_workflows_StrategyWorkflowHub.008") : t("copy.components_workflows_StrategyWorkflowHub.009"), tone: "ok" });
      } else {
        if (!await confirm({ title: target.proposalId ? t("copy.components_workflows_StrategyWorkflowHub.010") : t("copy.components_workflows_StrategyWorkflowHub.011"), message: t("copy.components_workflows_StrategyWorkflowHub.012") + title + t("copy.components_workflows_StrategyWorkflowHub.013"), okLabel: t("copy.components_workflows_StrategyWorkflowHub.014"), tone: "danger" })) return;
        const out = target.proposalId ? await clientApi.proposalDelete(target.proposalId) : await clientApi.strategyDelete({ strategy_id: target.strategyId, force: false });
        if (!out.ok && !out.deleted) throw new Error(out.error || t("copy.components_workflows_StrategyWorkflowHub.015"));
        if (selection) { setSelection(null); setDirty(false); router.push("/strategies"); }
        toast({ message: t("copy.components_workflows_StrategyWorkflowHub.016"), tone: "ok" });
      }
      setDirty(false); setSelectionEpoch((n) => n + 1); invalidateReadCache(); await load();
    } catch (reason) { setError(String(reason)); }
    finally { setManaging(false); }
  }
  const renderTitle = (title: string) => <Popover.Root open={switcherOpen} onOpenChange={(open) => { setSwitcherOpen(open); if (open) { setQuery(""); setManageOpen(false); } }}><Popover.Trigger asChild><button type="button" className={ui.strategyTrigger} aria-label={t("copy.components_workflows_StrategyWorkflowHub.017")}><span>{title}</span><NeryaGlyph name="chevronDown" size={16} /></button></Popover.Trigger><Popover.Portal><Popover.Content className={ui.switcherMenu} align="start" sideOffset={12} collisionPadding={16} aria-label={t("copy.components_workflows_StrategyWorkflowHub.018")} onOpenAutoFocus={(event) => { event.preventDefault(); searchRef.current?.focus(); }}>
    <input ref={searchRef} className={ui.sidebarSearch} type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("copy.components_workflows_StrategyWorkflowHub.019")} placeholder={t("copy.components_workflows_StrategyWorkflowHub.020")} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>("[data-strategy-option]")?.focus(); } }} />
    <div className={ui.switcherList} aria-label={t("copy.components_workflows_StrategyWorkflowHub.021")} onKeyDown={(event) => { if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return; const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-strategy-option]")]; const current = options.indexOf(document.activeElement as HTMLButtonElement); const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length; event.preventDefault(); options[next]?.focus(); }}>
      {visibleRows.map((row) => <button key={row.key} type="button" data-strategy-option={row.key} className={ui.strategyOption} title={row.error || row.title} aria-pressed={selection?.strategyId === row.strategy_id && selection.proposalId === row.proposal_id} onClick={() => void select(row)} data-testid={`strategy-card-${row.strategy_id}`}><span><strong>{row.title}</strong><small>{row.error ? t("copy.components_workflows_StrategyWorkflowHub.022") : `${row.mode.toUpperCase()} · ${stateLabel(row.state, t)}`}{allVersions && row.proposal_id ? ` · ${row.proposal_id}` : ""}</small></span><span aria-hidden="true">{selection?.strategyId === row.strategy_id && selection.proposalId === row.proposal_id ? <NeryaGlyph name="check" size={16} /> : null}</span></button>)}
      {!visibleRows.length && <p className={ui.muted}>{loading ? t("copy.components_workflows_StrategyWorkflowHub.023") : t("copy.components_workflows_StrategyWorkflowHub.024")}</p>}
    </div><div className={ui.switcherFooter}><label><input type="checkbox" checked={allVersions} onChange={(event) => setAllVersions(event.target.checked)} />{t("copy.components_workflows_StrategyWorkflowHub.025")}</label></div>
  </Popover.Content></Popover.Portal></Popover.Root>;
  const management = <Popover.Root open={manageOpen} onOpenChange={(open) => { setManageOpen(open); if (open) setSwitcherOpen(false); }}><Popover.Trigger asChild><button type="button" className={ui.iconButton} aria-label={t("copy.components_workflows_StrategyWorkflowHub.026")}><NeryaGlyph name="ellipsis" size={18} /></button></Popover.Trigger><Popover.Portal><Popover.Content className={ui.manageMenu} align="end" sideOffset={8} collisionPadding={16} aria-label={t("copy.components_workflows_StrategyWorkflowHub.027")}>
    <button type="button" disabled={managing} onClick={() => void manage("rename")}>{t("copy.components_workflows_StrategyWorkflowHub.028")}</button><button type="button" disabled={managing} onClick={() => void manage("delete")}>{selection?.proposalId ? t("copy.components_workflows_StrategyWorkflowHub.029") : t("copy.components_workflows_StrategyWorkflowHub.030")}</button>
    <button type="button" disabled={loading || dirty} onClick={() => { setManageOpen(false); invalidateReadCache(); void load(); }}>{t("copy.components_workflows_StrategyWorkflowHub.031")}</button>{onLegacyView && <button type="button" onClick={async () => { setManageOpen(false); if (await acceptLeave()) onLegacyView(); }}>{t("copy.components_workflows_StrategyWorkflowHub.032")}</button>}<Link href="/workflows" onClick={() => setManageOpen(false)}>{t("copy.components_workflows_StrategyWorkflowHub.033")} <NeryaGlyph name="arrowUpRight" size={16} /></Link>
  </Popover.Content></Popover.Portal></Popover.Root>;
  const directory = <section className={ui.directory} data-testid="strategy-directory">
    <header className={ui.directoryHeader}><div><h1>{t("copy.components_workflows_StrategyWorkflowHub.034")}</h1><p>{t("copy.components_workflows_StrategyWorkflowHub.035")}</p></div><div className="flex flex-wrap items-center gap-2"><StrategyImportButton onImported={onSaved} /><Link className="btn btn-primary" href="/chat"><NeryaGlyph name="plus" size={16} /> {t("copy.components_workflows_StrategyWorkflowHub.036")}</Link></div></header>
    <div className={ui.directoryTools}><input type="search" className="input-dark" aria-label={t("copy.components_workflows_StrategyWorkflowHub.037")} placeholder={t("copy.components_workflows_StrategyWorkflowHub.038")} value={query} onChange={(event) => setQuery(event.target.value)} /><label><input type="checkbox" checked={allVersions} onChange={(event) => setAllVersions(event.target.checked)} />{t("copy.components_workflows_StrategyWorkflowHub.039")}</label><button className="btn btn-ghost" disabled={loading} onClick={() => { invalidateReadCache(); void load(); }}>{t("copy.components_workflows_StrategyWorkflowHub.040")}</button></div>
    {loading && !rows.length ? <p role="status">{t("copy.components_workflows_StrategyWorkflowHub.041")}</p> : visibleRows.length ? <div className={ui.directoryGrid}>
      {visibleRows.map((row) => <article className={ui.directoryCard} key={row.key} data-testid="strategy-directory-card">
        <button type="button" className={ui.directoryCardMain} onClick={() => void select(row)} aria-label={t("copy.components_workflows_StrategyWorkflowHub.042") + row.title}>
          <div className={ui.directoryCardMeta}><ModePill mode={row.mode} /><span>{stateLabel(row.state, t)}</span></div>
          <h2>{row.title}</h2><p>{row.description || t("copy.components_workflows_StrategyWorkflowHub.043")}</p>
          <div className={ui.directoryCardFacts}><span>{row.counts.script || 0} {t("copy.components_workflows_StrategyWorkflowHub.044")}</span><span>{row.counts.agent || 0} Agent</span><span>{row.markets?.join(" · ")}</span></div>
          {row.error && <p className="text-danger">{row.error}</p>}
          <span className={ui.directoryCardOpen}>{strategyLanding(row.status, false, row.proposal_id) === "performance" ? wx("runtime") : t("copy.components_workflows_StrategyWorkflowHub.045")} <NeryaGlyph name="arrowRight" size={16} /></span>
        </button>
        <footer><button type="button" onClick={() => void select(row, true)}>{transfer("edit")}</button><StrategyExportButton strategyId={row.strategy_id} proposalId={row.proposal_id} disabled={!!row.error} /><button disabled={managing} onClick={() => void manage("rename", { strategyId: row.strategy_id, proposalId: row.proposal_id })}>{t("copy.components_workflows_StrategyWorkflowHub.046")}</button><button disabled={managing} onClick={() => void manage("delete", { strategyId: row.strategy_id, proposalId: row.proposal_id })}>{row.proposal_id ? t("copy.components_workflows_StrategyWorkflowHub.047") : t("copy.components_workflows_StrategyWorkflowHub.048")}</button>{allVersions && row.proposal_id && <small>{row.proposal_id}</small>}</footer>
      </article>)}
    </div> : <div className={ui.empty}><p>{rows.length ? t("copy.components_workflows_StrategyWorkflowHub.049") : t("copy.components_workflows_StrategyWorkflowHub.050")}</p><p className={ui.muted}>{rows.length ? t("copy.components_workflows_StrategyWorkflowHub.051") : t("copy.components_workflows_StrategyWorkflowHub.052")}</p></div>}
  </section>;
  return <div className={selection ? ui.hub : undefined} data-testid="workflow-native-hub">
    <div className={ui.workspace}>
      {sourceSession&&<Link className="inline-block min-h-11 px-6 py-3 text-sm underline" href={"/chat/"+encodeURIComponent(sourceSession)}>{wx("conversation")}</Link>}
      {error && <div className={styles.errorBanner} role="alert">{error}<button onClick={() => { invalidateReadCache(); void load(); }}>{t("copy.components_workflows_StrategyWorkflowHub.053")}</button></div>}
      {selection ? <><Link className="inline-block px-6 pt-4 text-sm text-brand-400" href="/strategies">← {t("copy.components_workflows_StrategyWorkflowHub.054")}</Link><StrategyWorkflowPanel key={selection.strategyId + ":" + selectionEpoch} strategyId={selection.strategyId} proposalId={selection.proposalId} onDirtyChange={setDirty} onSaved={onSaved} renderTitle={renderTitle} headerActions={management} /></> : directory}
    </div>
  </div>;
}
