---
name: factor_library
description: "Mine reusable causal factors from a strategy or frozen backtest, validate against local historical data, and save/export version-pinned factors for new strategies. 因子库、因子挖掘、因子提取、复用、IC、分层检验。"
version: 0.2.0
license: MIT
author: Nerya
metadata:
  nerya:
    catalog_parent: analysis
---

# Factor Library

Build reusable research assets from explicit strategy hypotheses. Do not invent
an unbounded factor factory or optimize until historical returns become positive.

## Workflow

1. `factor_library(action="list", query=...)`: reuse before creating duplicates.
2. For a backtest, `action="extract"` with its exact `strategy_id`, `ts` and, when
   applicable, `proposal_id`. This reads the frozen source, not today's strategy.
   Source may be bounded/truncated. Read only the missing frozen file if needed.
3. Identify one explainable component (momentum, trend, volatility, volume or
   mean reversion). Translate its calculation into the supported causal formula
   language. Explain differences; do not claim equivalence to unsupported code.
4. `action="save"` with `definition`, `expected_version:0` for new factors,
   `reason` and the exact `source_backtest` identity. Edits use the current
   `expected_version`. Saving is direct: no proposal/approval workflow. A new
   revision does not inherit prior validation. Record rejected hypotheses too.
5. `action="data"` lists existing cache windows. `action="evaluate"` requires
   factor_id, exact version, explicit VENUE:SYMBOL market, timeframe, start/end
   UTC [inclusive,exclusive), instrument_type (spot/perpetual), fee_bps and
   slippage_bps. Optional horizon (default 5), test_fraction (default .3), and
   compare:[{factor_id,version}] (up to 5). Evaluation is LOCAL ONLY: repair
   missing history via `historical_data`, preserving the requested range.
6. Inspect the returned run: IC/Rank IC, training-fixed quantile groups,
   purged train/test split, chronological test blocks, cost sensitivity,
   correlation, missingness and explicit pending checks. Completed means
   calculated, not validated. Do not convert event-study means to strategy P&L.
7. For a new strategy, `action="export"` with exact version. Save the returned
   `factors.json` in the strategy package and compute using
   `nerya.sdk.factors.calculate_factor(snapshot, closed_candles)`. The snapshot
   is self-contained; never resolve latest while running. Native backtests
   verify declared pins and save their own immutable factor_snapshot.json.
   Export does not write a strategy; use the existing strategy-authoring tools.

## Definition example (not a seeded or validated factor)

```json
{"factor_id":"momentum.return20","name":"20-bar momentum","category":"momentum",
 "expression":"close / delay(close, n) - 1","parameters":{"n":20},
 "description":"Trailing closed-bar return","hypothesis":"Test whether recent direction persists",
 "direction":"higher_is_bullish","markets":[],"timeframes":[],"tags":["price"]}
```

Read `references/full-playbook.md` for formulas, statistical scope and limits.
For leakage/warmup questions load `Skill(skill="backtest", file="references/causality-audit.md")`.
For adoption into a strategy load `Skill(skill="backtest", file="references/research-validation.md")`:
require paired baseline/component evidence, not an attribution inferred from IC.
Factor chronological blocks are not retrained walk-forward; their inspected test
window cannot remain an untouched holdout after tuning. These are requested
review workflows, not extra steps required for every save or ordinary backtest.
Never modify Agent Loop to enforce this methodology. Never activate a strategy,
trade an account, or promote a factor to production from this Skill.
