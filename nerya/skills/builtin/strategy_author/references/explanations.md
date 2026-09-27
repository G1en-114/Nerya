# Strategy explanations and review contract

Read when creating or changing a Python strategy, documenting its workflow, or
proposing a review/evolution change. Write explanations in the user's language.

## Source comments: @nerya.version 1

Every new or edited executable strategy script carries standalone Python comments.
Keep the header before the first step; place each step beside the actual block it
describes. Preserve stable step IDs when editing so readers can compare versions.
Comments are documentation, not executable links or evidence that a step ran.

```python
# @nerya.version 1
# @nerya.title 已收盘信号检查
# @nerya.description 只在已收盘 K 线满足信号条件时继续研判。
# @nerya.logic 先筛选已收盘数据，再计算信号；数据不足或信号重复时停止。
# @nerya.rationale 排除未收盘价格波动，避免同一信号反复触发。
# @nerya.scope main.py 的数据筛选与信号分支；调度频率和账户权限保持不变。
# @nerya.input 配置品种的 K 线、周期、当前时钟和上次信号时间。
# @nerya.output 符合条件时派发研判；否则返回停止原因。
# @nerya.risk 数据延迟可能错过信号；本说明不代表回测或实盘效果。
# @nerya.validation 尚未执行；需检查正向信号、未收盘尾柱和重复信号。
# @nerya.change 数据筛选 | 直接读取最后一根 | 筛选后读取最后一根已收盘数据 | 避免形成中的 K 线干扰

# Place these comments next to the corresponding implementation blocks:
# @nerya.step closed | 筛选已收盘数据 | 按开盘时间加周期与当前时钟比较。
# @nerya.next signal | 可用历史满足计算要求
# @nerya.next stop | 没有足够的已收盘数据
# @nerya.step signal | 计算并检查信号 | 满足规则且未重复时派发，否则停止。
# @nerya.next stop | 信号未满足或已处理
# @nerya.step stop | 停止本轮 | 保存明确的停止原因。
```

This is a syntax example: author comments against the actual source you read,
including thresholds, units, failure branches and affected resources.

- Required header fields: version, title, description, logic, rationale, scope,
  input, output, risk, validation, plus at least one step for the actual logic.
- title/description/logic/rationale are single prose lines. Repeat scope and
  validation for multiple items. Repeat input/output/risk for multiple facts;
  after a step these three describe that step.
- `step id | title | explanation`: ID starts with an ASCII letter, followed by
  letters, digits, underscores or hyphens, maximum 64 characters, unique per file.
- `next target_id | condition`: follows its source step and refers to an existing
  step. Include only explicit design branches; file order alone is not an edge.
- `change target | before | after | reason`: required for an existing behavior
  change; repeat per changed rule. Describe behavior in words, with real parameter
  values where useful. Keep this section about the current revision, not accumulated
  history. For a new baseline omit change; explain the initial design in rationale.
- Fields and descriptions are plain text, up to 2000 characters per comment.
  Use no more than 100 steps, 30 scope/validation/change entries and 200000 source
  characters per displayed script. Split larger scripts by responsibility.
- Quoted examples, docstrings and inline trailing comments are not annotations.
  Ordinary module docstrings remain the display fallback for legacy scripts.

Versioned annotations are checked during strategy validation; incomplete fields,
duplicate IDs or dangling branches block validation. Unversioned legacy scripts
remain compatible. When editing one, add the complete versioned header rather
than merely copying a new version tag. Validation checks structure, not the truth
of an explanation: compare every claim to source and actual test receipts.

## Review output

The review begins with the conclusion and why the evidence justifies a change.
In the existing output object provide:

- `summary`: readable conclusion; `rationale`: evidence-based reason;
  `scope`: affected rules, parameters, files and downstream behavior.
- `proposed_changes[]`: retain materializable file/kind/after_content or
  config_after/yaml_after; also write summary, before_summary, after_summary,
  scope (string array), and rationale for each change. Code stays in after_content,
  never in the prose fields.
- `evidence[]`: source and finding. Distinguish observed facts from hypotheses.
- `expected_effect`, `risk_flags`, `validation_plan`: expected tradeoffs,
  failure conditions and planned checks. Only actual receipts establish results.

If no change is warranted, return `proposed_changes: []` and explain the decision
and evidence limits in summary. Label rejected and advisory changes honestly.
Creating a proposal does not establish that it was approved, applied, or profitable.

Before final validation, read the saved files: header and step descriptions must
match the current logic and the review's before/after scope. Run final-file
validation and the checks already required by the authoring workflow.
