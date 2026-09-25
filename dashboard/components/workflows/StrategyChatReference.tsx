"use client";
import { Icon as NeryaGlyph } from "../icons";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { WorkflowView } from "../../lib/workflowTypes";
import { useWorkflowText } from "./WorkflowCanvas";

/** The same editable canvas is used in chat and the strategy workspace. */
export function StrategyChatReference({ strategyId, proposalId, expanded = false, onSaved }: { strategyId: string; proposalId?: string | null; expanded?: boolean; onSaved?: (view: WorkflowView) => void }) {
  const t = useWorkflowText();
  const [candidate, setCandidate] = useState(proposalId);
  const [open, setOpen] = useState(expanded);
  useEffect(() => setCandidate(proposalId), [proposalId]);
  return <details open={open} onToggle={(event) => { setOpen(event.currentTarget.open);  }} className="min-w-0 rounded-lg border border-white/10 bg-background/30" data-testid="strategy-chat-reference">
    <summary className="cursor-pointer px-4 py-3 text-sm text-ink-200">{t("copy.components_workflows_StrategyChatReference.001")} · {strategyId}{candidate ? ` · ${t("copy.components_workflows_StrategyChatReference.002")}` : ""}</summary>
    <div className="px-4 pb-3 text-xs"><Link className="text-brand-400 underline underline-offset-4" href={`/strategies?strategy_id=${encodeURIComponent(strategyId)}${candidate ? `&proposal_id=${encodeURIComponent(candidate)}` : ""}`}>{t("copy.components_workflows_StrategyChatReference.003")} <NeryaGlyph name="arrowUpRight" size={16} /></Link></div>
  </details>;
}
