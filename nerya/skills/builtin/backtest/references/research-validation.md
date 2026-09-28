# Bounded strategy research and evidence

Load for a requested research review, not every ordinary backtest. Use the
existing backtest and factor tools; this file does not define new API actions.

## Baseline and budget

Freeze the original strategy and first replay, including a losing baseline.
Record one hypothesis, the comparison window, the allowed scenario count and
stopping criteria before running experiments. Use the user's requested scope;
when unspecified, produce a bounded review plan and available evidence rather
than launch an unbounded search. No automatic optimization or production change.

Identify a result by strategy_id, proposal_id when present, backtest_ts,
source_revision, factor versions, dataset hashes, engine version, market,
instrument type, venue, timeframe, time range and cost assumptions. A reference
to a current source file is not an immutable baseline. Do not overwrite prior
manifests, repair the shared dataset in place for an experiment, or discard
failed runs. Verify shared data hashes before comparing runs.

## Chronological out-of-sample and walk-forward

Define train, validation and final holdout intervals before model/parameter
selection. Time-series observations are not randomly shuffled. Fit scalers,
quantile boundaries and selected thresholds using training observations only.
Purge labels overlapping the test boundary; use an explicit embargo when the
experiment requires it. State the label/holding horizon, not a magical gap size.

Each walk-forward fold must select parameters using only its earlier training
window, freeze them, then test the following window. Repeated slices of one
unchanged strategy are chronological stability checks, not retrained walk-forward.
Stitch only non-overlapping test intervals under explicit capital/state reset and
position-boundary rules. Do not silently compound isolated fold returns.

Record holdout state as planned, inspected or contaminated in the research note.
Viewing a final test is an inspection; using its outcome to change parameters,
features, markets or strategy selection contaminates it. Keep the old result and
use a genuinely untouched later interval. A long full-history backtest is not
automatically out of sample. There is no enforced holdout lock in the current
native engine; never describe this written procedure as an implemented lock.

## Stress and incremental component value

For an explicitly authorized cost comparison, native settings support
fee_bps_by_venue and slip_bps_by_venue. Change only the selected friction, preserve
capital and risk limits, and use override_candidate_backtest_defaults:true only
when the operator has authorized alternative candidate assumptions. Costs are
one-way basis points, not percentages or account fee quotes.

Useful bounded scenarios include original costs, double fees, double slippage
and combined friction. Show the original and stressed result, return/drawdown
changes, filled/rejected orders and data hashes. A trade-log fee subtraction is
only a sensitivity estimate: costs can alter capital, sizing and later fills.

For parameter neighborhoods choose a small predeclared range (such as ±10%),
preserve legal integer/positive bounds and do not select an isolated peak.
For ablation use baseline, +one component and -that component under matched data
and costs; do not assign a full strategy's profit to a single extracted factor.
Historical IC is not a component's incremental portfolio P&L.

Delay, missed orders, partial fills, capacity and funding shocks need a supporting
historical execution model. The current native settings do NOT implement a
latency-bars switch, liquidity participation, order book, margin or liquidation
model. Do not invent such flags, remove protection, or pass a limit order as a
market order to get a result. Record unsupported checks as blocked/not_run.

Removing top trades or bootstrapping trade returns is diagnostic resampling, not
a feasible alternate strategy. Record the seed, sampling unit, dependence
assumptions and sample count; use blocks when preserving temporal dependence is
necessary. Do not present resampled outcomes as live-profit probabilities.

## Data, execution assumptions and attribution

Report missing bars, duplicate times, source/market semantics and whether funding,
mark/index prices, exchange precision, minimum amounts, maker/taker differences,
liquidity and leverage rules are modeled. Omitted is not zero. Perpetual P&L with
no funding or liquidation model is not a complete perpetual net-return estimate.
Multi-timeframe indicators do not imply intrabar order simulation.

Use available trade/equity files for month/quarter, symbol and regime breakdowns.
Define regimes using information available at the classification time, and avoid
choosing regimes after seeing P&L. Show sample sizes, costs, drawdowns, losses and
profit concentration; undefined metrics stay null. Do not infer a tradable edge
from one short window or a few profitable outliers. Dry-run comparison requires
actual recorded signals/fills, not a promise that replay matches production.

## Output contract

Separate three conclusions: calculation completed, evidence recorded, research
requirements still missing. A PASS verdict is only the existing replay's economic
rule result; it is not a causality audit, OOS validation or production approval.

The native receipt's research_checks records which deeper checks THIS invocation
did not run. Missing metadata in an older/freeform report means not recorded,
not passed and not proof that no external experiment exists. Keep independent
experiments separate and cite their exact run/artifact IDs; do not amend the
baseline to pretend it performed those checks.

For each requested check report status (not_run, blocked, inconclusive, completed
with findings), scope, paired run IDs, source/data versions, assumptions,
coverage, limitations and next unresolved issue. Only claim a measured result
when an implemented runner actually produced it. Skill instructions and UI
labels are not evidence of execution. Preserve failures and negative findings.

End with a small number of findings and the highest-priority missing evidence.
Do not schedule repeated research, change accounts, activate a strategy or place
orders. A card's research-review action only prepares a user-editable chat draft.

## Sources

Local quant-research-lab: docs/00-标准研究流程.md, docs/02-回测与验收规范.md,
docs/03-因子库治理.md, docs/04-压力测试清单.md and
docs/07-个人量化策略研究工作法.md. Adopt baseline preservation, one-hypothesis
experiments, independent market validation and retention of failed evidence,
without importing a heavy optimization stack or a production-promotion workflow.

Freqtrade documents candle-level execution assumptions, exchange constraints,
result-cache limitations and optional lower-timeframe execution detail. Its
detail-timeframe option is a design reference, not an available Nerya flag.
https://docs.freqtrade.io/en/stable/backtesting/
