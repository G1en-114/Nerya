"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { parseScriptDocumentation } from "../../lib/scriptDocumentation";
import type { WorkflowGraph } from "../../lib/workflowTypes";
import { WorkflowCanvas } from "./WorkflowCanvas";
import styles from "./WorkflowReplay.module.css";

export function ScriptExplanation({ source, fallback }: { source: string; fallback?: string }) {
  const t = useTranslations("workflowExperience");
  const doc = useMemo(() => parseScriptDocumentation(source), [source]);
  const [selected, setSelected] = useState("");
  const step = doc.steps.find((item) => item.id === selected) || doc.steps[0];
  const graph = useMemo<WorkflowGraph>(() => ({
    id: "script-documentation",
    nodes: doc.steps.map((item, index) => ({ id: item.id, kind: "script", title: item.title, description: item.description, subtitle: "", resource: item.id, config: {}, binding: { file: null, path: null }, editable: false, position: { x: index * 320, y: 40 }, presentation: { summary: t("sourceLine", { line: item.line }) } })),
    edges: doc.steps.flatMap((item) => item.next.filter((next) => doc.steps.some((target) => target.id === next.id)).map((next, index) => ({ id: `${item.id}:${index}`, source: item.id, target: next.id, relation: "annotation", origin: "annotation" as const, label: next.condition }))),
  }), [doc, t]);
  function facts(value: { inputs: string[]; outputs: string[]; risks: string[] }) {
    return <dl className={styles.facts}>{(["inputs", "outputs", "risks"] as const).map((key) => value[key].length > 0 && <div key={key}><dt>{t(key)}</dt><dd>{value[key].map((text, index) => <p key={index}>{text}</p>)}</dd></div>)}</dl>;
  }
  return <section className={styles.explanation} data-testid="script-explanation" aria-label={t("explanation")}>
    <header><span className={styles.eyebrow}>{t("explanation")}</span>{doc.title && <h4>{doc.title}</h4>}<p>{doc.description || fallback || t("undocumented")}</p></header>
    {doc.logic && doc.logic !== doc.description && <section><h4>{t("logic")}</h4><p>{doc.logic}</p></section>}
    {doc.rationale && <section><h4>{t("rationale")}</h4><p>{doc.rationale}</p></section>}
    {doc.scope.length > 0 && <section><h4>{t("scope")}</h4><ul className={styles.proseList}>{doc.scope.map((value, index) => <li key={index}>{value}</li>)}</ul></section>}
    {doc.changes.length > 0 && <section><h4>{t("changes")}</h4><ol className={styles.changeList}>{doc.changes.map((change, index) => <li key={index}><strong>{change.target}</strong><dl className={styles.facts}><div><dt>{t("before")}</dt><dd>{change.before}</dd></div><div><dt>{t("after")}</dt><dd>{change.after}</dd></div><div><dt>{t("rationale")}</dt><dd>{change.reason}</dd></div></dl></li>)}</ol></section>}
    {facts(doc)}
    {step && <section className={styles.logicSection}><h4>{t("logicSteps")}</h4>
      <div className={styles.logicCanvas} data-testid="script-logic-graph"><WorkflowCanvas graph={graph} selectedId={step.id} onSelect={(node) => setSelected(node.id)} /></div>
      <nav className={styles.stepNavigation} aria-label={t("logicSteps")}>{doc.steps.map((item, index) => <button key={item.id} type="button" aria-pressed={item.id === step.id} onClick={() => setSelected(item.id)}>{index + 1}. {item.title}</button>)}</nav>
      <div className={styles.stepDetail}><h4>{step.title}</h4>{step.description && <p>{step.description}</p>}{facts(step)}
        {step.next.map((next, index) => <p className={styles.branch} key={index}>↳ {next.condition ? `${next.condition} → ` : ""}{doc.steps.find((target) => target.id === next.id)?.title || next.id}</p>)}
        <small className={styles.note}>{t("sourceLine", { line: step.line })}</small>
      </div>
    </section>}
    {doc.validation.length > 0 && <section><h4>{t("validation")}</h4><ul className={styles.proseList}>{doc.validation.map((value, index) => <li key={index}>{value}</li>)}</ul></section>}
    <p className={styles.note}>{t("documentationOnly")}</p>
    {doc.warnings > 0 && <p role="status" className="text-warn">{t("annotationWarnings", { count: doc.warnings })}</p>}
  </section>;
}
