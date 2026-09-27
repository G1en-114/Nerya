import type { WorkflowText } from "./workflowPresentation";
export type SourceConfig = Record<string, unknown>;
export function sourceTypeLabel(type: string, t: WorkflowText): string {
  const labels: Record<string, string> = { candles: "copy.workflowSources.types.candles", features: "copy.workflowSources.types.features", ticker: "copy.workflowSources.types.ticker", news: "copy.workflowSources.types.news" };
  return labels[type] ? t(labels[type]) : type;
}
export function sourceDimension(config: SourceConfig, plural: string, singular: string, fallback: string[] = []): string[] {
  const value = config[plural] ?? config[singular];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" && value ? [value] : fallback;
}
export function updateSourceDimension(config: SourceConfig, plural: string, singular: string, values: string[]): SourceConfig {
  const next = { ...config };
  // Untouched legacy fields retain their original shape. Once plural, keep
  // plural even with one value; callers can rely on a stable result envelope.
  if (values.length === 1 && !Object.hasOwn(config, plural)) { next[singular] = values[0]; delete next[plural]; }
  else { next[plural] = values; delete next[singular]; }
  return next;
}
export function sourceErrors(config: SourceConfig, t: WorkflowText): string[] {
  const errors: string[] = [];
  for (const [plural, singular, label] of [["markets", "market", t("copy.lib_workflowSources.001")], ["timeframes", "timeframe", t("copy.lib_workflowSources.002")]]) {
    if (Object.hasOwn(config, plural)) {
      const values = config[plural];
      if (!Array.isArray(values) || !values.length || values.some((v) => typeof v !== "string" || !v.trim())) errors.push(`${label}: ${t("copy.lib_workflowSources.003")}`);
      else {
        const normalized = values.map((v: string) => v.trim());
        if (new Set(normalized).size !== normalized.length) errors.push(`${label}: ${t("copy.lib_workflowSources.004")}`);
        if (Object.hasOwn(config, singular) && (normalized.length !== 1 || normalized[0] !== config[singular])) errors.push(t("copy.lib_workflowSources.005"));
      }
    } else if (Object.hasOwn(config, singular) && (typeof config[singular] !== "string" || !String(config[singular]).trim())) errors.push(`${label}: ${t("copy.lib_workflowSources.006")}`);
  }
  if (config.limit !== undefined && (typeof config.limit !== "number" || !Number.isInteger(config.limit) || config.limit < 1)) errors.push(t("copy.lib_workflowSources.007"));
  if (config.provider === "runtime.market" && config.capability === "ticker" && (config.timeframe !== undefined || config.timeframes !== undefined)) errors.push(t("copy.lib_workflowSources.008"));
  if (config.provider === "runtime.news" && ["market", "markets", "timeframe", "timeframes"].some((key) => key in config)) errors.push(t("copy.lib_workflowSources.009"));
  return errors;
}
export function sourceSummary(config: SourceConfig, t: WorkflowText, fallback: string[] = []): string {
  const markets = sourceDimension(config, "markets", "market", fallback);
  const frames = sourceDimension(config, "timeframes", "timeframe");
  const parts = [markets.length ? t("copy.lib_workflowSources.010", { value0: markets.length }) : "", frames.length ? frames.join(" / ") : String(config.capability || ""), config.limit ? t("copy.lib_workflowSources.011", { value0: config.limit }) : ""];
  return parts.filter(Boolean).join(" · ") || t("copy.lib_workflowSources.012");
}
