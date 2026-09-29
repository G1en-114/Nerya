import { useCallback, useEffect, useState } from "react";

export type DemoCase = {
  id: number; name: string; status: "filled" | "rejected"; newExecutors: number;
  planId: string | null; reason: string; policyHash: string | null;
  actionHash: string | null; planHash: string | null;
  authorizationTx: string | null; authorizationStatus: number | null;
  newOrders?: number | null; newFills?: number | null; chainReason?: string | null;
};
export type MandateDemo = {
  schemaVersion: 1; mode: "local-paper-recording"; runId: string; recordedAt: string | null;
  chainId: number; contract: string; revocationTx: string | null;
  cases: DemoCase[];
  policies: { hash: string; owner: string; agent: string; scope: string; marketHash: string; marketLabel: string | null; maxCost: string; budget: string; validAfter: number; validUntil: number; allowLong: boolean; nonce: string }[];
  receipts: { transactionHash: string; status: number; blockNumber: number; gasUsed: number }[];
  budgetSteps?: { step: number; policyHash: string; notionalUsd: number; ceiling: string; budget: string; chainSpent: string; localSpent: string; remaining: string; chainReason: string | null; blockNumber: number; fills: number; fillCostUsd: number }[];
  reconciliation?: { faultInjected: boolean; injectedDeltaBase: number; baselineReportId: string; reportId: string; detectedAt: number; severity: string; haltPersisted: boolean; scope: string; automaticResume: boolean; blockedAttempts: number; differences: { kind: string; positionId: string; market: string; expectedNet: number; observedSize: number }[] } | null;
};

export function useMandateDemo() {
  const [data, setData] = useState<MandateDemo | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(v => v + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setState("loading"); setData(null);
    void (async () => {
      try {
        const response = await fetch("/mandates/demo.json", { cache: "no-store", signal: controller.signal });
        if (response.status === 404) { setState("missing"); return; }
        if (!response.ok) throw new Error("Demo unavailable");
        const result = await response.json();
        if (result.schemaVersion !== 1 || result.mode !== "local-paper-recording" || result.chainId !== 31337 ||
            typeof result.runId !== "string" || !Array.isArray(result.cases) || !result.cases.length ||
            !result.cases.every((c: DemoCase) => ["filled", "rejected"].includes(c.status) && Number.isInteger(c.newExecutors) && c.newExecutors >= 0) ||
            !Array.isArray(result.policies) || !Array.isArray(result.receipts)) throw new Error("Invalid demo");
        if (!controller.signal.aborted) { setData(result); setState("ready"); }
      } catch { if (!controller.signal.aborted) setState("error"); }
    })();
    return () => controller.abort();
  }, [revision]);
  return { data, state, refresh };
}

const labels: Record<string, [string, string, string, string]> = {
  kill_switch_enabled: ["停止开关已生效", "Persisted stop enforced", "工作区停止开关阻止了新的交易请求；链上授权不能覆盖此限制。", "The workspace stop blocks the next trade request; chain authorization cannot override it."],
  action_not_anchored: ["动作未获链上授权", "Action is not authorized on chain", "运行时未找到有效的链上动作授权，拒绝执行。", "The runtime cannot find valid on-chain authorization for this action and refuses execution."],
  invalid_budget: ["授权额度配置无效", "Invalid policy budget", "累计预算不能小于单笔上限，后端拒绝这份授权。", "The policy budget is below its per-action ceiling; the backend rejects the policy."],
  action_cost_exceeded: ["动作超过单笔上限", "Action exceeds limit", "Agent 签署的动作成本超过用户授权的单笔额度。", "The signed action ceiling exceeds the user's per-action limit."],
  session_budget_exceeded: ["累计预算不足", "Policy budget exceeded", "本次动作会使同一 Policy 的累计用量超限。", "This action would exceed the cumulative budget of the same policy."],
  authorized: ["授权范围内执行", "Within the signed policy", "签名和链上授权通过检查，完成模拟成交。", "The signed, anchored action completed paper execution."],
  market_not_allowed: ["市场越界", "Market outside scope", "允许市场改变后，原 BTC 请求不再被允许。", "The BTC request stops after the user changes the permitted market."],
  resolved_cost_exceeds_signed_ceiling: ["费用后超限", "Costs exceed the ceiling", "计入模拟手续费与滑点后，成本超过签署上限。", "Simulated fees and slippage push the cost above the signed ceiling."],
  long_opening_not_allowed: ["禁止新开多头", "Long opening prohibited", "禁止新开多头的授权不能用于开多。", "The policy prohibits opening a new long position."],
  plan_tampered: ["动作被篡改", "Signed plan changed", "签署后的计划被修改，与已签署哈希不一致。", "The submitted plan no longer matches the signed plan hash."],
  action_replayed: ["重复动作被阻止", "Replay stopped", "同一动作经恢复路径重发，也不能重复成交。", "Resubmitting through the resume path cannot repeat the fill."],
  mandate_revoked: ["用户撤销授权", "User revoked the policy", "已登记的动作在用户撤销授权后被拒绝。", "An anchored action is stopped after the owner revokes the policy."],
};
export function caseCopy(c: DemoCase, zh: boolean) {
  if (c.chainReason === "session_budget_exceeded") return {
    title: zh ? "拆单仍超出累计预算" : "Split orders still exceed the budget",
    description: zh ? "第三笔在链上因累计预算不足被拒绝，运行时也因没有链上授权而停止。" : "The third authorization reverts on the cumulative budget; the runtime also stops because that action has no chain authorization.",
  };
  const entry = labels[c.reason];
  return entry ? { title: entry[zh ? 0 : 1], description: entry[zh ? 2 : 3] } : { title: c.name, description: c.reason };
}
