"use client";

import { useState } from "react";
import { useLocale } from "next-intl";
import { Card, Empty } from "../Page";
import { JsonView } from "../JsonView";
import { ChevronDownIcon, ChevronRightIcon } from "../icons";
import { financeNumber, finiteNumber } from "../../lib/financeDisplay";

type BacktestTable = { id: string; columns: string[]; rows: unknown[][] };
const numericColumns = new Set(["qty", "size", "price", "ideal_price", "notional", "fee", "slippage_bps", "slippage_usd", "count", "open", "high", "low", "close", "volume", "order_attempts", "orders_submitted", "queued"]);

const labels: Record<string, string> = {
  trades: "成交明细", decisions: "事件与决策", rejected_signals: "被拒绝的信号", analysis_by_reason: "按原因统计",
  ts: "时间（UTC）", signal_ts: "信号时间（UTC）", market: "交易品种", status: "状态", reason: "原因", side: "方向",
  input_sources: "输入来源", selected_roles: "参与角色", agent_execution: "模型执行", qty: "数量", size: "数量",
  price: "成交价格", ideal_price: "参考价格", notional: "成交金额", fee: "手续费", slippage_bps: "滑点（基点）",
  slippage_usd: "滑点成本", intent_id: "委托标识", forced_close: "期末平仓", reject_reason: "拒绝原因", count: "数量",
  order_events: "下单调用与结果", method: "下单方法", phase: "执行阶段", trigger_market: "触发品种",
  order_attempts: "下单尝试", orders_submitted: "已入队", queued: "入队数量", action_counts: "策略分支统计",
  error: "错误详情", error_kind: "错误类型", order_id: "成交订单标识",
};
const states: Record<string, string> = { dispatch: "触发", skip: "跳过", hold: "观望", ok: "代码返回正常（不代表成交）", attempted: "已调用", submitted: "已入队，待成交", filled: "已成交", rejected: "已拒绝", error: "错误", not_run: "未执行", buy: "买入", sell: "卖出", forced_close: "期末平仓", "trend gate not met": "未满足趋势条件", "duplicate candle": "重复 K 线", warmup: "预热数据不足", skip_no_signal: "无信号", skip_holding: "持仓保持", skip_warmup: "预热数据不足", skip_duplicate_candle: "重复K线" };

export function BacktestTables({
  tables,
  compact = false,
  maxHeightClass = "max-h-[420px]",
}: {
  tables: BacktestTable[];
  compact?: boolean;
  maxHeightClass?: string;
}) {
  const locale = useLocale(), zh = locale.startsWith("zh");
  return (
    <div className={compact ? "grid grid-cols-1 gap-3" : "grid grid-cols-1 gap-4"}>
      {tables.map((table) => (
        <Card key={table.id} title={formatTableTitle(table.id, zh)} padded={false}>
          <div className={compact ? "px-3 py-2.5" : "px-4 py-3.5"}>
            {table.rows.length === 0 ? (
              <Empty label={zh ? "暂无记录" : "No rows"} />
            ) : (
              <div className={`embedded-table-scroll ${maxHeightClass} rounded-md border border-[color:var(--line)]`}>
                <table className={`min-w-[720px] w-full ${compact ? "text-[11.5px]" : "text-xs"}`}>
                  <thead className="sticky top-0 bg-[color:var(--card-hi)]">
                    <tr>
                      {table.columns.map((col) => (
                        <th
                          key={col}
                          className={`whitespace-nowrap text-left font-medium text-[color:var(--text-muted)] ${
                            compact ? "px-2.5 py-1.5" : "px-3 py-2"
                          }`}
                        >
                          {zh ? labels[col] || col.replace(/_/g, " ") : col.replace(/_/g, " ")}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.map((row, idx) => (
                      <tr key={idx} className="border-t border-brand-500/10">
                        {row.map((cell, cellIdx) => (
                          <td
                            key={cellIdx}
                            className={`align-top font-mono text-[color:var(--text-base)] ${
                              compact ? "px-2.5 py-1.5" : "px-3 py-2"
                            }`}
                          >
                            <Cell value={cell} column={table.columns[cellIdx]} locale={locale} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

function formatTableTitle(id: string, zh: boolean): string {
  const key = id.replace(/_top\d+$/i, "");
  return zh && labels[key] ? labels[key] : key.replace(/_/g, " ");
}

function Cell({ value, column, locale }: { value: unknown; column: string; locale: string }) {
  const [open, setOpen] = useState(false);
  const zh = locale.startsWith("zh");
  if (value === null || value === undefined || value === "") {
    return <span className="text-ink-500">-</span>;
  }
  if (["ts", "signal_ts"].includes(column) && (typeof value === "number" || typeof value === "string")) {
    const n = Number(value), date = new Date(n < 1e12 ? n * 1000 : n);
    if (Number.isFinite(n) && Number.isFinite(date.getTime())) return <time className="whitespace-nowrap" dateTime={date.toISOString()} title={String(value)}>{date.toISOString().replace("T", " ").slice(0, 19)}</time>;
  }
  if (zh && typeof value === "string" && ["status", "phase", "agent_execution", "side", "reason"].includes(column) && states[value]) {
    return <span title={value}>{states[value]}</span>;
  }
  // CSV cells are strings. Format known numeric columns only; do not turn
  // order ids or zero-prefixed identifiers into numbers. Keep exact raw data.
  if (typeof value === "string" && numericColumns.has(column)) {
    const number = finiteNumber(value);
    if (number !== null) return <span className="whitespace-nowrap" title={value}>{formatNumber(number, locale)}</span>;
  }
  if (typeof value === "number") {
    return (
      <span className="whitespace-nowrap">
        {Number.isFinite(value) ? formatNumber(value, locale) : "—"}
      </span>
    );
  }
  if (typeof value === "boolean") {
    return (
      <span className={value ? "text-accent-300" : "text-danger"}>
        {zh ? value ? "是" : "否" : value ? "true" : "false"}
      </span>
    );
  }
  if (typeof value !== "object") {
    return <span className="block max-w-[24rem] whitespace-normal break-words">{String(value)}</span>;
  }
  const summary = Array.isArray(value)
    ? `[${value.length} item${value.length === 1 ? "" : "s"}]`
    : `{${Object.keys(value as Record<string, unknown>).length} field${
        Object.keys(value as Record<string, unknown>).length === 1 ? "" : "s"
      }}`;
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="cursor-pointer inline-flex items-center gap-1 text-[11px] text-brand-200 hover:text-brand-100"
      >
        {open ? <ChevronDownIcon className="h-3 w-3" /> : <ChevronRightIcon className="h-3 w-3" />}
        {summary}
      </button>
      {open ? (
        <div className="mt-1 min-w-[18rem] normal-case">
          <JsonView value={value} showRawToggle={false} className="bg-ink-950/40" />
        </div>
      ) : null}
    </div>
  );
}

function formatNumber(value: number, locale: string): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 100) return value.toLocaleString(locale, { maximumFractionDigits: 2 });
  if (Math.abs(value) >= 1) return value.toLocaleString(locale, { maximumFractionDigits: 4 });
  return financeNumber(value, locale);
}
