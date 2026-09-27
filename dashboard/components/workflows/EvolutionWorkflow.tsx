"use client";
import { Icon as NeryaGlyph } from "../icons";

import { ChoiceSelect } from "../ChoiceSelect";
import { useTranslations } from "next-intl";
import { ReviewExplanation } from "./ReviewExplanation";
import { ReplayEvidence } from "./ReplayEvidence";
import { timelineReview } from "../../lib/reviewExplanation";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { EvolutionTimelineEnvelope, EvolutionTimelineItem } from "../../lib/evolutionTypes";
import type { WorkflowGraph, WorkflowKind, WorkflowNode, WorkflowSummary, WorkflowView } from "../../lib/workflowTypes";
import { workflowApi } from "../../lib/workflowApi";
import { invalidateReadCache } from "../../lib/clientApi";
import { stateLabel } from "../../lib/workflowPresentation";
import { WorkflowCanvas, WorkflowIcon, useWorkflowText } from "./WorkflowCanvas";
import { StrategyWorkflowPanel, confirmDiscard } from "./StrategyWorkflowPanel";
import styles from "./WorkflowStudio.module.css";

function traceGraph(item: EvolutionTimelineItem | null, t: import("../../lib/i18n").ResourceTranslator): WorkflowGraph {
  const sections = item?.process?.sections || [];
  if (sections.length) {
    const nodes: WorkflowNode[] = sections.map((section, index) => {
      const kind: WorkflowKind = /prompt|agent|reflect/.test(section.id) ? "agent" : /valid/.test(section.id) ? "validation" : /output|document/.test(section.id) ? "proposal" : /change|apply/.test(section.id) ? "apply" : "evidence";
      return { id: `trace:${section.id}`, kind, title: section.title, subtitle: section.summary || `${section.artifacts.length} ${t("copy.components_workflows_EvolutionWorkflow.001")}`, resource: section.id,
        position: { x: (index % 4) * 320 + 30, y: Math.floor(index / 4) * 230 + 80 },
        binding: { file: null, path: null }, editable: false, config: section,
        status: section.artifacts.length ? t("copy.components_workflows_EvolutionWorkflow.002") : t("copy.components_workflows_EvolutionWorkflow.003") };
    });
    return { id: `trace:${item?.id}`, nodes, edges: nodes.slice(1).map((node, index) => ({ id: `trace-edge:${index}`, source: nodes[index].id, target: node.id, relation: "record_order", origin: "manifest", label: t("copy.components_workflows_EvolutionWorkflow.004") })) };
  }
  const stages: Array<[WorkflowKind, string, string]> = [
    ["evidence", "signal", "copy.evolutionStages.signal"], ["agent", "reflection", "copy.evolutionStages.reflection"],
    ["proposal", "proposal", "copy.evolutionStages.proposal"], ["validation", "validation", "copy.evolutionStages.validation"],
    ["approval", "approval", "copy.evolutionStages.approval"], ["apply", "outcome", "copy.evolutionStages.outcome"],
    ["observation", "asset", "copy.evolutionStages.asset"],
  ];
  const nodes: WorkflowNode[] = stages.map(([kind, stage, title], index) => ({ id: `stage:${stage}`, kind, title: t(title), resource: stage,
    subtitle: item?.stage === stage ? item.summary || item.title : t("copy.components_workflows_EvolutionWorkflow.005"),
    status: item?.stage === stage ? item.status : t("copy.components_workflows_EvolutionWorkflow.006"),
    position: { x: (index < 4 ? index : 6 - index) * 320 + 30, y: index < 4 ? 70 : 320 },
    config: item?.stage === stage ? item : { description: t("copy.components_workflows_EvolutionWorkflow.007") },
    editable: false, binding: { file: null, path: null },
  }));
  return { id: `evolution:${item?.id || "definition"}`, nodes, edges: nodes.slice(1).map((node, index) => ({ id: `stage-edge:${index}`, source: nodes[index].id, target: node.id, origin: "manifest", relation: "process", label: t("copy.components_workflows_EvolutionWorkflow.008") })) };
}

export function EvolutionWorkflow({ envelope, onOpenRecord, onOpenSettings, onDirtyChange }: {
  envelope: EvolutionTimelineEnvelope | null; onOpenRecord: (id: string) => void; onOpenSettings: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const t = useWorkflowText();
  const wx = useTranslations("workflowExperience");
  const [mode, setMode] = useState<"strategy" | "records">("strategy");
  const [rows, setRows] = useState<WorkflowSummary[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [recordId, setRecordId] = useState("");
  const [node, setNode] = useState<WorkflowNode | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  function saved(value: WorkflowView) {
    const key = `${value.strategy_id}:${value.source.proposal_id || "published"}`;
    const previous = rows.find((row) => row.key === selectedKey);
    if (previous) setRows((current) => [...current.filter((row) => row.key !== key), { ...previous, key, proposal_id: value.source.proposal_id, state: value.source.state, title: String(value.manifest.title || value.strategy_id) }]);
    setSelectedKey(key); setDirty(false);
  }
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    void workflowApi.list().then((result) => {
      if (!active) return;
      const valid = result.workflows.filter((item) => !item.error);
      setRows(valid);
      setSelectedKey((current) => valid.some((item) => item.key === current) ? current : valid[0]?.key || "");
    }).catch((reason) => { if (active) setError(String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reload]);
  const selected = rows.find((row) => row.key === selectedKey);
  const items = envelope?.timeline || [];
  const record = items.find((item) => item.id === recordId) || items.find((item) => (item.process?.sections.length || 0) > 0) || items[0] || null;
  const graph = useMemo(() => traceGraph(record, t), [record, t]);
  async function switchMode(next: "strategy" | "records") {
    if (mode === next) return;
    if (dirty && !await confirmDiscard(t("copy.components_workflows_EvolutionWorkflow.009"))) return;
    setDirty(false); setMode(next); setNode(null);
  }
  return <section className={styles.evolution}>
    <div className={styles.evolutionTop}><div className={styles.tabs} role="tablist" aria-label={t("copy.components_workflows_EvolutionWorkflow.010")}><button role="tab" aria-selected={mode === "strategy"} onClick={() => void switchMode("strategy")}><WorkflowIcon kind="observation" size={16} />{t("copy.components_workflows_EvolutionWorkflow.011")}</button><button role="tab" aria-selected={mode === "records"} onClick={() => void switchMode("records")}><WorkflowIcon kind="evidence" size={16} />{t("copy.components_workflows_EvolutionWorkflow.012")}</button></div><span className={styles.toolbarSpacer} /><button className={styles.secondaryButton} onClick={onOpenSettings}>{t("copy.components_workflows_EvolutionWorkflow.013")}</button></div>
    {error && <div role="alert" className={styles.errorBanner}><span>{t("copy.components_workflows_EvolutionWorkflow.014")}</span><button type="button" disabled={loading} onClick={() => { invalidateReadCache(); setReload((value) => value + 1); }}>{t("copy.components_workflows_EvolutionWorkflow.015")}</button><details><summary>{t("copy.components_workflows_EvolutionWorkflow.016")}</summary>{error}</details></div>}
    {mode === "strategy" ? <>{loading ? <div className={styles.loading} role="status" data-testid="evolution-workflows-loading">{t("copy.components_workflows_EvolutionWorkflow.017")}</div> : error ? null : rows.length ? <><label className={styles.field}>{t("copy.components_workflows_EvolutionWorkflow.018")}<ChoiceSelect value={selectedKey} onValueChange={async (choiceValue) => { const value = choiceValue; if (!dirty || await confirmDiscard(t("copy.components_workflows_EvolutionWorkflow.019"))) { setDirty(false); setSelectedKey(value); } }}>{rows.map((row) => <option key={row.key} value={row.key}>{row.title} · {stateLabel(row.state, t)} · {row.proposal_id || t("copy.components_workflows_EvolutionWorkflow.020")}</option>)}</ChoiceSelect></label><div style={{ height: 16 }} />{selected && <StrategyWorkflowPanel key={selected.key} strategyId={selected.strategy_id} proposalId={selected.proposal_id} defaultView="evolution" onDirtyChange={setDirty} onSaved={saved} />}</> : <div className={styles.empty}>{t("copy.components_workflows_EvolutionWorkflow.021")} <Link className={styles.ownerLink} href="/strategies">{t("copy.components_workflows_EvolutionWorkflow.022")} <NeryaGlyph name="arrowUpRight" size={16} /></Link></div>}</> : <>
      <div className={styles.evolutionTop}><ChoiceSelect aria-label={t("copy.components_workflows_EvolutionWorkflow.023")} value={record?.id || ""} onValueChange={(choiceValue) => { setRecordId(choiceValue); setNode(null); }}>{items.length ? items.map((item) => <option key={item.id} value={item.id}>{item.ts} · {item.title} · {item.status}</option>) : <option value="">{t("copy.components_workflows_EvolutionWorkflow.024")}</option>}</ChoiceSelect><span className={styles.toolbarSpacer} />{record && <button className={styles.secondaryButton} onClick={() => onOpenRecord(record.id)}>{t("copy.components_workflows_EvolutionWorkflow.025")} <NeryaGlyph name="arrowUpRight" size={16} /></button>}</div>
      <div className={styles.notice}>{t("copy.components_workflows_EvolutionWorkflow.026")}</div><div style={{ height: 12 }} />
      {record && <ReviewExplanation {...timelineReview(record)} status={record.status} />}
      <div className={`${styles.studio} ${styles.canvasLayout} ${node ? styles.withInspector : ""}`}><WorkflowCanvas graph={graph} selectedId={node?.id} onSelect={setNode} />{node && <aside className={styles.inspector}><header className={styles.inspectorHeader}><WorkflowIcon kind={node.kind} /><h3>{node.title}</h3><button aria-label={t("copy.components_workflows_EvolutionWorkflow.027")} onClick={() => setNode(null)}><NeryaGlyph name="x" size={18} /></button></header><div className={styles.inspectorBody}><p className={styles.notice}>{node.subtitle}</p><span className={styles.stateTag}>{node.status}</span><details className="mt-4"><summary>{wx("technicalDetails")}</summary><ReplayEvidence value={node.config} /></details>{record && <button className={styles.secondaryButton} onClick={() => onOpenRecord(record.id)}>{t("copy.components_workflows_EvolutionWorkflow.028")}</button>}</div></aside>}</div>
    </>}
  </section>;
}
