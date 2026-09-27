"use client";
import { Icon as NeryaGlyph } from "../icons";

import { useContext, useEffect, useState } from "react";
import { StrategyDetailContext } from "../chat/StrategyDetailContext";
import { strategyDetailId } from "../../lib/strategyDetail";
import Link from "next/link";
import { useLocale } from "next-intl";
import type { WorkflowView } from "../../lib/workflowTypes";
import { useWorkflowText } from "./WorkflowCanvas";

/** The same editable canvas is used in chat and the strategy workspace. */
export function StrategyChatReference({ strategyId, proposalId, expanded = false, onSaved, view }: { strategyId: string; proposalId?: string | null; expanded?: boolean; onSaved?: (view: WorkflowView) => void; view?: WorkflowView | null }) {
  const t = useWorkflowText();
  const zh = useLocale().startsWith("zh");
  const [candidate, setCandidate] = useState(proposalId);
  const [open, setOpen] = useState(expanded);
  const details = useContext(StrategyDetailContext);
  useEffect(() => setCandidate(proposalId), [proposalId]);
  const resources = view?.strategy.nodes.filter(node => ["source","script","agent","scheduler"].includes(node.kind)) || [];
  const target = { kind: "strategy" as const, strategyId, proposalId: candidate, title: String(view?.manifest.title || strategyId) };
  if (details) return <div data-testid="strategy-chat-reference" className="min-w-0">
    {resources.length > 0 && <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-2 text-xs text-[color:var(--text-muted)]" aria-label={zh ? "策略流程" : "Strategy workflow"}>
      {resources.slice(0, 5).map((node, index) => <span key={node.id} className="inline-flex items-center gap-2">{index > 0 && <NeryaGlyph name="chevronRight" size={12}/>}<NeryaGlyph name={node.kind === "agent" ? "agents" : node.kind === "script" ? "terminal" : "document"} size={13}/><span className="max-w-40 truncate">{node.title.startsWith("{") ? node.kind : zh && node.kind === "scheduler" ? "定时触发" : node.title}</span></span>)}
    </div>}
    <button type="button" className="inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-xs font-medium bg-[color:var(--panel-bg)] hover:bg-[color:var(--line)] focus-visible:outline focus-visible:outline-2" onClick={() => details.open(target)} aria-expanded={details.active === strategyDetailId(target)} aria-controls={'task-dock-panel-' + strategyDetailId(target)} data-testid="open-strategy-details">{zh ? "查看策略工作流" : "View strategy workflow"}<NeryaGlyph name="chevronRight" size={14}/></button>
  </div>;
  return <details open={open} onToggle={(event) => { setOpen(event.currentTarget.open); }} className="min-w-0" data-testid="strategy-chat-reference">
    <summary className="cursor-pointer py-2 text-xs text-[color:var(--text-base)]">{t("copy.components_workflows_StrategyChatReference.001")}{resources.length ? ` · ${resources.length}` : ""}</summary>
    {resources.length > 0 && <ul className="my-2 flex flex-wrap gap-x-5 gap-y-2 text-xs text-[color:var(--text-muted)]">{resources.slice(0,8).map(node => <li key={node.id} className="inline-flex items-center gap-2"><NeryaGlyph name={node.kind === "agent" ? "agents" : node.kind === "script" ? "terminal" : "document"} size={13}/>{zh && node.kind === "scheduler" && node.title === "Trading schedule" ? "定时触发" : node.title.startsWith("{") ? String((node.config as {id?:unknown} | null)?.id || node.resource || node.subtitle) : node.title}</li>)}</ul>}
    <div className="py-2 text-xs"><Link className="inline-flex min-h-8 items-center gap-1 underline underline-offset-4" href={`/strategies?strategy_id=${encodeURIComponent(strategyId)}${candidate ? `&proposal_id=${encodeURIComponent(candidate)}` : ""}`}>{t("copy.components_workflows_StrategyChatReference.003")} <NeryaGlyph name="arrowUpRight" size={16} /></Link></div>
  </details>;
}
