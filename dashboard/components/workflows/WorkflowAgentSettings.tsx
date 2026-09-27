"use client";

import { ChoiceSelect } from "../ChoiceSelect";
import { SwitchControl } from "../SwitchControl";

import type { WorkflowNode } from "../../lib/workflowTypes";
import { asObject, cardTitle, withValue } from "../../lib/workflowPresentation";
import { useWorkflowText } from "./WorkflowCanvas";
import styles from "./WorkflowStudio.module.css";

export type AgentDefaults = { max_iterations?: number; max_tool_calls?: number; max_wall_seconds?: number; max_parallel?: number; tier?: string };
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
export function WorkflowAgentSettings({ config, nodes, defaults, disabled, onChange }: { config: Record<string, unknown>; nodes: WorkflowNode[]; defaults?: AgentDefaults; disabled: boolean; onChange: (value: Record<string, unknown>) => void }) {
  const t = useWorkflowText();
  const execution = asObject(config.agent_execution), context = asObject(config.agent_context), profile = asObject(config.agent_profile), team = asObject(execution.team);
  const session = asObject(config.agent_session);
  const sessionPolicy = String(session.policy || "per_strategy");
  const simpleSession = ["per_strategy", "per_signal"].includes(sessionPolicy) && session.include_prior_messages !== false;
  const allowed = strings(profile.allowed_tools);
  const capabilities = String(execution.capabilities || (allowed.length ? "custom" : "inherit"));
  const roles = nodes.filter((n) => n.kind === "agent" && n.id.startsWith("agent:role/"));
  const selectedRoles = strings(team.roles);
  const update = (path: string[], value: unknown) => onChange(withValue(config, path, value));
  const toggle = (values: string[], id: string, checked: boolean) => checked ? [...new Set([...values, id])] : values.filter((v) => v !== id);
  const budget = (key: keyof AgentDefaults, label: string) => <label key={key} className={styles.field}>{t(label)}<input type="number" min={1} step={1} aria-label={t(label)} value={typeof execution[key] === "number" ? String(execution[key]) : ""} disabled={disabled} placeholder={defaults?.[key] !== undefined ? t("copy.components_workflows_WorkflowAgentSettings.001", { value0: defaults[key] }) : t("copy.components_workflows_WorkflowAgentSettings.002")} onChange={(e) => update(["agent_execution", key], e.target.value === "" ? null : Number(e.target.value))} /></label>;
  return <div className={styles.settingsStack} data-testid="workflow-agent-settings">
    <label className={styles.field}>{t("copy.components_workflows_WorkflowAgentSettings.003")}<textarea rows={5} disabled={disabled} value={String(profile.role || "")} onChange={(e) => update(["agent_profile", "role"], e.target.value)} /></label>
    <details className={styles.advanced}><summary>{t("copy.components_workflows_WorkflowAgentSettings.004")}</summary><div className={styles.settingsStack}>
      <div className={styles.toggleRow}><span>{t("copy.components_workflows_WorkflowAgentSettings.005")}</span><SwitchControl label={t("copy.components_workflows_WorkflowAgentSettings.006")} disabled={disabled} checked={context.include_script_outputs !== false} onCheckedChange={(checked) => update(["agent_context", "include_script_outputs"], checked)} /></div>
      <div className={styles.toggleRow}><span>{t("copy.components_workflows_WorkflowAgentSettings.007")}</span><SwitchControl label={t("copy.components_workflows_WorkflowAgentSettings.008")} disabled={disabled} checked={context.include_trigger !== false} onCheckedChange={(checked) => update(["agent_context", "include_trigger"], checked)} /></div>
      <label className={styles.field}>{t("copy.components_workflows_WorkflowAgentSettings.009")}<ChoiceSelect aria-label={t("copy.components_workflows_WorkflowAgentSettings.010")} value={String(context.on_error || "stop")} disabled={disabled} onValueChange={(value) => update(["agent_context", "on_error"], value)}><option value="stop">{t("copy.components_workflows_WorkflowAgentSettings.011")}</option><option value="continue">{t("copy.components_workflows_WorkflowAgentSettings.012")}</option></ChoiceSelect></label>
      <p className={styles.helper}>{t("copy.components_workflows_WorkflowAgentSettings.013")}</p>
    </div></details>
    <details className={styles.advanced}><summary>{t("copy.components_workflows_WorkflowAgentSettings.014")} · {team.enabled ? t("copy.components_workflows_WorkflowAgentSettings.015") : t("copy.components_workflows_WorkflowAgentSettings.016")}</summary><div className={styles.settingsStack}>
      <label className={styles.toggleRow}><span>{t("copy.components_workflows_WorkflowAgentSettings.017")}</span><input type="checkbox" disabled={disabled || roles.length === 0} checked={team.enabled === true} onChange={(e) => update(["agent_execution", "team"], { ...team, enabled: e.target.checked, roles: selectedRoles.length ? selectedRoles : roles.map((n) => String(asObject(n.config).name)) })} /></label>
      {roles.map((role) => { const name = String(asObject(role.config).name); const checked = Array.isArray(team.roles) ? selectedRoles.includes(name) : team.enabled === true; return <label className={styles.toggleRow} key={role.id}><span>{cardTitle(role, t)}</span><input type="checkbox" disabled={disabled} checked={checked} onChange={(e) => update(["agent_execution", "team", "roles"], toggle(Array.isArray(team.roles) ? selectedRoles : team.enabled ? roles.map((n) => String(asObject(n.config).name)) : [], name, e.target.checked))} /></label>; })}
      {!roles.length && <p className={styles.helper}>{t("copy.components_workflows_WorkflowAgentSettings.018")}</p>}
      <label className={styles.field}>{t("copy.components_workflows_WorkflowAgentSettings.019")}<input type="number" min={1} value={typeof team.max_parallel === "number" ? team.max_parallel : ""} disabled={disabled} placeholder={t("copy.components_workflows_WorkflowAgentSettings.020", { value0: defaults?.max_parallel ? ` · ${defaults.max_parallel}` : "" })} onChange={(e) => update(["agent_execution", "team", "max_parallel"], e.target.value === "" ? null : Number(e.target.value))} /></label>
      <p className={styles.helper}>{t("copy.components_workflows_WorkflowAgentSettings.021")}</p>
    </div></details>
    <label className={styles.field}>{t("copy.components_workflows_WorkflowAgentSettings.022")}<ChoiceSelect aria-label={t("copy.components_workflows_WorkflowAgentSettings.023")} disabled={disabled}
      value={simpleSession ? sessionPolicy : "advanced"} onValueChange={(value) => { if (value !== "advanced") onChange({ ...config, agent_session: { ...session, policy: value, include_prior_messages: true } }); }}>
      <option value="per_strategy">{t("copy.components_workflows_WorkflowAgentSettings.024")}</option>
      <option value="per_signal">{t("copy.components_workflows_WorkflowAgentSettings.025")}</option>
      {!simpleSession && <option value="advanced">{t("copy.components_workflows_WorkflowAgentSettings.026")}</option>}
    </ChoiceSelect></label>
    {budget("max_wall_seconds", "copy.workflowSettings.fields.agentExecution.max_wall_seconds")}
    <details className={styles.advanced}><summary>{t("copy.components_workflows_WorkflowAgentSettings.027")}</summary><div className={styles.settingsStack}>
      <label className={styles.field}>{t("copy.components_workflows_WorkflowAgentSettings.028")}<ChoiceSelect aria-label={t("copy.components_workflows_WorkflowAgentSettings.029")} disabled={disabled} value={String(asObject(config.agent_session).policy || "per_strategy")} onValueChange={(value) => update(["agent_session", "policy"], value)}>
        <option value="per_strategy">{t("copy.components_workflows_WorkflowAgentSettings.030")}</option>
        <option value="per_signal">{t("copy.components_workflows_WorkflowAgentSettings.031")}</option>
        <option value="per_strategy_market">{t("copy.components_workflows_WorkflowAgentSettings.032")}</option>
        <option value="per_strategy_market_timeframe">{t("copy.components_workflows_WorkflowAgentSettings.033")}</option>
        <option value="custom">{t("copy.components_workflows_WorkflowAgentSettings.034")}</option>
      </ChoiceSelect></label>
      <div className={styles.toggleRow}><span>{t("copy.components_workflows_WorkflowAgentSettings.035")}</span><SwitchControl label={t("copy.components_workflows_WorkflowAgentSettings.036")} disabled={disabled} checked={asObject(config.agent_session).include_prior_messages !== false} onCheckedChange={(checked) => update(["agent_session", "include_prior_messages"], checked)} /></div>
    </div></details>
    <details className={styles.advanced}><summary>{t("copy.components_workflows_WorkflowAgentSettings.037")} · {capabilities === "inherit" ? t("copy.components_workflows_WorkflowAgentSettings.038") : t("copy.components_workflows_WorkflowAgentSettings.039")}</summary><div className={styles.settingsStack}>
      <label className={styles.field}>{t("copy.components_workflows_WorkflowAgentSettings.040")}<ChoiceSelect aria-label={t("copy.components_workflows_WorkflowAgentSettings.041")} value={capabilities} disabled={disabled} onValueChange={(value) => onChange({ ...config, agent_execution: { ...execution, capabilities: value }, agent_profile: { ...profile, allowed_tools: value === "inherit" ? [] : allowed } })}><option value="inherit">{t("copy.components_workflows_WorkflowAgentSettings.042")}</option><option value="custom">{t("copy.components_workflows_WorkflowAgentSettings.043")}</option></ChoiceSelect></label>
      {capabilities === "custom" && <label className={styles.field}>{t("copy.components_workflows_WorkflowAgentSettings.044")}<textarea rows={4} disabled={disabled} value={allowed.join("\n")} onChange={(e) => update(["agent_profile", "allowed_tools"], e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))} /></label>}
      {capabilities === "custom" && !allowed.length && <p className={styles.helper}>{t("copy.components_workflows_WorkflowAgentSettings.045")}</p>}
      <label className={styles.field}>{t("copy.components_workflows_WorkflowAgentSettings.046")}<ChoiceSelect aria-label={t("copy.components_workflows_WorkflowAgentSettings.047")} disabled={disabled} value={String(execution.tier || "inherit")} onValueChange={(value) => update(["agent_execution", "tier"], value === "inherit" ? null : value)}><option value="inherit">{t("copy.components_workflows_WorkflowAgentSettings.048")}</option><option value="light">{t("copy.components_workflows_WorkflowAgentSettings.049")}</option><option value="medium">{t("copy.components_workflows_WorkflowAgentSettings.050")}</option><option value="high">{t("copy.components_workflows_WorkflowAgentSettings.051")}</option></ChoiceSelect></label>
      <dl className={styles.helper}>
        {(["max_iterations", "max_tool_calls", "max_wall_seconds"] as const).map((key) => <div key={key} className="flex justify-between gap-3">
          <dt>{{ max_iterations: t("copy.components_workflows_WorkflowAgentSettings.052"), max_tool_calls: t("copy.components_workflows_WorkflowAgentSettings.053"), max_wall_seconds: t("copy.components_workflows_WorkflowAgentSettings.054") }[key]}</dt>
          <dd>{String(execution[key] ?? defaults?.[key] ?? t("copy.components_workflows_WorkflowAgentSettings.055"))} · {execution[key] != null ? t("copy.components_workflows_WorkflowAgentSettings.056") : t("copy.components_workflows_WorkflowAgentSettings.057")}</dd>
        </div>)}
      </dl>
      <details><summary>{t("copy.components_workflows_WorkflowAgentSettings.058")}</summary>
        {budget("max_iterations", "copy.workflowSettings.fields.agentExecution.max_iterations")}{budget("max_tool_calls", "copy.workflowSettings.fields.agentExecution.max_tool_calls")}
      </details>
      <p className={styles.helper}>{t("copy.components_workflows_WorkflowAgentSettings.059")}</p>
      <details><summary>{t("copy.components_workflows_WorkflowAgentSettings.060")}</summary>{roles.map((role) => { const name = String(asObject(role.config).name), policy = asObject(asObject(team.role_policies)[name]); return <fieldset key={name} className={styles.settingsStack}><legend>{cardTitle(role, t)}</legend>{[["max_iterations", t("copy.components_workflows_WorkflowAgentSettings.061")], ["max_skill_calls", t("copy.components_workflows_WorkflowAgentSettings.062")], ["max_wall_seconds", t("copy.components_workflows_WorkflowAgentSettings.063")]].map(([key, label]) => <label key={key} className={styles.field}>{label}<input type="number" min={1} value={typeof policy[key] === "number" ? String(policy[key]) : ""} disabled={disabled} placeholder={t("copy.components_workflows_WorkflowAgentSettings.064")} onChange={(e) => update(["agent_execution", "team", "role_policies", name, key], e.target.value === "" ? null : Number(e.target.value))} /></label>)}</fieldset>; })}<p className={styles.helper}>{t("copy.components_workflows_WorkflowAgentSettings.065")}</p></details>
    </div></details>
  </div>;
}
