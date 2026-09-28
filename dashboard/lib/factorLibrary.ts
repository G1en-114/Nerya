"use client";

import { callApi } from "./clientApi";

export type FactorSource = { strategy_id: string; ts: string; proposal_id?: string | null; source_revision?: string; data_kind?: string };
export type FactorDefinition = {
  factor_id: string; name: string; category: string; expression: string; parameters: Record<string, number>;
  description: string; hypothesis: string; direction: string; markets: string[]; timeframes: string[]; tags: string[]; status: string;
};
export type Factor = FactorDefinition & {
  version: number; inputs: string[]; lookback: number; definition_hash: string; fingerprint: string;
  updated_at: string; change_reason: string; source_backtest?: FactorSource | null; run_count?: number;
};
export type FactorStats = {
  samples: number; ic: number | null; rank_ic: number | null; quantile_spread_bps: number | null;
  favored_bucket_mean_bps: number | null; fee_slippage_adjusted_mean_bps: number | null; double_cost_mean_bps: number | null;
  quantiles: { bucket: number; count: number; mean_forward_bps: number | null }[];
};
export type FactorRun = {
  run_id: string; factor_id: string; version: number; created_at: string; status: string; error?: string;
  manifest_path: string; engine: string; profile: { market: string; timeframe: string; instrument_type: string; fee_bps: number; slippage_bps: number };
  request: { start: string; end: string; horizon: number }; data?: { snapshot?: string; sha256?: string; rows?: number };
  analysis?: {
    in_sample: FactorStats; out_of_sample: FactorStats; test_blocks: (FactorStats & { start: number; end: number })[];
    split: { test_start: number; purge_bars: number }; warnings: string[]; pending_checks: string[];
    comparisons: { factor_id: string; version: number; rank_correlation: number | null }[];
    preview: { time: number; value: number | null }[];
  };
};
export type FactorDetail = { factor: Factor; versions: Factor[]; runs: FactorRun[] };
export type FactorDataset = { market: string; timeframe: string; rows: number; first_ts: number; last_ts: number; verified_rows: number; sources: string };
export type BacktestFactorsData = { source_backtest: FactorSource; used_factors: Factor[]; extracted_factors: Factor[]; markets: string[]; timeframe: string };

export class FactorRequestError extends Error {
  constructor(message: string, readonly run?: FactorRun) {
    super(message);
    this.name = "FactorRequestError";
  }
}

export async function factorRequest<T>(action: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const read = ["list", "get", "data", "export"].includes(action);
  const query = new URLSearchParams();
  if (read) Object.entries(body).forEach(([key, value]) => { if (value != null) query.set(key, String(value)); });
  const result = await callApi<T & { ok: boolean; error?: string; message?: string; run?: FactorRun }>(`/factors/${action}${query.size ? `?${query}` : ""}`,
    { method: read ? "GET" : "POST", body: read ? undefined : body, signal });
  if (result.ok === false) throw new FactorRequestError(result.run?.error || result.message || result.error || "Factor request failed", result.run);
  return result;
}

export function factorSourceUrl(source: FactorSource): string {
  const query = new URLSearchParams({ strategy_id: source.strategy_id, ts: source.ts });
  if (source.proposal_id) query.set("proposal_id", source.proposal_id);
  return `/factors?${query}`;
}
