export type StrategyBundle = {
  format: "nerya.strategy";
  version: 1;
  strategy_id: string;
  title?: string;
  revision?: string;
  files: Record<string, string>;
};
export type StrategyExport = { ok: boolean; error?: string; filename: string; bundle: StrategyBundle };
export const MAX_BUNDLE_BYTES = 8_000_000;
export const STRATEGY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Client-side preview only; the runtime independently validates every file. */
export function parseStrategyBundle(text: string): StrategyBundle {
  const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalidBundle");
  const bundle = value as Record<string, unknown>;
  if (bundle.format !== "nerya.strategy" || bundle.version !== 1 || typeof bundle.strategy_id !== "string" || !STRATEGY_ID.test(bundle.strategy_id)) throw new Error("invalidBundle");
  if (!bundle.files || typeof bundle.files !== "object" || Array.isArray(bundle.files)) throw new Error("invalidBundle");
  const entries = Object.entries(bundle.files);
  if (!entries.length || entries.length > 200 || !Object.hasOwn(bundle.files, "strategy.yml")) throw new Error("invalidBundle");
  let total = 0;
  const encoder = new TextEncoder();
  for (const [name, content] of entries) {
    if (!name || typeof content !== "string") throw new Error("invalidBundle");
    const size = encoder.encode(content).length;
    total += size;
    if (size > 200_000 || total > 4_000_000) throw new Error("tooLarge");
  }
  return { format: "nerya.strategy", version: 1, strategy_id: bundle.strategy_id,
    title: typeof bundle.title === "string" ? bundle.title : undefined,
    files: Object.fromEntries(entries) as Record<string, string> };
}

export function downloadStrategyBundle(result: StrategyExport): void {
  const blob = new Blob([JSON.stringify(result.bundle, null, 2) + "\n"], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${result.bundle.strategy_id.replace(/[^A-Za-z0-9_-]/g, "_")}.nerya.json`;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  try { anchor.click(); }
  finally { anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
