<!-- nerya-skill-frontmatter-start -->
---
name: quant_research
metadata:
  nerya:
    catalog_parent: analysis
description: "Use for factor research, statistical analysis, leakage checks, signal validation, backtest diagnostics, and performance attribution."
version: 0.2.0
license: MIT
author: Nerya
---
<!-- nerya-skill-frontmatter-end -->

# Quant Research

Use when a trading idea needs statistical evidence rather than only a
narrative thesis.

## Flow

DEFINE hypothesis and universe.
LOAD clean timestamped data.
CHECK leakage, survivorship, missingness, and regime splits.
MEASURE IC, hit rate, turnover, drawdown, costs, and robustness.
COMPARE to a naive baseline.
REPORT whether the signal survives practical constraints.

When research yields a reusable component, load `factor_library` to search,
save a versioned candidate, run local diagnostics and export a pinned snapshot.
Do not confuse an overall strategy backtest with single-factor attribution.

## Lazy References

- Strategy robustness or holdout review: load `Skill(skill="backtest", file="references/research-validation.md")`.
- Leakage, repainting or recursive warmup: load `Skill(skill="backtest", file="references/causality-audit.md")`.
- Freeze the original baseline, test one hypothesis and keep failed experiments.
  Methodology is not an implemented audit action; do not fabricate results or
  mistake a completed single replay for out-of-sample/production validation.
- `references/full-playbook.md` for detailed research and validation checks.
