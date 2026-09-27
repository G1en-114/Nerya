"use client";
import { Icon as NeryaGlyph } from "../icons";
import { copy as i18nCopy } from "../../lib/i18n";

import { useLocale, useTranslations } from "next-intl";
import { useContext } from "react";
import { ResearchVisualContext } from "./ResearchVisualContext";
import { type ChartBlockShape, isChartBlockShape } from "../../lib/chartBlock";
import { useChartData } from "../../lib/useChartData";
import { FinancialChart } from "../finance/FinancialChart";
import { ChartPlaceholder } from "./ChartPlaceholder";

export function ChartBlock({ block }: { block: unknown }) {
  const open = useContext(ResearchVisualContext);
  const t = useTranslations("researchWorkspace");
  if (!isChartBlockShape(block)) return null;
  if (open) return <button type="button" data-testid="research-chart-link" onClick={() => open(block)} className="my-2 flex min-h-10 w-full items-center gap-3 rounded-lg border border-[color:var(--line)] px-3 py-2 text-left text-xs hover:bg-[color:var(--panel-bg)] focus-visible:ring-2"><NeryaGlyph name="chart" size={18} /><span className="min-w-0 flex-1 truncate">{block.title}</span><span className="shrink-0 text-[color:var(--text-muted)]">{t("openChart")}</span></button>;
  return <ChartBlockCard block={block} />;
}
function ChartBlockCard({ block: rawBlock }: { block: ChartBlockShape }) {
  const zh = useLocale().startsWith("zh");
  const { block, loading, error, ready } = useChartData(rawBlock);
  return <div className="my-3 min-w-0 border-y border-[color:var(--line)] py-2" data-testid="inline-financial-chart">
    {ready ? <FinancialChart key={block.chart_id} block={block} height={block.ui?.height ?? 260} /> : <ChartPlaceholder title={block.title || (i18nCopy(zh, "copy.components_chat_ChartBlock.001"))} subtitle={loading ? (i18nCopy(zh, "copy.components_chat_ChartBlock.002")) : error ? `${i18nCopy(zh, "copy.components_chat_ChartBlock.003")}: ${error}` : (i18nCopy(zh, "copy.components_chat_ChartBlock.004"))} tone={loading ? "loading" : error ? "error" : "empty"} height={260} />}
  </div>;
}
