"use client";

import { useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { workflowApi } from "../../lib/workflowApi";
import { toast } from "../../lib/dialogs";
import type { WorkflowView } from "../../lib/workflowTypes";
import { downloadStrategyBundle, MAX_BUNDLE_BYTES, parseStrategyBundle, STRATEGY_ID, type StrategyBundle } from "../../lib/strategyTransfer";
import { WorkflowEditorDialog } from "./WorkflowEditorDialog";
import ui from "./WorkflowNative.module.css";
import styles from "./WorkflowStudio.module.css";

export function StrategyExportButton({ strategyId, proposalId, revision, disabled = false, dirty = false }: {
  strategyId: string; proposalId?: string | null; revision?: string; disabled?: boolean; dirty?: boolean;
}) {
  const t = useTranslations("strategyTransfer");
  const [busy, setBusy] = useState(false);
  const exporting = useRef(false);
  async function download() {
    if (disabled || dirty || exporting.current) return;
    exporting.current = true; setBusy(true);
    try { downloadStrategyBundle(await workflowApi.export(strategyId, proposalId, revision)); }
    catch (reason) { toast({ message: reason instanceof Error ? reason.message : String(reason), tone: "error" }); }
    finally { exporting.current = false; setBusy(false); }
  }
  return <button type="button" className={ui.quietButton} data-testid="export-strategy" disabled={disabled || dirty || busy}
    title={dirty ? t("saveFirst") : t("exportHint")} onClick={() => void download()}>{busy ? t("exporting") : t("export")}</button>;
}

export function StrategyImportButton({ onImported, disabled = false }: { onImported: (view: WorkflowView) => void; disabled?: boolean }) {
  const t = useTranslations("strategyTransfer");
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [bundle, setBundle] = useState<StrategyBundle | null>(null);
  const [strategyId, setStrategyId] = useState("");
  const [filename, setFilename] = useState("");
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const transaction = useRef(false);
  const readVersion = useRef(0);
  const idValid = STRATEGY_ID.test(strategyId);
  function close() { if (!transaction.current) { readVersion.current++; setOpen(false); setReading(false); } }
  async function read(file?: File) {
    const version = ++readVersion.current;
    setBundle(null); setError(""); setFilename(file?.name || "");
    if (!file) { setReading(false); return; }
    setReading(true);
    try {
      if (file.size > MAX_BUNDLE_BYTES) throw new Error("tooLarge");
      const parsed = parseStrategyBundle(await file.text());
      if (version !== readVersion.current) return;
      const suffix = Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      setBundle(parsed); setStrategyId(`${parsed.strategy_id.slice(0, 100)}_copy_${suffix}`);
    } catch (reason) {
      if (version === readVersion.current) setError(t(reason instanceof Error && reason.message === "tooLarge" ? "tooLarge" : "invalidBundle"));
    } finally { if (version === readVersion.current) setReading(false); }
  }
  async function submit() {
    if (!bundle || !idValid || reading || transaction.current) return;
    transaction.current = true; setBusy(true); setError("");
    try {
      const result = await workflowApi.import(bundle, strategyId);
      setOpen(false); setBundle(null);
      toast({ message: t("imported"), tone: "ok" });
      onImported(result.workflow);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message.includes("strategy_id_conflict") ? t("conflict") : message);
    } finally { transaction.current = false; setBusy(false); }
  }
  return <>
    <button type="button" className="btn btn-ghost" data-testid="import-strategy" disabled={disabled} onClick={() => {
      setBundle(null); setFilename(""); setStrategyId(""); setError(""); setOpen(true);
    }}>{t("import")}</button>
    <WorkflowEditorDialog open={open} title={t("importTitle")} onClose={close} footer={<>
      <button type="button" className={ui.quietButton} disabled={busy} onClick={close}>{t("cancel")}</button>
      <span className={ui.spacer} />
      <button type="submit" form={formId} className={ui.reviewButton} disabled={!bundle || !idValid || busy || reading}>
        {busy ? t("importing") : t("confirmImport")}
      </button>
    </>}>
      <form id={formId} className={ui.inspectorBody} data-testid="strategy-import-form" aria-busy={busy || reading} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <h2>{t("importTitle")}</h2><p className={ui.muted}>{t("importHint")}</p>
        <label className={styles.field}>{t("file")}<input type="file" accept=".json,application/json" disabled={busy} onChange={(event) => void read(event.target.files?.[0])} /></label>
        {reading && <p role="status">{t("reading")}</p>}
        {error && <div className={styles.errorBanner} role="alert">{error}</div>}
        {bundle && <>
          <p><strong>{bundle.title || bundle.strategy_id}</strong><br /><span className={ui.muted}>{filename} · {t("fileCount", { count: Object.keys(bundle.files).length })}</span></p>
          <label className={styles.field}>{t("newId")}<input value={strategyId} maxLength={128} disabled={busy} aria-invalid={!idValid} autoComplete="off" onChange={(event) => setStrategyId(event.target.value.trim())} /></label>
          {!idValid && <p role="alert">{t("invalidId")}</p>}
          <details><summary>{t("contents")}</summary><pre className="max-h-48 overflow-auto text-xs">{Object.keys(bundle.files).join("\n")}</pre></details>
          <p className={styles.notice}>{t("safety")}</p>
        </>}
      </form>
    </WorkflowEditorDialog>
  </>;
}
