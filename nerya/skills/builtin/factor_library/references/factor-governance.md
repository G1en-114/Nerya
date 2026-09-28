# Factor governance and scoped adoption review

Load only for a requested factor review, reuse or research campaign. Saving a
factor and running an ordinary replay do not require this entire checklist.
This reference adapts the useful governance ideas from goodperson888's Nerya
PR #1 into the native `factor_library` implementation in PR #4. It does not
install `quant_factor_library`, import another database, or change Agent Loop.

## One registry; distinguish lifecycle from evidence

Use `factor_library` for list/get/save/evaluate/export. The authoritative index
is `artifacts/factors/library.sqlite3` under the workspace, with immutable
definition versions and retained diagnostic runs. Do not create a parallel
`strategies/research/library.json`, move formulas between lifecycle directories,
or edit SQLite directly. Saving is direct, not a proposal or approval campaign.

The supported writable statuses are exactly `candidate`, `retired`, `rejected`.
A status edit uses `action="save"`, the latest `expected_version`, a complete
supported definition and a reason; it appends a version, never erases history.
Keep `factor_id`, exact version, source backtest and failed experiments traceable.

The broader lifecycle vocabulary is useful for review, but is NOT implemented
as additional registry states or automatic transitions:

| Review term | How to represent it honestly in Nerya |
| --- | --- |
| Candidate | A registered hypothesis; no claim of validated alpha. |
| Validated | A report conclusion for exact versions, markets, periods and costs, with linked independent evidence. Not a writable `validated` flag. |
| Production | A separately authorized strategy deployment, not a factor status or permission to trade. This Skill never activates a strategy. |
| Degraded | New evidence of decay in a previously studied scope; retain old runs, report the difference and recommend review. No automatic monitor or demotion exists. |
| Retired / rejected | Explicit, reasoned library revisions. Rejection needs actual failure evidence; unavailable data is blocked/inconclusive, not failed alpha. |

A completed evaluation means statistics were calculated. It does not promote
anything. A new version does not inherit a prior version's research conclusion.
Changing status does not rewrite snapshots already pinned in existing strategies.

## Map the research record to supported fields

Do not send the PR #1 schema verbatim: `FactorDefinition` rejects extra fields.

| Research requirement | Existing field or evidence location |
| --- | --- |
| Identity, family and economic logic | `factor_id`, `name`, `category`, `tags`, `description`, `hypothesis`; use tags for family, not a new `family` key. |
| Reproducible formula | `expression`, finite numeric `parameters`; export exact `version` and `definition_hash`, not an arbitrary Python `formula_path`. |
| Inputs, timing and missingness | Derived `inputs`, `lookback`, `available_at="bar_close"`, `missing_values="preserve_nan"`; these are output metadata, not editable definition fields. |
| Direction / normalization | `higher_is_bullish` or `lower_is_bullish`; put causal normalization in the expression, not an unsupported `normalization` key. |
| Applicability / exclusions | `markets`, `timeframes`; explain regimes, instrument assumptions and exclusions in `description`/`hypothesis` and the review report. Empty lists mean unspecified, not validated everywhere. |
| OOS, costs, sensitivity and correlation | Exact-version diagnostic runs and separate strategy backtests, preserving hashes, windows and limitations. Do not invent `validation_by_market` in the definition. |
| Turnover, decay and capacity | Separate, reproducible research evidence; they are not measured automatically by the factor evaluator. |
| Lineage and change history | `source_backtest` on the save operation, `expected_version`, `reason`, immutable versions and retained runs. |

Example supported definition, not seeded or validated:

```json
{
  "factor_id": "trend.slope20",
  "name": "Trailing mean slope",
  "category": "trend",
  "expression": "delta(sma(close, n), 1) / delay(sma(close, n), 1)",
  "parameters": {"n": 20},
  "direction": "higher_is_bullish",
  "markets": ["BINANCE:BTCUSDT"],
  "timeframes": ["1h"],
  "tags": ["family:moving_average_trend"],
  "description": "Closed OHLCV only. Spot research hypothesis; perpetual funding, non-24/7 calendars and other markets need separate evidence.",
  "hypothesis": "Test trend continuation; a ranging regime may reverse the effect. Applicability has not been established.",
  "status": "candidate"
}
```

## Reuse and independent information

Search before saving. `duplicates` checks canonical formula/parameter/direction
fingerprints; it is not statistical correlation deduplication. Conversely,
low pairwise correlation does not prove incremental predictive information.

For requested comparisons use `evaluate` with `compare:[{factor_id,version}]`
(at most five), the same explicit market, instrument type, timeframe and window.
Record sample overlap, missingness and exact versions. Missing, constant or
insufficient comparison samples are inconclusive, never a correlation of zero.
Check signed and absolute correlation: an inverted near-copy is still related.
Do not impose a universal correlation cutoff such as 0.7. Declare the criterion
for the target market and objective before inspecting results.

Check incremental strategy value with a frozen paired baseline and component
ablation under the same data and costs. A factor improving a failed strategy
can remain a component hypothesis; "less loss" is not standalone viability.
Profit Factor, drawdown, expectancy and trade counts belong to an executable
strategy test, not to an overlapping forward-return factor event study.

## Bounded evidence stages, not new runnable profiles

`smoke`, `fast_screen`, `full_validation` are review-scope labels only. There
are no new pipeline config files, actions or automated runners behind them.
Use the narrowest existing tool needed and agree the experiment budget first.

Smoke checks wiring, data timing, formula/missing-value behavior and representative
calculations. Fast screening may add declared train/validation windows and cheap
cost sensitivity. Stop on decisive failure and retain the baseline and bad runs.
Full review requires separate evidence for independent OOS windows, parameter
neighborhoods, regimes, cost/execution stress, ablation and concentration in a
few anomalous trades. Do not hard-code a universal number of windows or a
monthly review schedule. Thresholds and cadence depend on the stated objective.

Load `Skill(skill="backtest", file="references/research-validation.md")` for
the shared gate meanings and holdout rules. There is no enforced holdout lock
or native walk-forward runner. An inspected test window is contaminated for
later tuning; chronological diagnostic blocks are not retrained walk-forward.
Load `Skill(skill="backtest", file="references/causality-audit.md")` for the
limits of static lookahead and recursive/warmup checks. Unperformed checks stay
`not_run`; documented methodology is not an execution receipt.

For a decay review compare fresh evidence with the frozen historical baseline
and separate changes in data, costs, regime and implementation. Measure signal
horizon decay separately from long-term performance decay. Realized turnover
requires a declared rebalance/execution rule; capacity needs size, liquidity,
participation and impact assumptions. Mark all unavailable measurements as
unmeasured. Single-instrument IC, doubled fee sensitivity and a good historical
return cannot establish these properties or justify production adoption.

Finish with a scoped conclusion: exact factor/version; source/run identities;
market/instrument/timeframe/regime; data windows and hashes; baseline and
comparison versions; measured results; failed/blocked/unperformed checks;
applicability exclusions; and a bounded next step. Never infer global validation
or trading authorization from this report.
