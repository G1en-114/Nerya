# Local historical data and reliable replay

## Short path

For a native strategy replay, prepare its config first. Use the SAME target and
config for `strategy_backtest(preflight_only=true, engine="native", ...)`.
This checks syntax, mandatory dependencies and known unsupported SDK surfaces
without importing strategy code, downloading prices, or running the strategy.
Repair concrete blockers in that candidate before a long download.

Call `historical_data(action="download", markets=[...], timeframes=[...],
start="2024-12-25", end="2026-01-01")` to prepare the period and extra warmup.
Then use `historical_data(action="inspect", ...)` for a network-free inventory
of coverage and gaps. A full 2025 replay uses `start_utc: "2025-01-01"` and
`end_utc: "2026-01-01"`. All dates are UTC; the end is EXCLUSIVE.

Execute `strategy_backtest(engine="native", proposal_id=<same candidate>,
config_path=<saved config>, data_mode="local")`. Local mode NEVER downloads
data. The same data is reused across strategies, configurations, and overlapping
time windows. Do not recreate a strategy just to change its replay dates.

## CLI equivalents

```sh
nerya data download --workspace <workspace> \
  --markets BINANCE:BTCUSDT BINANCE:ETHUSDT --timeframes 1h \
  --start 2024-12-25 --end 2026-01-01 --progress

nerya data list --workspace <workspace>

nerya data inspect --workspace <workspace> \
  --markets BINANCE:BTCUSDT BINANCE:ETHUSDT --timeframes 1h \
  --start 2024-12-25 --end 2026-01-01

nerya backtest --workspace <workspace> --proposal-id <candidate> \
  --config <workspace-relative-config.yml> --preflight-only

nerya backtest --workspace <workspace> --proposal-id <candidate> \
  --config <workspace-relative-config.yml> --data-mode local --progress
```

Successful calculation and strategy profitability are different. An economic
FAIL still has metrics; a preflight or worker failure has a diagnostic receipt,
not invented returns. No command above promotes, activates or trades an account.

## Configuration

```yaml
start_utc: "2025-01-01"
end_utc: "2026-01-01"
tf: 1h
timeframes: [1h]
warmup_bars: 60
data_mode: local
coverage_policy: strict
allow_timeframe_fallback: false
download_timeout_seconds: 300
max_run_seconds: 600
max_bars: 2000000
```

Keep the user's actual capital, sizing, position cap, fee/slippage, short-selling
and risk settings in this same file. Unknown keys, invalid booleans/timeframes,
negative costs and non-finite amounts are rejected rather than silently ignored.
One year must not quietly become the default 180-day preset. A calendar month
(`1M`) is not a minute (`1m`); unsupported intervals are explicit errors.

`coverage_policy: strict` blocks missing requested candles or insufficient
warmup BEFORE execution. Use `allow_partial` only for explicitly limited
research, and report the missing ranges and `coverage_ok:false`. Do not switch
to partial mode merely to make an acceptance test pass. This fixed-interval
coverage contract describes 24/7 markets. Session-based equities require a
calendar-aware data contract; do not generate weekend bars or pretend continuous
coverage verifies an equity trading calendar.

## Resumption and sources

The workspace-local `artifacts/backtest_cache/history-v2.sqlite3` is a
transactional database, not an external service. It stores closed candles by
venue-qualified market, exact timeframe and open timestamp. Spot/derivative
venues remain distinct. Successful segments commit immediately. Repeating a
partial or interrupted download fetches only missing leading, internal and
trailing intervals; a deadline or short page is NOT proof of exchange history
limits. Empty responses never mark a range as covered.

For supported Binance archives, long ranges use monthly files first and daily
files for the remainder; other venues reuse the existing market-data adapter in
bounded chunks. Transient failures have bounded retry budgets. The receipt
shows cached/downloaded rows, requests, gaps, source hash and job ID.

Sample/mock/paper data cannot enter the real-history store. Old JSON files named
`.parquet` are not silently trusted or overwritten: the explicit migration
helper imports them as `legacy_unverified`, excluded from verified replay reads.
They require actual source refresh, not relabelling, to become historical evidence.

## Failure evidence

A native run has `run.json` with the authoritative phase/status, `preflight.json`,
`data_manifest.json`, a saved `source/` snapshot and `replay_input.json` containing
the exact loaded rows. A completed run also has metrics, charts and trade CSVs.
An unsuccessful run has `failure.json`; worker failures retain `worker.log` and
structured error details, including market/bar when known. Never interpret a
config-only directory or a tool progress event as a completed backtest.

Execution runs in a dedicated child process with a parent-owned timeout and
cancellation. Ordinary Python network clients are disabled in that worker so
strategy code cannot accidentally query today's prices while replaying history.
This is execution isolation, not an operating-system security sandbox. Static
preflight cannot prove all dynamic branches; a late dynamic error is retained as
failure rather than turned into successful performance.

Do not delete stop-loss/take-profit rules on an unsupported protection error.
Provide an explicit historical execution model or report the unsupported
surface. Do not add strategy, venue, retry or coverage rules to Agent Loop.
