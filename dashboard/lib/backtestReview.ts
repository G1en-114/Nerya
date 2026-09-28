/** A review targets one immutable report, never the latest strategy version. */
export type BacktestReviewTarget = {
  strategyId: string;
  ts: string;
  proposalId?: string | null;
  sourceRevision?: string;
};

export function backtestReviewDraft(target: BacktestReviewTarget, zh: boolean): string {
  const identity = JSON.stringify({
    strategy_id: target.strategyId, backtest_ts: target.ts,
    ...(target.proposalId ? { proposal_id: target.proposalId } : {}),
    ...(target.sourceRevision ? { source_revision: target.sourceRevision } : {}),
  });
  return zh
    ? `加载 backtest Skill 和 references/research-validation.md，复核这次固定回测：${identity}。读取该批次报告、数据与源码版本，不用最新策略替代。先核对已有的 bias_checks、research_checks、数据覆盖和执行假设；必要时再加载 references/causality-audit.md。区分静态扫描、动态因果审计、预热稳定性、样本外/Walk-forward、成本压力和消融的已记录证据与未执行项。列出最重要的问题和有预算的后续验证方案，不把回测完成或经济 PASS 当成验证有效。保留原始基准、失败记录及测试集污染说明；本次先做已有证据复核，不自动批量回测、调参、改风险设置、启用策略或下单。`
    : `Load the backtest Skill and references/research-validation.md. Review this exact frozen replay: ${identity}. Read this run's report, source and data versions, not the latest strategy. Inspect its bias_checks, research_checks, coverage and execution assumptions; load references/causality-audit.md only when needed. Separate recorded evidence from unperformed dynamic lookahead, warmup, OOS/walk-forward, cost-stress and ablation checks. Report priority findings and a bounded follow-up validation plan; completion or economic PASS is not research validation. Preserve the baseline, failures and holdout-contamination notes. Review existing evidence first; do not automatically launch a batch, tune, change risk, activate a strategy or trade.`;
}
