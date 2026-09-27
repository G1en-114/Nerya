<!-- nerya-skill-frontmatter-start -->
---
name: evolve
description: "Use whenever the agent (or operator) wants to extend Nerya itself \u2014 propose a new skill, scaffold an exchange adapter, draft an SDK helper, write a capability proposal, or work through a self-improvement reflection. Triggers on \"propose a new skill\", \"add support for exchange X\", \"Nerya can't do Y, fix it\", \"write an SDK for\", \"reflect on the last session\", \"what should I improve\". This skill is the only place where the agent is allowed to author code that lands inside `nerya/`; everything else stays in the workspace."
version: 0.1.0
license: MIT
author: Nerya
---
<!-- nerya-skill-frontmatter-end -->

# Evolve playbook

This skill is the agent's path to self-modification. It exists so
that growth happens through proposals and reviews rather than
improvised edits in the wrong directories.

## What "evolve" covers

- **Skill proposals.** Drafting a new SKILL.md (similar in shape to
  the ones in `nerya/skills/builtin/`) plus the supporting scripts.
- **Workflow-to-skill conversion.** When a task repeats, a complex
  runbook works, or a correction keeps recurring, turn the procedure
  into a lazy-loaded skill proposal instead of storing it in memory or
  bloating the default prompt.
- **Capability scaffolds.** New exchange adapters, new SDK helpers,
  new primitive tools that the agent will eventually call directly.
- **Reflection.** Periodic, structured self-review of recent
  sessions to identify recurring failure modes and queue concrete
  improvements.

It does **not** cover ad-hoc patches inside `nerya/`. If the
proposal is "fix this bug in nerya/foo.py", route it through the
coding skill, not here.

## Authoring a new skill

1. Capture intent: what is the new skill for, what triggers it, what
   shape are its inputs/outputs?
2. If the skill comes from a repeated or newly proven workflow, use
   `skill_manage` with action `save`, plus `name`, `description`,
   `workflow`, `triggers`, and `evidence_refs`. The validated
   `SKILL.md` is saved directly into the Workspace and a new Skill is
   enabled immediately.
3. For an existing Workspace Skill, set `update_existing=true`; the
   save replaces the current playbook in the same operation.
4. List helper scripts or references in `script_notes` /
   `reference_notes`; do not create proposal scaffolding around them.

## When to convert a workflow into a skill

Convert the workflow when at least one of these is true:

- The same multi-step procedure has been run or requested more than
  once.
- A run took substantial tool use and produced a stable sequence worth
  reusing.
- The operator corrected the same behaviour more than once.
- A task needed a specific checklist, source order, command sequence,
  or acceptance flow that should be lazy-loaded later.

Do not convert temporary status, one-off decisions, or project facts
into skills. Put durable facts in memory, and put procedures in
skills.

## Authoring an exchange / chain adapter

1. Read the current adapter interface (look at the legacy
   `exchange_skill` archive for shape) before writing anything.
2. Write the adapter as a standalone Python module under
   `workspace/proposals/exchanges/<name>/` first. The operator
   promotes it into `nerya/` after review.
3. Include a minimal smoke-test script that exercises read paths
   only. Do *not* include order-placing tests in the proposal.

## Reflection

A reflection run should answer three questions, in order:

1. **What did I get right?** Specific behaviours, not vibes.
2. **Where did I waste tokens or time?** Look at the journal — what
   loops, repeats, or backtracking happened?
3. **What change would have prevented the waste?** The change must
   be concrete (a skill edit, a new helper, a different default).

Vague conclusions are not useful; if you cannot name the change,
the reflection is incomplete.

## Bundled scripts

| Script | Purpose |
|---|---|
| `scripts/propose_skill.py` | Scaffold a workflow-to-skill PatchProposal. |

Adapter scaffolding and reflection use the native tools
`evolve_reflect`, `evolve_proposals`, and the coding skill until a
dedicated script is added.

All read JSON payload via `--json` / `--payload-file` / stdin.

## Hard rules

- **No direct edits to `nerya/`.** Even if it would be faster.
  Proposals belong in `workspace/proposals/`.
- **No silent self-amendment.** Every change to a built-in skill
  goes through the operator review queue.
- **Reflection is not therapy.** Avoid abstract self-criticism; if
  the conclusion isn't a code-shaped change, it doesn't belong.
