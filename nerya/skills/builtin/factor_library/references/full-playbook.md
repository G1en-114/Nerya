# Reusable factor research contract

## Formula language and missing data

Inputs: open, high, low, close, volume, plus declared finite numeric parameters.
Operations: +, -, *, /; abs(x), log(x); sma(x,n), ema(x,n), std(x,n), zscore(x,n),
ts_min(x,n), ts_max(x,n), delay(x,n), delta(x,n). Windows are trailing and bounded;
delay is nonnegative, every other window is positive. std is population std.
EMA uses adjust=False and n observations before output, with recursive history;
lookback is minimum availability, not proof of EMA initialization stability.
No Python eval/exec, attribute access, imports, indexing, negative shifts,
centered windows, full-series normalization or forward filling/backfilling.
Zero denominators and log of nonpositive values become missing, not infinity.
The strategy must only supply closed, timestamp-ordered candles.

## Evidence scope

Current evaluator supports one 24/7 crypto spot or perpetual market per run.
Do not apply its continuous calendar to equities or FX without a session-aware
adapter. Declare actual market instrument semantics; do not treat a symbol's
name as sufficient proof of spot/perpetual provenance.

The label is open[t+1+h]/open[t+1]-1: the factor is known at close[t], entry
is the following open, exit h bars later. Train is the first 70% by default.
Its final h+1 labels are purged so none settles in the test region. Quantile
edges are fit on training values only. The test period is inspected by this
run, not a sealed final holdout. Record fresh windows after hypothesis changes.

IC is Pearson correlation; Rank IC is Pearson correlation of average-tie
ranks (Spearman). Both are time-series statistics for one instrument, NOT a
cross-sectional IC. Undefined/constant statistics are null, never zero.
Test blocks are chronological diagnostics with fixed training thresholds,
NOT a full retrained walk-forward experiment. Correlation comparisons pin
both definitions and align samples in the same test window.

Forward returns overlap. Bucket spread and favored-bucket average are event
studies, NOT executable long/short portfolios. Fee/slippage adjustment subtracts
2*(fee_bps+slippage_bps) from the favored bucket's mean; stress doubles this
friction. These are sensitivity checks, not compounded returns. There is no
portfolio Sharpe, funding, liquidation, partial fill or market impact model.
Perpetual results explicitly flag missing funding; never call them net returns.

## Promotion and reuse

Saving always creates an immutable version with an optimistic concurrency
check. Factor evaluations append immutable manifests, compressed candle
snapshots and code/data hashes. Negative, blocked and failed runs remain.
No global validated or production flag is inferred. Even a good Rank IC does
not establish incremental strategy value. Before adoption, run the existing
strategy backtest with/without this factor under the same data and costs,
and test independent windows, parameter neighborhoods, regimes and capacity.
Carry forward every limitation. Market/timeframe/cost changes need new evidence.

`factors.json` is a list of exported snapshots. Read it relative to the strategy
file, not process cwd. Pass one snapshot and the SDK's closed candle rows to
calculate_factor. Test None/warmup behavior. The library and the backtest record
declared references; they do not prove that every declared factor affects trades.

CLI: `python -m nerya.skills.builtin.factor_library.scripts.library --workspace
<workspace> --json '<operation JSON>'` uses the same service as API and Agent.

## Design references

Local quant-research-lab: src/quant_lab/registry.py, runs.py,
docs/02-回测与验收规范.md, docs/03-因子库治理.md and factor_library/schema.example.json.
Its factor validation and full Freqtrade backtests are roadmap items, not
implemented features imported here. Nerya retains its own engine/data cache.
Freqtrade lookahead-analysis documentation explains negative-shift and
whole-series aggregation hazards; pandas Series.corr documents correlation
semantics. No empirical profitability claim follows from these references.
