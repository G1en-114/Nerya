"use client";
import { Icon as NeryaGlyph } from "../icons";

import { useEffect, useState } from "react";
import { workflowApi } from "../../lib/workflowApi";
import { asObject } from "../../lib/workflowPresentation";
import { sourceSummary } from "../../lib/workflowSources";
import { replayLabel, verificationSummary, exportVerification, type Verification } from "../../lib/workflowVerification";
import type { WorkflowView } from "../../lib/workflowTypes";
import { useWorkflowText } from "./WorkflowCanvas";
import { WorkflowEditorDialog } from "./WorkflowEditorDialog";
import ui from "./WorkflowNative.module.css";
import styles from "./WorkflowVerification.module.css";

const scalar = (value: unknown, absent: string) => value === undefined || value === null ? absent : String(value);
export function WorkflowVerification({ workflow, onClose, onEdit }: {
  workflow: WorkflowView; onClose: () => void; onEdit: (where: string) => void;
}) {
  const t = useWorkflowText();
  const [result, setResult] = useState<Verification | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let disposed = false;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 20000);
    setLoading(true); setError(""); setResult(null);
    void workflowApi.check(workflow.strategy_id, workflow.source.proposal_id, workflow.revision, abort.signal).then((value) => {
      if (disposed || abort.signal.aborted) return;
      if (value.target.revision !== workflow.revision) throw new Error("revision_conflict");
      setResult(value);
    }).catch((reason) => { if (disposed) return; setError(abort.signal.aborted ? t("copy.components_workflows_WorkflowVerification.001") : String(reason)); }).finally(() => { clearTimeout(timeout); if (!disposed) setLoading(false); });
    return () => { disposed = true; clearTimeout(timeout); abort.abort(); };
  }, [workflow.strategy_id, workflow.source.proposal_id, workflow.revision, refresh]); // parent callbacks deliberately do not retrigger network work
  const m = asObject(result?.replay.metrics), provenance = asObject(result?.replay.provenance);
  const datasets = Array.isArray(provenance.datasets) ? provenance.datasets.map(asObject) : [];
  const absent = t("copy.components_workflows_WorkflowVerification.002");
  const operation = ({ candidate: t("copy.components_workflows_WorkflowVerification.003"), not_installed: t("copy.components_workflows_WorkflowVerification.004"), paused: t("copy.components_workflows_WorkflowVerification.005"), scheduled: t("copy.components_workflows_WorkflowVerification.006"), unknown: t("copy.components_workflows_WorkflowVerification.007") } as Record<string, string>)[result?.operation.state || "unknown"];
  return <WorkflowEditorDialog open title={t("copy.components_workflows_WorkflowVerification.008")} onClose={onClose} footer={<><button type="button" className={ui.quietButton} disabled={!result || loading} onClick={() => result && exportVerification(result)}>{t("copy.components_workflows_WorkflowVerification.009")}</button><span className={ui.spacer} /><button type="button" className={ui.quietButton} disabled={loading} onClick={() => setRefresh((n) => n + 1)}>{t("copy.components_workflows_WorkflowVerification.010")}</button><button type="button" className={ui.quietButton} onClick={onClose}>{t("copy.components_workflows_WorkflowVerification.011")}</button></>}>
    <section className={styles.root} data-testid="workflow-verification" aria-busy={loading}>
      <header className={styles.heading}><div><h2>{t("copy.components_workflows_WorkflowVerification.012")}</h2><p>{String(workflow.manifest.title || workflow.strategy_id)} · {workflow.source.proposal_id ? t("copy.components_workflows_WorkflowVerification.013") : t("copy.components_workflows_WorkflowVerification.014")}</p></div><button type="button" className={ui.iconButton} aria-label={t("copy.components_workflows_WorkflowVerification.015")} onClick={onClose}><NeryaGlyph name="x" size={18} /></button></header>
      {loading ? <p className={styles.pending} role="status">{t("copy.components_workflows_WorkflowVerification.016")}</p> : error ? <div role="alert" className={styles.error}><h3>{t("copy.components_workflows_WorkflowVerification.017")}</h3><p>{error.includes("revision_conflict") ? t("copy.components_workflows_WorkflowVerification.018") : error}</p></div> : result && <>
        <p className={styles.lead} role="status">{verificationSummary(result, t)}</p>
        <div className={styles.stages}>
          <div><span className={styles.mark} data-tone={result.validation.ok ? "ok" : "error"}><NeryaGlyph name={result.validation.ok ? 'check' : 'warning'} size={16} /></span><div><strong>{t("copy.components_workflows_WorkflowVerification.019")}</strong><small>{t("copy.components_workflows_WorkflowVerification.020")}</small></div><span>{result.validation.ok ? t("copy.components_workflows_WorkflowVerification.021") : t("copy.components_workflows_WorkflowVerification.022", { value0: result.validation.blockers.length })}</span></div>
          <div><span className={styles.mark} data-tone={result.replay.status === "verified" ? "ok" : "pending"}><NeryaGlyph name={result.replay.status === 'verified' ? 'check' : 'circle'} size={16} /></span><div><strong>{result.evaluation_mode === "observation" ? t("copy.components_workflows_WorkflowVerification.023") : t("copy.components_workflows_WorkflowVerification.024")}</strong><small>{result.evaluation_mode === "observation" ? t("copy.components_workflows_WorkflowVerification.025") : t("copy.components_workflows_WorkflowVerification.026")}</small></div><span>{replayLabel(result.replay.status, t)}</span></div>
          <div><span className={styles.mark} data-tone="pending"><NeryaGlyph name="circle" size={16} /></span><div><strong>{t("copy.components_workflows_WorkflowVerification.027")}</strong><small>{operation}</small></div><span>{t("copy.components_workflows_WorkflowVerification.028")}</span></div>
        </div>
        {result.validation.blockers.length > 0 && <section className={styles.issues} aria-label={t("copy.components_workflows_WorkflowVerification.029")}>{result.validation.blockers.map((issue, i) => <div key={i}><strong>{issue.code}</strong><p>{issue.message}</p>{issue.where && <button type="button" className={ui.quietButton} onClick={() => onEdit(issue.where || "")}>{t("copy.components_workflows_WorkflowVerification.030")} {issue.where} <NeryaGlyph name="arrowRight" size={16} /></button>}</div>)}</section>}
        {result.replay.id && <section className={styles.replay}>
          <div className={styles.replayTitle}><h3>{t("copy.components_workflows_WorkflowVerification.031")}</h3><span>{provenance.data_kind === "sample" ? t("copy.components_workflows_WorkflowVerification.032") : provenance.data_kind === "historical" ? t("copy.components_workflows_WorkflowVerification.033") : t("copy.components_workflows_WorkflowVerification.034")} · {scalar(m.verdict, absent)}</span></div>
          <dl><div><dt>{t("copy.components_workflows_WorkflowVerification.035")}</dt><dd>{scalar(m.requested_primary_timeframe, absent)} → {scalar(m.tf, absent)}</dd></div><div><dt>{t("copy.components_workflows_WorkflowVerification.036")}</dt><dd>{scalar(m.requested_window_days, absent)} / {typeof m.backtest_days === "number" ? m.backtest_days.toFixed(2) : absent}</dd></div><div><dt>{t("copy.components_workflows_WorkflowVerification.037")}</dt><dd>{scalar(m.start_utc, absent)} — {scalar(m.end_utc, absent)}</dd></div>{result.evaluation_mode === "observation" ? <div><dt>{t("copy.components_workflows_WorkflowVerification.038")}</dt><dd>{scalar(asObject(m.replay).observations_or_dispatches, absent)} / {scalar(asObject(asObject(m.replay).status_counts).skip, absent)}</dd></div> : <><div><dt>{t("copy.components_workflows_WorkflowVerification.039")}</dt><dd>{m.total_return_pct === undefined ? absent : `${m.total_return_pct}%`} / {m.max_drawdown_pct === undefined ? absent : `${m.max_drawdown_pct}%`}</dd></div><div><dt>{t("copy.components_workflows_WorkflowVerification.040")}</dt><dd>{scalar(m.total_fees_usd, absent)} / {scalar(m.total_slippage_usd, absent)} USD</dd></div></>}</dl>
          {(result.replay.status !== "verified" || Boolean(m.coverage_message)) && <p className={styles.note}>{result.replay.status === "stale" ? t("copy.components_workflows_WorkflowVerification.041") : result.replay.status === "unbound" ? t("copy.components_workflows_WorkflowVerification.042") : provenance.data_kind === "sample" ? t("copy.components_workflows_WorkflowVerification.043") : scalar(m.coverage_message, t("copy.components_workflows_WorkflowVerification.044"))}</p>}
        </section>}
        <details className={styles.details}><summary>{t("copy.components_workflows_WorkflowVerification.045")}</summary>
          <p className={styles.note}>{t("copy.components_workflows_WorkflowVerification.046")}</p>
          <div className={styles.tableWrap}><table><thead><tr><th>{t("copy.components_workflows_WorkflowVerification.047")}</th><th>{t("copy.components_workflows_WorkflowVerification.048")}</th></tr></thead><tbody>{result.sources.map((source, index) => <tr key={String(source.id || index)}><td>{String(source.title || source.id)}<small>{String(source.provider || "")}</small></td><td>{sourceSummary(source, t)}</td></tr>)}</tbody></table></div>
          {datasets.length > 0 && <div className={styles.tableWrap}><table><thead><tr><th>{t("copy.components_workflows_WorkflowVerification.049")}</th><th>{t("copy.components_workflows_WorkflowVerification.050")}</th><th>{t("copy.components_workflows_WorkflowVerification.051")}</th></tr></thead><tbody>{datasets.map((d, index) => <tr key={index}><td>{String(d.market)} · {String(d.timeframe)}</td><td>{String(d.rows)}</td><td><code title={String(d.sha256)}>{String(d.sha256 || "").slice(0, 16)}</code></td></tr>)}</tbody></table></div>}
          <dl><div><dt>{t("copy.components_workflows_WorkflowVerification.052")}</dt><dd><code>{result.target.source_revision}</code></dd></div><div><dt>{t("copy.components_workflows_WorkflowVerification.053")}</dt><dd>{result.target.proposal_id || t("copy.components_workflows_WorkflowVerification.054")}</dd></div></dl>
          {Object.keys(asObject(provenance.assumptions)).length > 0 && <details className={styles.details}><summary>{t("copy.components_workflows_WorkflowVerification.055")}</summary><pre>{JSON.stringify(provenance.assumptions, null, 2)}</pre></details>}
          <p className={styles.note}>{t("copy.components_workflows_WorkflowVerification.056")}</p>
        </details>
        {(result.validation.warnings.length > 0 || result.report_warnings.length > 0) && <details className={styles.details}><summary>{t("copy.components_workflows_WorkflowVerification.057")} · {result.validation.warnings.length + result.report_warnings.length}</summary>{result.validation.warnings.map((w, i) => <p className={styles.note} key={i}>{w.message}</p>)}{result.report_warnings.map((w, i) => <p className={styles.note} key={i}>{w}</p>)}</details>}
      </>}
    </section>
  </WorkflowEditorDialog>;
}
