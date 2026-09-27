const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const scope = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, "../lib/backtestCoverage.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: scope, exports: scope.exports });
const { backtestCoverage } = scope.exports;

test("old nonempty 30-day report is not a completed requested year", () => {
  const data = backtestCoverage({ start: "2025-01-01T00:00:00Z", end: "2025-01-30T23:00:00Z", tf: "1h", coverage_ok: true,
    provenance: { assumptions: { requested_window_days: 365 } } });
  assert.equal(data.requestedDays, 365); assert.equal(data.recordedDays, 30); assert.equal(data.state, "partial");
});
test("full 8760-hour window includes the final closed candle", () => {
  const data = backtestCoverage({ start: "2025-01-01T00:00:00Z", end: "2025-12-31T23:00:00Z", tf: "1h",
    requested_window_days: 365, requested_window_complete: true });
  assert.equal(data.recordedDays, 365); assert.equal(data.state, "complete");
});
test("full endpoints cannot override a manifest with missing candles", () => {
  const data = backtestCoverage({ start: "2025-01-01T00:00:00Z", end: "2025-12-31T00:00:00Z", tf: "1d",
    requested_window_days: 365, requested_window_complete: true, data_manifest: { requested_window_complete: false } });
  assert.equal(data.state, "partial");
});
test("missing completeness is unknown, not an invented successful check", () => {
  assert.equal(backtestCoverage({ requested_window_days: 365 }).state, "unknown");
});
