# Implementation and operator notes

## Entry points

- Dashboard: `/factors`, sidebar Factor library. Save/edit writes a new version
  directly. The old version and its evidence remain accessible.
- Backtest card: Extract & reuse factors opens the library with the exact
  strategy_id/backtest timestamp/proposal context. Backtest details have a
  Factor research tab. Declared references and subsequently extracted candidates
  are separate. Old reports with no snapshot say so; they are not reconstructed
  from today's source.
- Native Agent/MCP tool: `factor_library` (list/get/save/evaluate/export/data/
  backtest/extract). Methodology is in the Skill; no Agent Loop changes.
- SDK: `nerya.sdk.factors.calculate_factor(snapshot, closed_candles)`.
- API: GET `/factors/list`, `/factors/get`, `/factors/data`, `/factors/export`;
  POST `/factors/save`, `/factors/evaluate`, `/factors/backtest`, `/factors/extract`.

The runtime must restart after a code update to register the new native tool
and routes. New workspaces enable the Skill by default. Existing Skill
allow-lists are never silently expanded: the factor page offers an explicit
Enable factor Skill action using the existing version-checked management API.
The research button stages a contextual chat draft; it does not send it or
activate a trading strategy automatically.

## Files and retention

`artifacts/factors/library.sqlite3` contains immutable definition versions and
diagnostic records. `artifacts/factors/runs/<run_id>/manifest.json` pins the
definition, implementation hash, data hash, timestamps and assumptions.
`candles.csv.gz` is a frozen, compressed copy of the actual diagnostic inputs,
so later repair of the shared history cache does not replace the experiment.
Blocked and failed attempts remain visible. No default factor catalogue or
fabricated historical performance is installed.

Export returns a `factors.json` list. Put it in the strategy root. The SDK
computes from that snapshot without querying the library on each bar. At
native replay preflight, Nerya resolves/checks each declared library version
and records `factor_snapshot.json` with the backtest. A declaration proves
which version was referenced, not that it caused performance. For imports to
another workspace, register the same definitions/versions before replay;
the current preflight intentionally rejects missing local references.

## Scope and limits

This first implementation supports composable, causal OHLCV expressions and
single-instrument time-series research on a 24/7 crypto calendar. Fundamental,
order-book, funding and on-chain factor inputs are not yet evaluated here.
Arbitrary Python is not executed as a factor expression. Agent extraction is
semantic analysis of the frozen source followed by an explicit candidate save,
not proof that a translated expression reproduces every strategy behavior.

Training-fixed quantiles, purged chronological holdout, three test blocks,
correlations and fee/slippage sensitivity are diagnostic evidence. There is
no factor-production gate, cross-sectional portfolio optimizer, full
walk-forward retraining, funding model or capacity simulation. Use the native
strategy backtest for actual portfolio returns and ablation comparisons.

## Backtest research receipts

New native replays include `bias_checks` and `research_checks` in their tool
receipt, metrics and chart metadata. The chat card preserves them through tool
compaction and shows source warnings, checks not run in this invocation and
recorded execution-model limits. Older reports show missing evidence as not
recorded, never passed. Economic PASS is labelled separately from research
validation. These statuses do not describe experiments in other reports.

The review action prepares an editable message pinned to the source strategy,
proposal when present, timestamp and source revision. It never auto-sends or
starts a parameter search. The shared backtest references `causality-audit.md`
and `research-validation.md` cover deeper review on demand. Dynamic lookahead,
recursive stability, automated walk-forward and enforced holdout locking are
not implemented runners in this release; the Skill does not invent those APIs.

## Reproducible checks

From agent root:

```sh
.venv/bin/python -m pytest tests/test_factor_library.py tests/test_backtest_research_contract.py tests/test_backtest_skill.py tests/test_backtest_chart_details.py tests/test_backtest_preflight_pipeline.py tests/test_builtin_skill_catalog.py -q
cd dashboard
./node_modules/.bin/tsc --noEmit
node --test tests/backtest-reply-cards.test.cjs tests/backtest-coverage.test.cjs
npx --no-install playwright test -c playwright.factors.config.ts
```

UI tests use a disposable workspace under dashboard/test-results, synthetic
TESTUSDT candles and real factor/Skill HTTP endpoints. Other shell polling is
stubbed. They never reuse a personal trading workspace, configure a real
account, run a live model or send an order. Synthetic screenshots are test
evidence only, not an example of profitable research.
The backtest-card browser scenarios stub their report/transcript data and test
desktop English, mobile Chinese, keyboard expansion and no-auto-send review
drafts. They are UI contract tests, not Agent/LLM execution or market validation.
