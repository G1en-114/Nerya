"use client";

import Link from "next/link";
import { useLocale } from "next-intl";
import { backtestReviewDraft, type BacktestReviewTarget } from "../../lib/backtestReview";
import { setWorkspaceComposeDraft } from "../../lib/workspaceComposeDraft";
import { toast } from "../../lib/dialogs";

export function BacktestReviewAction({ target, className }: { target: BacktestReviewTarget; className?: string }) {
  const zh = useLocale().startsWith("zh");
  if (!target.strategyId || !target.ts) return null;
  return <Link className={className || "btn btn-ghost"}
    href={`/chat?draft=${encodeURIComponent(`review:${target.strategyId}:${target.ts}`)}`}
    data-testid="backtest-research-review"
    title={zh ? "带上本次报告生成可编辑的复核消息，不会自动发送" : "Prepare an editable review message for this run; no automatic send"}
    onClick={event => {
      if (!setWorkspaceComposeDraft({ text: backtestReviewDraft(target, zh), attachments: [], autoSend: false })) {
        event.preventDefault();
        toast({ tone: "warn", message: zh ? "工作区尚未就绪，请稍后重试。" : "Workspace is not ready. Please retry." });
      }
    }}>{zh ? "复核本次研究" : "Review this research"}</Link>;
}
