"use client";
import { copy as i18nCopy } from "../../lib/i18n";

import { createContext, useContext } from "react";
import { useRouter } from "next/navigation";
import { useLocale } from "next-intl";
import type { PortfolioPosition } from "../../lib/api";
import { setComposeDraftPayload, takeComposeDraftPayload } from "../../lib/composeDraft";
import { financeMoney, financeNumber, positionSide } from "../../lib/financeDisplay";
import { toast } from "../../lib/dialogs";
import { MessagesIcon } from "../icons";

export const FinanceDraftContext = createContext<{ append: (text: string) => void; disabled: boolean } | null>(null);
export function appendReviewDraft(before: string, next: string) {
  return before.trimEnd().endsWith(next) ? before : before.trim() ? `${before.trimEnd()}\n\n${next}` : next;
}

/** A deliberate handoff into a draft, never a model call or trading command. */
export function FinanceReview({ position, mode }: { position: PortfolioPosition; mode?: string }) {
  const locale = useLocale(), zh = locale.startsWith("zh");
  const destination = useContext(FinanceDraftContext), router = useRouter();
  const label = i18nCopy(zh, "copy.components_finance_FinanceReview.001");
  function review() {
    const p = position;
    const side = positionSide(p);
    const sideLabel = side === "long" ? i18nCopy(zh, "copy.components_finance_FinanceReview.long") : side === "short" ? i18nCopy(zh, "copy.components_finance_FinanceReview.short") : i18nCopy(zh, "copy.components_finance_FinanceReview.sideNotProvided");
    const modeLabel = mode === "paper" ? i18nCopy(zh, "copy.components_finance_FinanceReview.paper") : mode === "live" ? i18nCopy(zh, "copy.components_finance_FinanceReview.live") : i18nCopy(zh, "copy.components_finance_FinanceReview.modeNotProvided");
    const text = [i18nCopy(zh, "copy.components_finance_FinanceReview.002"),
      `${i18nCopy(zh, "copy.components_finance_FinanceReview.003")}: ${p.account_id || "—"}; ${i18nCopy(zh, "copy.components_finance_FinanceReview.004")}: ${modeLabel}`,
      `${i18nCopy(zh, "copy.components_finance_FinanceReview.005")}: ${p.market || "—"} / ${sideLabel}`,
      `${i18nCopy(zh, "copy.components_finance_FinanceReview.006")}: ${financeNumber(p.size_base ?? p.size, locale)}`,
      `${i18nCopy(zh, "copy.components_finance_FinanceReview.007")}: ${financeNumber(p.avg_entry_price ?? p.avg_price, locale)} / ${financeNumber(p.mark_price, locale)}`,
      `${i18nCopy(zh, "copy.components_finance_FinanceReview.008")}: ${financeMoney(p.unrealized_pnl_usd, locale, true)}`,
      i18nCopy(zh, "copy.components_finance_FinanceReview.009"),
    ].join("\n");
    if (destination) { if (!destination.disabled) destination.append(text); return; }
    const previous = takeComposeDraftPayload();
    setComposeDraftPayload({ text: appendReviewDraft(previous?.text || "", text), attachments: previous?.attachments || [], autoSend: false });
    toast({ tone: "ok", message: i18nCopy(zh, "copy.components_finance_FinanceReview.010") });
    router.push("/chat");
  }
  return <button type="button" disabled={destination?.disabled} onClick={review} data-testid="review-position"
    title={i18nCopy(zh, "copy.components_finance_FinanceReview.011")}
    className="inline-flex min-h-8 items-center gap-2 rounded-md border border-[color:var(--line)] px-3 text-xs text-[color:var(--text-base)] hover:bg-[color:var(--panel-bg)] disabled:opacity-40"><MessagesIcon size={14} />{label}</button>;
}
