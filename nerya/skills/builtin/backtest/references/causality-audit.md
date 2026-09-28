# Causality and initialization review

Load only for an explicit leakage, repainting or warmup review. The ordinary
backtest path does not run this campaign. Do not change Agent Loop.

## What exists, and what does not

The native replay preflight scans selected Python patterns. The supported market
context exposes closed historical prefixes and aligns auxiliary bars by close
time; strategy intents settle at the next available bar open. Final-bar intents
with no later open are rejected. End-of-run liquidation of an existing position
is a separate engine assumption, not a strategy signal fill.

These are implementation guards, not a measured dynamic audit of every strategy.
External files, imports, mutable globals, model knowledge and custom data paths
are not proven causal by the SDK prefix. A warning is not a pass. Conversely,
an AST pattern alone is not proof of realized P&L contamination: feature versus
label use, historical-prefix versus full-frame calculation, axis and activation
matter. Preserve the finding and explain scope; do not delete controls just to
silence preflight. Use a causal rewrite or a separately justified research path.

There is currently no native dynamic-lookahead or recursive-audit action on
strategy_backtest. Do not invent flags or invoke Freqtrade commands on a Nerya
package. The procedures below require an implemented, isolated runner or a
separately requested helper with tests; otherwise report not_run/blocked.

## Dynamic lookahead procedure for a future audit runner

1. Pin the original source tree, parameters, factor snapshots, data hashes,
   market/timeframes, execution model and seed. Freeze a baseline; do not modify
   the actual strategy, shared history cache or original report.
2. Establish repeatability first: repeat an unchanged input in fresh isolated
   workers/state. If semantic results differ, report inconclusive/nondeterminism,
   not leakage. Ignore generated IDs only when comparing them is meaningless;
   never discard price, size, side, timestamp or strategy state differences.
3. Select bounded checkpoints BEFORE reading results, covering entry, hold,
   exit and unusual branches. Preserve the entire past including initial state.
   In a derived experiment copy truncate or perturb only observations whose
   available_at is after the checkpoint. Keep signal timestamps and data
   publication times distinct; a higher-timeframe open is not its availability.
4. Compare indicator series when actually recorded, decisions, explicit signals
   and order intents at shared historical decision times. Compare fills only
   when their execution times are inside the shared prefix. Exclude only
   audit-boundary forced liquidation and unfillable terminal orders from that
   boundary comparison; changing horizon intentionally changes those artifacts.
5. A changed past semantic output is a finding to investigate. Record first
   differing time, field, before/after values and the affected source path.
   Do not use final portfolio return equality as the causality test.
6. Report checkpoints, checked branches, tolerances, comparison counts and
   excluded boundaries. No triggered signals or unexercised branches means
   insufficient coverage, never a universal no-lookahead conclusion.

This is bounded experimental evidence, not proof about arbitrary Python. Do not
invoke a live model as a historical oracle: training knowledge may postdate the
historical decision. Agent dispatch replay is not historical model validation.

## Warmup / recursive stability procedure

Freeze the formula and target decision interval. Vary ONLY the history before
that interval, for example 50/100/200/500 bars within the user's data and compute
budget. These numbers are examples, not automatic new defaults.

At multiple shared timestamps compare indicator values and signal flips against
a longer-history reference. Report absolute error, relative error where a
nonzero denominator exists, missing values, and decision disagreement. When a
reference is zero, use a stated absolute tolerance rather than dividing by zero.
NaN or insufficient history is unavailable, not zero error. A long reference
can itself be unstable; test convergence rather than declaring it ground truth.

Different replay P&L after different start dates is not by itself a recursive
indicator defect: prior trades, state and capital can differ. Isolate indicator
initialization from trading-state initialization. Record a recommended warmup
only after measurement and do not silently rewrite the candidate's settings.

## Common review targets

Negative time shifts, backward/linear interpolation, centered windows, forward
or nearest timestamp joins, full-dataset normalization, retrospectively confirmed
structure labels, resampled bars before close and external revised datasets all
deserve context-aware review. A literal iloc[-1] on a closed historical prefix
is not inherently future access. Linear interpolation may use a later endpoint
even with limit_direction='forward'; that flag does not establish causality.

## Reference and limits

Adapted for Nerya from local quant-research-lab docs/00-标准研究流程.md and
docs/14-ETH永续第一阶段数据记录.md. Those documents are research requirements,
not proof that their automated audits are implemented.

Freqtrade official lookahead-analysis compares a baseline with additional
signal-focused runs. Untriggered signals remain unchecked, and delayed limit
orders can cause false positives. Its diagnostic configuration changes must not
be copied into Nerya's performance baseline or user's risk settings.
https://docs.freqtrade.io/en/stable/lookahead-analysis/

Freqtrade recursive-analysis compares indicator initialization with different
startup histories at the last row; it does not establish entry/exit stability.
Nerya reviews should distinguish indicator drift from actual signal changes.
https://www.freqtrade.io/en/stable/recursive-analysis/
