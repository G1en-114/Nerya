"use client";
import { Icon as NeryaGlyph } from "../icons";

import { ChoiceSelect } from "../ChoiceSelect";

import { useId, useState, type ReactNode } from "react";
import { sourceDimension, sourceTypeLabel, updateSourceDimension, type SourceConfig } from "../../lib/workflowSources";
import { WorkflowHelp } from "./WorkflowNative";
import { useWorkflowText } from "./WorkflowCanvas";
import styles from "./WorkflowStudio.module.css";
import ui from "./WorkflowSourceSettings.module.css";

function Values({ label, values, onChange, disabled, options = [], placeholder }: { label: string; values: string[]; onChange: (values: string[]) => void; disabled: boolean; options?: string[]; placeholder: string }) {
  const t = useWorkflowText(), id = useId();
  const [draft, setDraft] = useState("");
  const commit = () => { const tokens = draft.split(/[\s,，;；]+/).filter(Boolean); if (tokens.length) onChange([...new Set([...values, ...tokens])]); setDraft(""); };
  return <fieldset className={ui.values}><legend>{label}</legend><div className={ui.tokenInput}>
    {values.map((value) => <span className={ui.token} key={value}>{value}<button type="button" aria-label={`${t("copy.components_workflows_WorkflowSourceSettings.001")} ${value}`} disabled={disabled} onClick={() => onChange(values.filter((v) => v !== value))}><NeryaGlyph name="x" size={14} /></button></span>)}
    <input aria-label={label} value={draft} disabled={disabled} placeholder={placeholder} list={options.length ? id : undefined} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); commit(); } }} />
    {options.length > 0 && <datalist id={id}>{options.filter((option) => !values.includes(option)).map((option) => <option value={option} key={option} />)}</datalist>}
  </div>{options.length > 0 && <div className={ui.presets}>{options.filter((option) => !values.includes(option)).slice(0, 7).map((option) => <button key={option} type="button" disabled={disabled} onClick={() => onChange([...values, option])}><NeryaGlyph name="plus" size={14} /> {option}</button>)}</div>}</fieldset>;
}

export function WorkflowSourceSettings({ config, disabled, onChange, markets = [], parameters }: { config: SourceConfig; disabled: boolean; onChange: (config: SourceConfig) => void; markets?: string[]; parameters?: ReactNode }) {
  const t = useWorkflowText();
  const provider = String(config.provider || "runtime.market"), capability = String(config.capability || "candles");
  const news = provider === "runtime.news";
  const selected = sourceDimension(config, "markets", "market", markets);
  const frames = sourceDimension(config, "timeframes", "timeframe", ["1m"]);
  const inheritMarkets = config.markets === undefined && config.market === undefined;
  const matrix = "markets" in config || "timeframes" in config;
  const choices = news ? ["news"] : ["candles", "features", "ticker"];
  function setType(type: string) { const next: SourceConfig = { ...config, capability: type }; if (type === "ticker") { delete next.timeframe; delete next.timeframes; } onChange(next); }
  return <div className={styles.settingsStack} data-testid="workflow-source-settings">
    <div className={ui.topline}><span>{provider === "runtime.market" ? t("copy.components_workflows_WorkflowSourceSettings.002") : news ? t("copy.components_workflows_WorkflowSourceSettings.003") : provider}</span><WorkflowHelp label={t("copy.components_workflows_WorkflowSourceSettings.004")}><p>{t("copy.components_workflows_WorkflowSourceSettings.005")}</p><p>{t("copy.components_workflows_WorkflowSourceSettings.006")}</p></WorkflowHelp></div>
    <label className={styles.field}>{t("copy.components_workflows_WorkflowSourceSettings.007")}<ChoiceSelect aria-label={t("copy.components_workflows_WorkflowSourceSettings.008")} disabled={disabled} value={capability} onValueChange={setType}>{!choices.includes(capability) && <option value={capability}>{capability}</option>}{choices.map((v) => <option key={v} value={v}>{sourceTypeLabel(v, t)}</option>)}</ChoiceSelect></label>
    {news ? <Values label={t("copy.components_workflows_WorkflowSourceSettings.009")} values={sourceDimension(config, "sources", "source")} onChange={(sources) => onChange({ ...config, sources })} disabled={disabled} placeholder={t("copy.components_workflows_WorkflowSourceSettings.010")} /> : <>
      <Values label={t("copy.components_workflows_WorkflowSourceSettings.011")} values={selected} options={markets} disabled={disabled} placeholder={t("copy.components_workflows_WorkflowSourceSettings.012")} onChange={(values) => onChange(updateSourceDimension(config, "markets", "market", values))} />
      <label className={ui.inherit}><input type="checkbox" disabled={disabled} checked={inheritMarkets} onChange={(event) => { const next = { ...config }; if (event.target.checked) { delete next.market; delete next.markets; } else next.markets = [...selected]; onChange(next); }} />{t("copy.components_workflows_WorkflowSourceSettings.013")}</label>
      {capability !== "ticker" && <Values label={t("copy.components_workflows_WorkflowSourceSettings.014")} values={frames} disabled={disabled} options={["1m", "5m", "15m", "1h", "4h", "1d"]} placeholder={t("copy.components_workflows_WorkflowSourceSettings.015")} onChange={(values) => onChange(updateSourceDimension(config, "timeframes", "timeframe", values))} />}
    </>}
    {capability !== "ticker" && <label className={styles.field}>{t("copy.components_workflows_WorkflowSourceSettings.016")}<input aria-label={t("copy.components_workflows_WorkflowSourceSettings.017")} type="number" min={1} step={1} disabled={disabled} value={typeof config.limit === "number" ? config.limit : config.limit === "" ? "" : news ? 50 : 100} onChange={(event) => onChange({ ...config, limit: event.target.value === "" ? "" : Number(event.target.value) })} /></label>}
    {!news && <p className={ui.summary}>{t("copy.components_workflows_WorkflowSourceSettings.018", { value0: selected.length, value1: capability === "ticker" ? t("copy.workflowSourceSettings.snapshotCount") : t("copy.workflowSourceSettings.timeframeCount", { count: frames.length }) })}<span>{matrix ? t("copy.components_workflows_WorkflowSourceSettings.019") : t("copy.components_workflows_WorkflowSourceSettings.020")}</span></p>}
    {parameters}
    <details className={ui.disclosure}><summary>{t("copy.components_workflows_WorkflowSourceSettings.021")}</summary><div className={styles.settingsStack}><label className={styles.field}>{t("copy.components_workflows_WorkflowSourceSettings.022")}<input disabled={disabled} value={provider} onChange={(event) => onChange({ ...config, provider: event.target.value })} /></label><label className={styles.field}>{t("copy.components_workflows_WorkflowSourceSettings.023")}<input disabled={disabled} value={capability} onChange={(event) => setType(event.target.value)} /></label><label className={styles.field}>{t("copy.components_workflows_WorkflowSourceSettings.024")}<textarea rows={2} disabled={disabled} value={Array.isArray(config.consumers) ? config.consumers.join("\n") : ""} onChange={(event) => onChange({ ...config, consumers: event.target.value.split("\n").filter(Boolean) })} /></label></div></details>
  </div>;
}
