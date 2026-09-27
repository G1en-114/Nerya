"use client";

import { useLocale } from "next-intl";

/** Only persisted execution counters are facts; legacy missing values stay unknown. */
export function BacktestExecutionEvidence({ replay, legacyBenchmark = false }: {
  replay: Record<string, unknown>; legacyBenchmark?: boolean;
}) {
  const locale = useLocale(), zh = locale.startsWith("zh");
  if (replay.order_attempts === undefined && !legacyBenchmark) return null;
  const rows = [["order_attempts", zh ? "下单尝试" : "SDK attempts"],
    ["orders_submitted", zh ? "已入队" : "Queued"], ["orders_filled", zh ? "订单成交" : "Filled orders"],
    ["orders_rejected", zh ? "已拒绝" : "Rejected"], ["sdk_errors", zh ? "接口错误" : "SDK errors"]];
  const reasons = replay.rejection_reasons && typeof replay.rejection_reasons === "object" ? Object.entries(replay.rejection_reasons) : [];
  const labels: Record<string, string> = { max_open_trades: "超过同时持仓上限", confidence_below_minimum: "置信度低于门槛",
    direct_orders_disabled: "策略禁止直接下单", insufficient_cash: "可用资金不足", no_open_position: "没有可平仓持仓",
    position_side_mismatch: "平仓方向与持仓不一致", short_not_allowed: "回测禁止做空", missing_market_bar: "缺少对应品种行情" };
  return <section className="space-y-2 border-t border-[color:var(--line)] pt-3 text-xs" aria-label={zh ? "订单执行核对" : "Order execution evidence"} data-testid="backtest-execution-evidence">
    {legacyBenchmark && <p role="status" className="text-warn leading-6">{zh ? "旧版多品种基准存在价格加权及缺失行情估值问题。请重新回测，勿将此报告的基准、超额收益作为有效评估依据。" : "This legacy multi-market benchmark has price-weighting and missing-mark defects. Rerun before using its benchmark or excess return."}</p>}
    <dl className="flex flex-wrap gap-x-5 gap-y-3">{rows.map(([key, label]) => {
      const value = replay[key];
      return <div key={key}><dt className="text-[color:var(--text-muted)]">{label}</dt><dd className="mt-1 font-medium tabular-nums" data-execution-metric={key}>{typeof value === "number" && Number.isFinite(value) ? value.toLocaleString(locale) : "—"}</dd></div>;
    })}</dl>
    <p className="text-[color:var(--text-muted)] leading-6">{zh ? "策略返回 ok 不代表成交；入队后仍可能被拒绝。期末自动平仓另计。" : "Strategy ok is not a fill; queued orders can still be rejected. End-of-data liquidation is counted separately."}{typeof replay.forced_closes === "number" ? ` ${zh ? "期末平仓" : "Liquidations"}: ${replay.forced_closes}` : ""}</p>
    {typeof replay.protective_closes === "number" && replay.protective_closes > 0 && <p className="text-[color:var(--text-muted)] leading-6" data-execution-metric="protective_closes">{zh ? "历史保护规则触发退出" : "Historical protection exits"}: {replay.protective_closes.toLocaleString(locale)} · {zh ? "另计成交，不冒充新的 SDK 下单；同根 K 线无法确定先后时采用保守止损优先。" : "Separate fills, not new SDK submissions. Ambiguous intrabar collisions use conservative stop-first evaluation."}</p>}
    {replay.order_attempts === 0 && <p role="status" className="text-warn">{zh ? "本次没有记录到下单尝试，请检查信号分支、跳过原因及接口调用，而不是提高仓位上限。旧引擎可能未记录被策略捕获的调用异常，需重跑确认。" : "No order attempts were recorded. Inspect branches, skips and SDK calls, not just the position cap. Legacy engines may omit caught submission errors; rerun to verify."}</p>}
    {replay.order_accounting_ok === false && <p role="alert" className="text-danger">{zh ? "订单记录未对齐，不能把本次结果视为已验证回测。" : "Order records do not reconcile. This replay is not verified."}</p>}
    {!!reasons.length && <details><summary className="cursor-pointer py-2">{zh ? "拒单原因" : "Rejection reasons"}</summary><dl className="space-y-2">{reasons.map(([key, count]) => <div key={key} className="flex justify-between gap-4"><dt title={key}>{zh ? labels[key] || key : key.replaceAll("_", " ")}</dt><dd className="tabular-nums">{String(count)}</dd></div>)}</dl></details>}
  </section>;
}
