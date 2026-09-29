<!-- nerya-skill-frontmatter-start -->
---
name: llm
metadata:
  nerya:
    catalog_parent: coding
description: "Use for a separate one-shot LLM helper task such as summarizing, translating, rewriting, labeling, or drafting text."
version: 0.1.0
license: MIT
author: Nerya
---
<!-- nerya-skill-frontmatter-end -->

# LLM Helper

Use this only when a separate model call transforms supplied content.
Do not use it for the main agent's own reasoning.

## Flow

DEFINE the transform: summarize, translate, rewrite, classify, or draft.
BOUND the input and output size.
PASS only the needed source text.
CHECK the result for instruction drift and missing constraints.
RETURN the transformed artifact.

## GWDC efficiency evidence

`scripts/gwdc_efficiency.py` explains three supplied paper-run outcomes through
Kiln, saving one public record per HTTP attempt and a per-flow token/energy
report. Operator entry point from the repository root:

```powershell
python -m scripts.gwdc_efficiency run --source .tmp/gwdc-workflow-20260929/evidence.json --output .tmp/gwdc-efficiency --import-env-key
python -m scripts.gwdc_efficiency report --output .tmp/gwdc-efficiency
```

The first command imports the configured Kiln credential into an isolated
SecretVault; no key is accepted on the command line or exported. This helper
is an evidence-text transform, not a trading decision or authorization tool.
Only bounded public fields from the source are sent. HTTP usage is recorded
without tokenizer estimation; absent usage remains unknown. The report labels
its energy coefficients as illustrative assumptions, not NPU measurements.
Completed identical requests are reused; incomplete attempts remain in the
accounting. Do not share the private Vault or infer full competition compliance
from this helper's report.

## Lazy References

- `references/full-playbook.md` for detailed helper-call patterns.
