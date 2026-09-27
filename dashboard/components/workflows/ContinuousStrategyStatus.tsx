"use client";

import { useEffect, useRef, useState } from "react";
import { callApi } from "../../lib/clientApi";
import { confirm } from "../../lib/dialogs";
import { useWorkflowText } from "./WorkflowCanvas";
import ui from "./WorkflowNative.module.css";
import styles from "./ContinuousStrategyStatus.module.css";

type Service = {
  ok: boolean; state: string; error?: string; connection?: string;
  agent_active?: boolean; queue_depth?: number; accepted_events?: number;
  rejected_events?: number; restart_count?: number; last_message_at?: number;
  last_error?: string; stop_reason?: string;
  last_event?: { event_id: string; status: string; session_id?: string };
};
const activeStates = new Set(["starting", "running", "restarting", "stopping", "unresponsive"]);

export function ContinuousStrategyStatus({ strategyId, proposalId, dirty }: {
  strategyId: string; proposalId?: string | null; dirty: boolean;
}) {
  const t = useWorkflowText();
  const [service, setService] = useState<Service | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(true);
  const serial = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; serial.current++; }; }, []);
  useEffect(() => {
    if (proposalId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const request = ++serial.current;
      try {
        const next = await callApi<Service>(`/strategies/runtime/service/status?strategy_id=${encodeURIComponent(strategyId)}`, { signal: controller.signal });
        if (!next.ok) throw new Error(next.error || "Runtime status unavailable");
        if (request === serial.current && !controller.signal.aborted) { setService(next); setError(""); }
      } catch (reason) {
        if (request === serial.current && !controller.signal.aborted) setError(String(reason));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [strategyId, proposalId, refresh]);

  async function control(action: "start" | "stop") {
    setBusy(true);
    try {
      let hash: string | undefined;
      if (action === "start") {
        const current = await callApi<{ ok: boolean; package_hash: string; error?: string; manifest: { mode?: string } }>(
          `/strategies/runtime/status?strategy_id=${encodeURIComponent(strategyId)}`, { signal: new AbortController().signal });
        if (!current.ok || !current.package_hash) throw new Error(current.error || "Current strategy version unavailable");
        hash = current.package_hash;
        const approved = await confirm({ title: t("copy.components_workflows_ContinuousStrategyStatus.001"), tone: "warning",
          message: t("copy.components_workflows_ContinuousStrategyStatus.002", { value0: current.manifest.mode || "paper" }),
          okLabel: t("copy.components_workflows_ContinuousStrategyStatus.003") });
        if (!approved || !mounted.current) return;
      }
      const result = await callApi<Service>(`/strategies/runtime/service/${action}`, {
        method: "POST", body: { strategy_id: strategyId, ...(hash ? { expected_hash: hash } : {}) },
      });
      if (!result.ok) throw new Error(result.error || "Service action failed");
      if (mounted.current) { serial.current++; setService(result); setError(""); }
    } catch (reason) { if (mounted.current) setError(String(reason)); }
    finally { if (mounted.current) { setBusy(false); setRefresh((value) => value + 1); } }
  }
  const labels: Record<string, string> = {
    starting: t("copy.components_workflows_ContinuousStrategyStatus.004"), running: t("copy.components_workflows_ContinuousStrategyStatus.005"), restarting: t("copy.components_workflows_ContinuousStrategyStatus.006"),
    stopping: t("copy.components_workflows_ContinuousStrategyStatus.007"), stopped: t("copy.components_workflows_ContinuousStrategyStatus.008"), finished: t("copy.components_workflows_ContinuousStrategyStatus.009"),
    failed: t("copy.components_workflows_ContinuousStrategyStatus.010"), interrupted: t("copy.components_workflows_ContinuousStrategyStatus.011"), unresponsive: t("copy.components_workflows_ContinuousStrategyStatus.012"),
  };
  const connection = ({ connected: t("copy.components_workflows_ContinuousStrategyStatus.013"), connecting: t("copy.components_workflows_ContinuousStrategyStatus.014"), reconnecting: t("copy.components_workflows_ContinuousStrategyStatus.015"), disconnected: t("copy.components_workflows_ContinuousStrategyStatus.016"), idle: t("copy.components_workflows_ContinuousStrategyStatus.017") } as Record<string, string>)[service?.connection || ""];
  const active = !!service && activeStates.has(service.state);
  return <section className={styles.root} data-testid="continuous-strategy-status" aria-label={t("copy.components_workflows_ContinuousStrategyStatus.018")}>
    <div className={styles.line}><strong>{t("copy.components_workflows_ContinuousStrategyStatus.019")}</strong>
      <span role="status" className={styles.state} data-state={error ? "unknown" : service?.state || "stopped"}>
        {proposalId ? t("copy.components_workflows_ContinuousStrategyStatus.020") : error ? t("copy.components_workflows_ContinuousStrategyStatus.021") : labels[service?.state || ""] || t("copy.components_workflows_ContinuousStrategyStatus.022")}
      </span><span className={styles.grow} />
      {!proposalId && <><button type="button" className={ui.quietButton} disabled={busy || dirty || !!error || !service || active} onClick={() => void control("start")}>{t("copy.components_workflows_ContinuousStrategyStatus.023")}</button>
      <button type="button" className={ui.quietButton} disabled={busy || (!active && !error)} onClick={() => void control("stop")}>{t("copy.components_workflows_ContinuousStrategyStatus.024")}</button></>}
    </div>
    <p className={styles.note}>{proposalId ? t("copy.components_workflows_ContinuousStrategyStatus.025") :
      t("copy.components_workflows_ContinuousStrategyStatus.026")}</p>
    {!proposalId && service && !error && <div className={styles.metrics}>
      {connection && <span>WebSocket · {connection}</span>}
      <span>Agent · {service.agent_active ? t("copy.components_workflows_ContinuousStrategyStatus.027") : t("copy.components_workflows_ContinuousStrategyStatus.028")}</span>
      <span>{t("copy.components_workflows_ContinuousStrategyStatus.029")} {service.queue_depth ?? 0}</span>
      <span>{t("copy.components_workflows_ContinuousStrategyStatus.030")} {service.accepted_events ?? 0} / {t("copy.components_workflows_ContinuousStrategyStatus.031")} {service.rejected_events ?? 0}</span>
      {!!service.restart_count && <span>{t("copy.components_workflows_ContinuousStrategyStatus.032")} {service.restart_count}</span>}
      {service.last_message_at && <span>{t("copy.components_workflows_ContinuousStrategyStatus.033")} {new Date(service.last_message_at * 1000).toLocaleTimeString()}</span>}
    </div>}
    {(error || service?.last_error) && <p className={styles.error} role="alert">{error || service?.last_error}<button type="button" className={ui.quietButton} onClick={() => setRefresh((n) => n + 1)}>{t("copy.components_workflows_ContinuousStrategyStatus.034")}</button></p>}
    {service?.stop_reason && !active && <p className={styles.note}>{t("copy.components_workflows_ContinuousStrategyStatus.035")} · {service.stop_reason}</p>}
    {service?.last_event && <details className={styles.note}><summary>{t("copy.components_workflows_ContinuousStrategyStatus.036")} · {service.last_event.status}</summary><p>{service.last_event.event_id}<br />{service.last_event.session_id}</p></details>}
  </section>;
}
