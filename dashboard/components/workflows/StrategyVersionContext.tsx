"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import Link from "next/link";
import { callApi } from "../../lib/clientApi";
import type { WorkflowView } from "../../lib/workflowTypes";

export function StrategyVersionContext({ workflow, dirty }: { workflow: WorkflowView; dirty: boolean }) {
  const zh = useLocale().startsWith("zh");
  const [open,setOpen] = useState(false), [refresh,setRefresh] = useState(0);
  const [published,setPublished] = useState(""), [running,setRunning] = useState(""), [state,setState] = useState("");
  const [loading,setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let disposed = false;
    const timer = setTimeout(() => controller.abort(),10000);
    setLoading(true); setPublished(""); setRunning(""); setState("");
    const id=encodeURIComponent(workflow.strategy_id);
    void Promise.allSettled([
      callApi<{ ok:boolean; package_hash?:string }>(`/strategies/runtime/status?strategy_id=${id}`,{ signal:controller.signal }),
      callApi<{ ok:boolean; package_hash?:string; state?:string }>(`/strategies/runtime/service/status?strategy_id=${id}`,{ signal:controller.signal }),
    ]).then(([pkg,service]) => {
      if (disposed) return;
      if (pkg.status === "fulfilled" && pkg.value.ok) setPublished(pkg.value.package_hash || "");
      if (service.status === "fulfilled" && service.value.ok) { setState(service.value.state || "");
        if (["running","starting","restarting","stopping"].includes(service.value.state || "")) setRunning(service.value.package_hash || ""); }
    }).finally(() => { clearTimeout(timer); if (!disposed) setLoading(false); });
    return () => { disposed=true; clearTimeout(timer); controller.abort(); };
  },[open,workflow.strategy_id,workflow.revision,refresh]);
  const candidate=workflow.source.proposal_id;
  const unknown=zh ? "未确认" : "Unconfirmed";
  return <div className="border-b border-[color:var(--line)] px-5 py-2 text-xs leading-6 text-[color:var(--text-muted)]" data-testid="strategy-version-context">
    <div className="flex flex-wrap items-center gap-x-3"><strong className="text-[color:var(--text-base)]">{candidate ? (zh ? "正在查看候选变更" : "Viewing a candidate") : (zh ? "正在查看已发布配置" : "Viewing published configuration")}</strong>
      <span>{dirty ? (zh ? "有未保存草稿" : "Unsaved draft") : candidate ? (zh ? "保存候选不等于已应用或已启动" : "Saving a candidate does not apply or start it") : (zh ? "编辑会产生候选变更，不会直接改动运行中版本" : "Edits create a candidate; they do not directly change a running version")}</span></div>
    <details open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary className="w-fit cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--violet)]">{zh ? "版本与生效流程" : "Versions and activation"}</summary>
      {open && <div className="space-y-2 py-2">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4">
          <dt>{zh ? "编辑版本校验" : "Editor revision"}</dt><dd className="break-all font-mono">{workflow.revision}</dd>
          {candidate && <><dt>{zh ? "候选提案" : "Proposal"}</dt><dd className="break-all font-mono">{candidate}</dd></>}
          <dt>{zh ? "已发布包版本" : "Published package"}</dt><dd className="break-all font-mono">{loading ? "…" : published || unknown}</dd>
          <dt>{zh ? "正在运行的包版本" : "Running package"}</dt><dd className="break-all font-mono">{loading ? "…" : running || (["stopped","finished"].includes(state) ? (zh ? "当前无持续运行实例" : "No continuous instance running") : unknown)}</dd>
        </dl>
        {running && published && running !== published && <p role="status">{zh ? "运行实例与已发布包不同，不能把当前编辑内容当作实际执行版本。" : "The running instance differs from the published package. The editor is not proof of what is executing."}</p>}
        <p>{zh ? "保存候选 → 查看差异 → 审阅并应用 → 启动或等待触发。审批、应用和启动是独立状态；编辑校验值与运行包哈希也不是同一种标识。" : "Save candidate → inspect differences → review and apply → start or await a trigger. Approval, application and execution are separate states; editor revisions and package hashes are different identifiers."}</p>
        <p>{zh ? "脚本注释用于解释设计意图；实际执行顺序和结果以对应运行日志为准。" : "Script annotations describe intent. The corresponding run log determines actual order and results."}</p>
        <div className="flex flex-wrap gap-3"><button type="button" disabled={loading} onClick={() => setRefresh(value=>value+1)}>{zh ? "重新核对版本" : "Refresh versions"}</button>
          {candidate && <Link href={`/self-evolution?tab=proposals&proposal_id=${encodeURIComponent(candidate)}`}>{zh ? "查看提案与差异" : "Review proposal and differences"}</Link>}</div>
      </div>}
    </details>
  </div>;
}
