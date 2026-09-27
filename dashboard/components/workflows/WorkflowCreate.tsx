"use client";
import { Icon as NeryaGlyph } from "../icons";

import { useRef } from "react";
import { WorkflowEditorDialog } from "./WorkflowEditorDialog";
import { useWorkflowText } from "./WorkflowCanvas";
import ui from "./WorkflowNative.module.css";
import styles from "./WorkflowVerification.module.css";

/** Examples fill editable human requests. They never generate strategy code. */
export function WorkflowCreate({ prompt, onChange, onClose, onContinue }: {
  prompt: string; onChange: (text: string) => void; onClose: () => void; onContinue: () => void;
}) {
  const t = useWorkflowText();
  const input = useRef<HTMLTextAreaElement>(null);
  const examples = [
    [t("copy.components_workflows_WorkflowCreate.001"), t("copy.components_workflows_WorkflowCreate.002")],
    [t("copy.components_workflows_WorkflowCreate.003"), t("copy.components_workflows_WorkflowCreate.004")],
    [t("copy.components_workflows_WorkflowCreate.005"), t("copy.components_workflows_WorkflowCreate.006")],
  ];
  return <WorkflowEditorDialog open title={t("copy.components_workflows_WorkflowCreate.007")} onClose={onClose} footer={<><span className={ui.muted}>{t("copy.components_workflows_WorkflowCreate.008")}</span><span className={ui.spacer} /><button type="button" className={ui.reviewButton} disabled={!prompt.trim()} onClick={onContinue}>{t("copy.components_workflows_WorkflowCreate.009")} <NeryaGlyph name="arrowRight" size={16} /></button></>}>
    <section className={styles.root} data-testid="workflow-create"><header className={styles.heading}><div><h2>{t("copy.components_workflows_WorkflowCreate.010")}</h2><p>{t("copy.components_workflows_WorkflowCreate.011")}</p></div><button className={ui.iconButton} type="button" aria-label={t("copy.components_workflows_WorkflowCreate.012")} onClick={onClose}><NeryaGlyph name="x" size={18} /></button></header>
      <textarea ref={input} className={styles.prompt} aria-label={t("copy.components_workflows_WorkflowCreate.013")} placeholder={t("copy.components_workflows_WorkflowCreate.014")} rows={4} maxLength={5000} value={prompt} onChange={(event) => onChange(event.target.value)} />
      <p className={styles.exampleHint}>{t("copy.components_workflows_WorkflowCreate.015")}</p><div className={styles.examples}>{examples.map(([label, text]) => <button type="button" key={label} onClick={() => { onChange(text); input.current?.focus(); }}><span>{label}</span><NeryaGlyph name="arrowUpRight" size={16} /></button>)}</div>
      <p className={styles.note}>{t("copy.components_workflows_WorkflowCreate.016")}</p>
    </section>
  </WorkflowEditorDialog>;
}
