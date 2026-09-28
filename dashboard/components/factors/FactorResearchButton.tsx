"use client";

import { useRouter } from "next/navigation";
import { useLocale } from "next-intl";
import { setWorkspaceComposeDraft } from "../../lib/workspaceComposeDraft";
import { toast } from "../../lib/dialogs";
import type { Factor, FactorSource } from "../../lib/factorLibrary";
import { SparkIcon } from "../icons";

export function FactorResearchButton({ source, factor, className = "btn btn-secondary" }: { source?: FactorSource; factor?: Factor; className?: string }) {
  const zh = useLocale().startsWith("zh"), router = useRouter();
  const label = factor ? (zh ? "用于创建策略" : "Use in a strategy") : (zh ? "挖掘可复用因子" : "Extract reusable factors");
  return <button type="button" className={className} onClick={() => {
    const identity = source ? { strategy_id: source.strategy_id, ts: source.ts, ...(source.proposal_id ? { proposal_id: source.proposal_id } : {}) } : undefined;
    const text = factor
      ? (zh ? `加载 factor_library 和 strategy_author Skill，使用因子 ${factor.factor_id} 的固定版本 v${factor.version}（definition_hash=${factor.definition_hash}）创建策略。先读取并导出此版本，保留 factors.json 快照，不使用 latest。结合目标市场重新验证，不把因子 IC 当作策略收益；不要启动实盘。` : `Load factor_library and strategy_author. Create a strategy using ${factor.factor_id} v${factor.version} (definition_hash=${factor.definition_hash}). Read and export this exact version into factors.json, never latest. Revalidate for the target market; IC is not strategy performance. Do not activate live trading.`)
      : (zh ? `加载 factor_library Skill，${identity ? `从这次回测的冻结源码中提取可复用因子：${JSON.stringify(identity)}。` : "从我指定的策略或研究假设中提取可复用因子。"}先检索已有因子，再保存可解释的候选公式，使用真实本地历史行情验证并保留失败记录。不要把策略总收益归因给单个因子，不要生成提案，不要启动实盘。` : `Load factor_library. ${identity ? `Extract reusable factors from this frozen backtest: ${JSON.stringify(identity)}.` : "Extract reusable factors from my strategy or research hypothesis."} Search the library first, save explainable candidates directly, and validate on real local history. Preserve failed experiments. Do not infer factor attribution from total strategy returns, create proposals, or activate trading.`);
    if (!setWorkspaceComposeDraft({ text, attachments: [], autoSend: false })) {
      toast({ tone: "warn", message: zh ? "工作区尚未就绪，请稍后重试。" : "Workspace is not ready. Please retry." }); return;
    }
    router.push(`/chat?draft=factor-${Date.now()}`);
  }}><SparkIcon size={15}/>{label}</button>;
}
