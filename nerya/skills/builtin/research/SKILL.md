---
name: research
description: "External evidence and market research: web/pages, current news/social, stock and crypto-token analysis, fundamentals, tokenomics, on-chain context, and evidence-backed reports."
version: 0.4.0
license: MIT
author: Nerya
---

# Research

One workflow: establish the question, collect bounded evidence, analyse it,
then deliver the requested brief or report. Do not turn a research request
into strategy authoring, trading, or an unsolicited artifact.

## Core flow

Reuse provided captures and URLs before broad discovery. For fresh external
evidence, use one `research_run` request covering the complete question when
that tool is available. The collector uses exposed web tools directly and
must not delegate recursively. Fetch supplied URLs first. Read a returned
capture only when its summary lacks the detail needed for the claim.

For a market brief, add one `market_data` `summarize_market` call for the named
market. Do not substitute prices for requested fundamentals/news. Synthesize
the thesis, evidence, risks, invalidation and confidence in the same turn.
Additional collection must close a specific material gap, not repeat a
successful query. For a normal brief, fetch at most two exact primary URLs
for such gaps, then report remaining limitations and finish.

Use dated primary documents. Navigation shells, blocked pages, empty results
and HTTP success without relevant content are not evidence. Separate facts,
estimates and inference; retain source URL, publication/as-of date and fetch
time. Quantitative claims need a sourced value or an explicit data gap.
Credential or provider failures are limitations, not permission to invent
figures, repeat a failing loop or silently change the requested source.

## Interactive research deliverables

For EVERY reply researching named instruments (including a follow-up), publish
the relevant instruments and observed price data in THAT turn. The dashboard
renders a name/price/change/sparkline card at the end of that reply, not below
the composer. Reuse existing sourced evidence when still appropriate, keeping
its original as-of date; fetch fresh evidence when current data was requested.
Provide observed candlesticks for the right asset drawer
when available, and publish useful comparisons/flow studies to the left research
workspace. These interactive results are part of the requested research, not an
unsolicited standalone report. Do not leave chart code, ASCII diagrams or a
promise to plot as the deliverable.

Load `Skill(skill="research", file="references/visual-deliverables.md")`, then
execute `scripts/publish_visuals.py` with the collected evidence. Confirm its
`ok`, `receipt.chart_ids` and artifact readback before claiming publication.
Unavailable candles/news/flows are explicit data gaps, never simulated fills.

## On-demand references

Read only the matching file with `Skill(skill="research", file="<path>")`.
Long references return `next_offset` for continuation.

- Market/stock/token brief: `references/market-brief.md`.
- RSS, social evidence, freshness and feed setup: `references/news-and-social.md`.
- Report structure, rating and output QA: `references/reports.md`.
- Blocked pages, PDF extraction, engines and helper scripts: `references/collection.md`.
- Additional background and libraries: `references/full-playbook.md`, `references/libraries.md`.

`market_research`, `news_social` and `research_report` remain compatibility
entry points. Specialist valuation, filings and named frameworks are loaded
only when the assignment needs that method, not for every short brief.

## Optional methods

Use `Skill(skill="<name>")` for the relevant available method only:

- `equity_research`: company fundamentals, filings, valuation and coverage updates.
- `expert_investors`: select a Buffett, Damodaran, Marks, Mauboussin or Druckenmiller lens.
- `finance-creators`: only explicitly requested Serenity, Unusual Whales or Kobeissi views.
- `finance.financial_analysis`, `finance.fund_admin`, `finance.investment_banking`,
  `finance.operations`, `finance.private_equity`, `finance.wealth_management`:
  professional modelling, close, transaction, KYC, investment or advisory workflows.

Load one lens inline for a single perspective. Independent comparisons use
separate instances with the exact lens profiles and their existing restricted
policies. Reuse one collected evidence set; preserve disagreement. A method
selection grants no extra tools, source access or execution authority.
