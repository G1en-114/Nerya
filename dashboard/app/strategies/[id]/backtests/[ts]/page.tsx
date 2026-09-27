"use client";

import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { BacktestChart } from "../../../../../components/backtest/BacktestChart";
import { Card, PageBody, PageHeader } from "../../../../../components/Page";
import { SectionTabs } from "../../../../../components/SectionTabs";

const FILES = [
  "report.md",
  "metrics.json",
  "trades.csv",
  "ohlcv_indicators_portfolio.csv",
  "analysis_by_reason.csv",
  "rejected_signals.csv",
  "order_events.csv",
  "decisions.csv",
  "equity.csv",
  "benchmark.csv",
  "config.yml",
  "chart.json",
];

export default function StrategyBacktestDetailPage({
  params,
  searchParams,
}: {
  params: { id: string; ts: string };
  searchParams?: { proposal_id?: string };
}) {
  const strategyId = decodeURIComponent(params.id);
  const ts = decodeURIComponent(params.ts);
  const t = useTranslations("strategyBacktests");
  const proposalId = typeof searchParams?.proposal_id === "string" ? searchParams.proposal_id : undefined;
  const strategyUrl = proposalId ? `/strategies?strategy_id=${encodeURIComponent(strategyId)}&proposal_id=${encodeURIComponent(proposalId)}` : `/strategies/${encodeURIComponent(strategyId)}`;
  const [downloadError, setDownloadError] = useState("");
  return (
    <div>
      <PageHeader
        title={ts}
        eyebrow={t("detailEyebrow", { id: strategyId })}
        description={t("detailDescription")}
        actions={
          <div className="flex items-center gap-2">
            <Link href={proposalId ? strategyUrl : `/strategies/${encodeURIComponent(strategyId)}/backtests`} className="btn-ghost text-xs">
              {t("runsTitle")}
            </Link>
            <Link href={strategyUrl} className="btn-ghost text-xs">
              {t("strategy")}
            </Link>
          </div>
        }
      />
      <SectionTabs section="strategy" />
      <PageBody>
        <BacktestChart strategyId={strategyId} ts={ts} proposalId={proposalId} />
        {downloadError && <p role="alert" className="text-sm text-danger">{downloadError}</p>}
        <Card title={t("artifactsTitle")}>
          <div className="flex flex-wrap gap-2">
            {FILES.map((name) => (
              <a
                key={name}
                href={`/api/proxy/strategy/backtests/file`}
                onClick={(event) => {
                  event.preventDefault();
                  setDownloadError("");
                  void downloadArtifact(strategyId, ts, name, proposalId).catch(error => setDownloadError(String(error)));
                }}
                className="btn-ghost text-xs"
              >
                {name}
              </a>
            ))}
          </div>
        </Card>
      </PageBody>
    </div>
  );
}

async function downloadArtifact(strategyId: string, ts: string, name: string, proposalId?: string) {
  const { clientApi } = await import("../../../../../lib/clientApi");
  const res = await clientApi.strategyBacktestFile(strategyId, ts, name, proposalId);
  if (!res.ok || typeof res.content !== "string") throw new Error(`${name}: artifact unavailable`);
  const blob = new Blob([res.content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
