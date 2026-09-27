"use client";
import { Icon as NeryaGlyph } from "../icons";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ScriptExplanation } from "./ScriptExplanation";
import { readEditDraft, writeEditDraft } from "../../lib/editDrafts";
import type { WorkflowAddition } from "../../lib/workflowTypes";
import { WorkflowIcon, kindName, useWorkflowText } from "./WorkflowCanvas";
import styles from "./WorkflowStudio.module.css";
function scriptTemplate(t: (key: string) => string) { return `# @nerya.version 1
# @nerya.title ${t("templateTitle")}
# @nerya.description ${t("templateDescription")}
# @nerya.logic ${t("templateLogic")}
# @nerya.rationale ${t("templateRationale")}
# @nerya.scope ${t("templateScope")}
# @nerya.validation ${t("templateValidation")}
# @nerya.input ${t("templateInput")}
# @nerya.output ${t("templateOutput")}
# @nerya.risk ${t("templateRisk")}
def collect(ctx):
    # @nerya.step read | ${t("templateRead")} | ${t("templateReadDescription")}
    # @nerya.next publish
    rows = ctx.market.candles(ctx.config.markets[0], timeframe="1h", limit=40)
    # @nerya.step publish | ${t("templatePublish")} | ${t("templatePublishDescription")}
    return ctx.inputs.publish("observations", rows)
`; }
export function AddResource({ onAdd, onClose, seed, onDirtyChange, draftScope }: { onAdd: (resource: WorkflowAddition) => void; onClose: () => void; seed?: WorkflowAddition | null; onDirtyChange?: (dirty: boolean) => void; draftScope?:string }) {
  const t = useWorkflowText();
  const wx = useTranslations("workflowExperience");
  const [script] = useState(() => scriptTemplate(wx));
  const [saved] = useState(() => draftScope ? readEditDraft<{ kind:"script"|"agent"|null; name:string; text:string }>(draftScope) : null);
  const [kind, setKind] = useState<"script" | "agent" | null>(saved?.kind || (seed?.kind === "agent" ? "agent" : seed?.kind === "script" ? "script" : null));
  const [name, setName] = useState(saved?.name ?? seed?.name ?? "");
  const [text, setText] = useState(saved?.text ?? seed?.content ?? script);
  useEffect(() => { if (draftScope && kind) writeEditDraft(draftScope,{ kind,name,text }); },[draftScope,kind,name,text]);
  const [error, setError] = useState("");
  const changed = !!kind && (!!name.trim() || !!seed || text !== script);
  useEffect(() => { onDirtyChange?.(changed); }, [changed, onDirtyChange]);
  function choose(next: "script" | "agent") { setKind(next); setName(""); setError(""); setText(next === "agent" ? t("copy.components_workflows_AddWorkflowResource.001") : script); }
  return <aside className={styles.inspector} aria-label={t("copy.components_workflows_AddWorkflowResource.002")} data-testid="workflow-add-resource"><header className={styles.inspectorHeader}><h3>{seed ? t("copy.components_workflows_AddWorkflowResource.003") : t("copy.components_workflows_AddWorkflowResource.004")}</h3><button type="button" onClick={onClose} aria-label={t("copy.components_workflows_AddWorkflowResource.005")}><NeryaGlyph name="x" size={18} /></button></header>
    {!kind ? <div className={styles.inspectorBody}><p className={styles.inspectorIntro}>{t("copy.components_workflows_AddWorkflowResource.006")}</p>{(["script", "agent"] as const).map((item) => <button className={styles.addChoice} key={item} type="button" onClick={() => choose(item)}><WorkflowIcon kind={item} /><span><strong>{kindName(item, t)}</strong><small>{item === "script" ? t("copy.components_workflows_AddWorkflowResource.007") : t("copy.components_workflows_AddWorkflowResource.008")}</small></span><NeryaGlyph name="arrowRight" size={16} /></button>)}</div> : <form className={styles.inspectorBody} onSubmit={(event) => { event.preventDefault(); if (!name.trim()) { setError(t("copy.components_workflows_AddWorkflowResource.009")); return; } if (draftScope) writeEditDraft(draftScope,null); onAdd({ kind, name: name.trim(), content: text }); }}>
      {!seed && <button type="button" className={styles.textButton} onClick={() => setKind(null)}><NeryaGlyph name="arrowLeft" size={16} /> {t("copy.components_workflows_AddWorkflowResource.010")}</button>}
      <label className={styles.field}>{kind === "script" ? t("copy.components_workflows_AddWorkflowResource.011") : t("copy.components_workflows_AddWorkflowResource.012")}<input required maxLength={128} value={name} placeholder={kind === "script" ? "market_inputs.py" : "market_analyst"} onChange={(event) => setName(event.target.value)} /></label>
      {kind === "script" && <ScriptExplanation source={text} />}
      <details open={kind === "agent"}><summary>{kind === "script" ? wx("code") : t("copy.components_workflows_AddWorkflowResource.013")}</summary><label className={styles.field}>{kind === "agent" ? t("copy.components_workflows_AddWorkflowResource.013") : t("copy.components_workflows_AddWorkflowResource.014")}<textarea className={kind === "script" ? styles.codeEditor : undefined} rows={12} value={text} onChange={(event) => setText(event.target.value)} /></label></details>
      <p className={styles.helper}>{t("copy.components_workflows_AddWorkflowResource.015")}</p>
      {error && <p role="alert" className={styles.error}>{error}</p>}<button className={styles.primaryButton} type="submit">{t("copy.components_workflows_AddWorkflowResource.016")}</button>
    </form>}
  </aside>;
}
