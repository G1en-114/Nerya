import type { BacktestChartData, BacktestPanel } from "./clientApi";

export type ReplayCandle = { time: number; open: number; high: number; low: number; close: number };
export type ReplayMarker = {
  id: string; time: number; execution_ts?: number; kind: "trade" | "gbs";
  position: "aboveBar" | "belowBar" | "inBar"; shape: "arrowUp" | "arrowDown" | "circle";
  color: string; text: string; side: string; price: number | null; reason: string;
};
export type ReplayTrade = { id: string; market: string; time: number | null; side: string; row: Record<string, unknown> };

export function replayNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

export function replayTime(value: unknown): number | null {
  const numeric = replayNumber(value);
  if (numeric !== null) return numeric > 0 ? Math.floor(numeric >= 1e12 ? numeric / 1000 : numeric) : null;
  if (typeof value !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : null;
}

export function replayCandles(panel: BacktestPanel): ReplayCandle[] {
  const byTime = new Map<number, ReplayCandle>();
  for (const source of (panel.series || []).filter(series => series.kind === "candles")) {
    for (const row of source.data || []) {
      const time = replayTime(row.time ?? row.ts);
      const open = replayNumber(row.open), high = replayNumber(row.high), low = replayNumber(row.low), close = replayNumber(row.close);
      if (time === null || open === null || high === null || low === null || close === null
        || Math.min(open, high, low, close) <= 0 || high < Math.max(open, close) || low > Math.min(open, close)) continue;
      byTime.set(time, { time, open, high, low, close });
    }
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Unlike candles, simultaneous markers are distinct execution evidence. */
export function replayMarkers(panel: BacktestPanel): ReplayMarker[] {
  const times = new Set(replayCandles(panel).map(candle => candle.time));
  return (panel.series || []).filter(series => series.kind === "markers").flatMap(series => series.data || []).flatMap((row, index) => {
    const time = replayTime(row.time);
    if (time === null || !times.has(time)) return [];
    const kind = row.kind === "gbs" || String(row.text || "").toUpperCase() === "GBS" ? "gbs" : "trade";
    const side = String(row.side || (row.shape === "arrowUp" ? "buy" : row.shape === "arrowDown" ? "sell" : "")).toLowerCase();
    return [{ id: String(row.id || `${kind}:legacy:${index}`), time,
      execution_ts: replayTime(row.execution_ts) ?? undefined, kind,
      position: row.position === "belowBar" ? "belowBar" : row.position === "inBar" ? "inBar" : "aboveBar",
      shape: kind === "gbs" ? "circle" : side === "buy" ? "arrowUp" : "arrowDown",
      color: kind === "gbs" ? "#f5a524" : side === "buy" ? "#10d993" : "#ef4560",
      text: kind === "gbs" ? "GBS" : side === "buy" ? "B" : "S", side,
      price: replayNumber(row.price), reason: String(row.reason || "") } satisfies ReplayMarker];
  }).sort((a, b) => a.time - b.time || (a.execution_ts || a.time) - (b.execution_ts || b.time));
}

export function replayTrades(tables: BacktestChartData["tables"], panels: BacktestPanel[]): ReplayTrade[] {
  const known = [...new Set(panels.map(panel => panel.market).filter(Boolean))];
  const fallback = known.length === 1 ? known[0]! : "";
  return tables.flatMap(table => table.rows.map((cells, index) => {
    const row = Object.fromEntries(table.columns.map((key, column) => [key, cells[column]]));
    return { id: String(row.trade_id || (table.id === "trades" ? `trade:${index}` : `${table.id}:${index}`)),
      market: String(row.market || fallback), time: replayTime(row.ts ?? row.time), side: String(row.side || "").toLowerCase(), row };
  }));
}
