"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import Link from "next/link";
import { clientApi } from "../../lib/clientApi";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function promotionReceiptFacts(value: unknown) {
  const receipt = record(value), sync = record(receipt.schedule_sync);
  const warnings = Array.isArray(record(receipt.promotion).warnings)
    ? (record(receipt.promotion).warnings as unknown[]).filter((item): item is string => typeof item === "string") : [];
  return {
    validation: record(receipt.validation).ok,
    application: record(receipt.application).status || (receipt.ok === true || record(receipt.promotion).ok === true ? "applied" : "unrecorded"),
    sync,
    syncFailed: sync.status === "failed" || (!sync.status && warnings.includes("schedule_sync_failed")),
    warnings: sync.status === "synced" ? warnings.filter((item) => item !== "schedule_sync_failed") : warnings,
    service: record(receipt.service),
  };
}

export function WorkflowPromotionReceipt({ strategyId, proposalId, receipt: initial }: {
  strategyId: string; proposalId: string; receipt?: unknown;
}) {
  const zh = useLocale().startsWith("zh");
  const [receipt, setReceipt] = useState<unknown>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newerProposal, setNewerProposal] = useState(false);
  const request = useRef(0);
  useEffect(() => { setReceipt(initial); }, [initial]);
  useEffect(() => {
    let disposed = false;
    const version = ++request.current;
    void clientApi.strategyRuntimeScheduleStatus(strategyId).then((response) => {
      if (disposed || version !== request.current) return;
      if (response.ok === false) throw new Error(String(record(response).error || "schedule_status_failed"));
      const saved = record(record(response).promotion_receipt);
      setNewerProposal(!!saved.proposal_id && saved.proposal_id !== proposalId);
      if (saved.proposal_id === proposalId) setReceipt({ ...saved, service: record(response).service });
    }).catch(() => { if (!disposed && version === request.current) setError(zh ? "无法核对最新调度状态，可重新核对。" : "Could not verify the latest schedule state. Refresh to check again."); });
    return () => { disposed = true; };
  }, [strategyId, proposalId, initial, zh]);
  const facts = promotionReceiptFacts(receipt);
  const unknown = zh ? "未记录" : "Not recorded";
  async function refresh() {
    ++request.current;
    setBusy(true); setError("");
    try {
      const response = await clientApi.strategyRuntimeScheduleStatus(strategyId);
      if (response.ok === false) throw new Error("schedule_status_failed");
      const saved = record(record(response).promotion_receipt);
      setNewerProposal(!!saved.proposal_id && saved.proposal_id !== proposalId);
      if (saved.proposal_id === proposalId) setReceipt({ ...saved, service: record(response).service });
    } catch { setError(zh ? "核对失败，请稍后重试。" : "Verification failed. Try again later."); }
    finally { setBusy(false); }
  }
  async function retrySync() {
    if (!facts.syncFailed || facts.application !== "applied" || newerProposal) return;
    ++request.current;
    setBusy(true); setError("");
    try {
      const response = await clientApi.strategyRuntimeSchedule(strategyId);
      if (response.ok === false) throw new Error("schedule_sync_failed");
      setReceipt((previous: unknown) => ({ ...record(previous), schedule_sync: { ...response, status: "synced" } }));
      if (Array.isArray(record(response).warnings)) setError(zh ? "同步已完成，但回执未能持久化；刷新后需重新核对。" : "Synchronization completed, but its receipt could not be saved. Verify state after refreshing.");
    } catch { setError(zh ? "调度仍未同步；版本已应用。请检查定时配置后仅重试同步。" : "Schedules are still unsynced; the version is applied. Check timer configuration and retry only synchronization."); }
    finally { setBusy(false); }
  }
  const label = (status: unknown) => {
    const labels: Record<string, [string, string]> = {
      applied: ["已应用", "Applied"], failed: ["失败", "Failed"], not_applied: ["未应用", "Not applied"],
      synced: ["已同步", "Synced"], not_attempted: ["未尝试", "Not attempted"],
      not_applicable: ["不适用", "Not applicable"], stopped: ["未运行", "Stopped"],
      running: ["运行中", "Running"], starting: ["启动中", "Starting"], stopping: ["停止中", "Stopping"],
      restarting: ["重启中", "Restarting"], interrupted: ["已中断", "Interrupted"],
      unresponsive: ["无响应，待核对", "Unresponsive; verify state"], finished: ["已结束", "Finished"],
      unconfirmed: ["待核对", "Unconfirmed"], not_checked: ["未核对", "Not checked"],
    };
    return labels[String(status)]?.[zh ? 0 : 1] || unknown;
  };
  const timer = (key: "trading_id" | "tuning_id") => facts.syncFailed ? (zh ? "同步失败，待核对" : "Sync failed; verify state")
    : facts.sync.status !== "synced" ? unknown
    : facts.sync[key] ? (zh ? "配置已同步" : "Configuration synced") : (zh ? "未配置" : "Not configured");
  return <section className="mt-3 rounded-md border border-ink-500/20 p-3 text-xs" data-testid="workflow-promotion-receipt">
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
      <dt>{zh ? "候选验证" : "Candidate validation"}</dt><dd>{facts.validation === true ? (zh ? "通过" : "Passed") : facts.validation === false ? (zh ? "未通过" : "Failed") : unknown}</dd>
      <dt>{zh ? "版本应用" : "Version application"}</dt><dd>{label(facts.application)}</dd>
      <dt>{zh ? "交易定时器" : "Trading timer"}</dt><dd>{timer("trading_id")}</dd>
      <dt>{zh ? "复盘定时器" : "Review timer"}</dt><dd>{timer("tuning_id")}</dd>
      <dt>{zh ? "持续服务" : "Continuous service"}</dt><dd>{label(facts.service.state)}</dd>
    </dl>
    {newerProposal && <p className="mt-2 text-warn" role="status">{zh ? "此提案之后已有新的应用记录，请到策略页核对当前版本与调度。" : "A newer application receipt exists. Inspect the current version and schedules on the strategy page."}</p>}
    {facts.syncFailed && !newerProposal && <p className="mt-2 text-warn" role="status">{facts.application === "applied"
      ? (zh ? "版本已应用，调度待同步。检查定时配置后重试同步。" : "Version applied; schedules need synchronization. Check timer configuration, then retry synchronization.")
      : (zh ? "调度同步失败，版本应用状态需另行核对。" : "Schedule sync failed. Verify the version application state separately.")}</p>}
    {facts.warnings.filter((warning) => warning !== "schedule_sync_failed").map((warning) => <p key={warning} className="mt-2 text-warn">{warning}</p>)}
    <p className="mt-2 text-ink-400">{zh ? "同步配置不证明任务已经执行。持续服务需单独启动；实盘仍须通过风险和审批检查。" : "Synced configuration is not proof of execution. Continuous services require a separate start; live trading still requires risk and approval checks."}</p>
    <div className="mt-2 flex flex-wrap gap-3">
      {facts.syncFailed && facts.application === "applied" && !newerProposal && <button type="button" className="btn btn-ghost text-xs" disabled={busy} onClick={() => void retrySync()}>{zh ? "仅重试调度同步" : "Retry schedule sync only"}</button>}
      <button type="button" className="btn btn-ghost text-xs" disabled={busy} onClick={() => void refresh()}>{zh ? "重新核对" : "Refresh status"}</button>
      <Link className="btn btn-ghost text-xs" href={`/strategies/${encodeURIComponent(strategyId)}`}>{zh ? "查看配置与运行状态" : "Inspect configuration and runtime"}</Link>
    </div>
    {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
  </section>;
}
