"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useLocale } from "next-intl";

import { clientApi } from "../../lib/clientApi";
import type { EvolutionEvidenceItem, EvolutionProposalDetail } from "../../lib/evolutionTypes";

function recordedConfidence(metadata: Record<string, unknown> | undefined): number | null {
  const value = metadata?.research_confidence;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

export function StrategyCreationEvidence({ strategyId, proposalId }: { strategyId: string; proposalId: string }) {
  const zh = useLocale().startsWith("zh");
  const [proposal, setProposal] = useState<EvolutionProposalDetail | null>(null);
  const [items, setItems] = useState<EvolutionEvidenceItem[]>([]);
  const [rationale, setRationale] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setProposal(null);
    setItems([]);
    setRationale("");
    setError("");
    setLoading(true);
    async function load() {
      try {
        const detail = await clientApi.proposalDetail(proposalId);
        if (detail.error) throw new Error(detail.error);
        const linkedStrategy = String(detail.metadata?.strategy_id || "");
        if (linkedStrategy && linkedStrategy !== strategyId) throw new Error("Proposal strategy mismatch");
        const refs = Array.isArray(detail.evidence_refs)
          ? [...new Set(detail.evidence_refs.filter((ref): ref is string => typeof ref === "string" && !!ref.trim()))]
          : [];
        const rationaleRef = typeof detail.path === "string" && detail.path
          ? `file:${detail.path}/rationale.md`
          : "";
        const resolved = refs.length || rationaleRef
          ? await clientApi.evolutionEvidenceResolve({ refs: [...refs, ...(rationaleRef ? [rationaleRef] : [])] })
          : null;
        if (resolved && !resolved.ok) throw new Error("Evidence resolution failed");
        if (!cancelled) {
          setProposal(detail);
          setItems((resolved?.items || []).filter((item) => item.ref !== rationaleRef));
          const rationaleItem = (resolved?.items || []).find((item) => item.ref === rationaleRef);
          setRationale(String(rationaleItem?.artifacts?.[0]?.preview || "").trim());
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [strategyId, proposalId]);

  const refs = proposal?.evidence_refs || [];
  const confidence = recordedConfidence(proposal?.metadata);
  const resolvedCount = items.filter((item) => item.resolved && item.type !== "proposal").length;

  return <section className="border-t border-[color:var(--line)] px-5 py-6 sm:px-7" data-testid="strategy-creation-evidence">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="text-base font-semibold">{zh ? "策略创建证据" : "Strategy creation evidence"}</h3>
        <p className="mt-1 text-xs text-ink-400">{zh ? "仅展示提案明确关联的来源；文件变更和模型陈述不算独立证据。" : "Only sources explicitly linked to this proposal. File changes and model statements are not independent evidence."}</p>
      </div>
      <Link className="text-xs underline underline-offset-4" href={`/self-evolution?tab=proposals&proposal_id=${encodeURIComponent(proposalId)}`}>{zh ? "查看完整提案" : "View proposal"}</Link>
    </div>
    {loading ? <p className="mt-4 text-sm text-ink-400" role="status">{zh ? "读取证据中..." : "Loading evidence..."}</p> : null}
    {error ? <p className="mt-4 text-sm text-danger" role="alert">{zh ? "证据读取失败：" : "Evidence unavailable: "}{error}</p> : null}
    {proposal ? <>
      <div className="mt-4 grid gap-3 border-y border-[color:var(--line)] py-3 text-sm sm:grid-cols-3">
        <div><div className="text-xs text-ink-400">{zh ? "提案" : "Proposal"}</div><code className="break-all">{proposal.id}</code></div>
        <div><div className="text-xs text-ink-400">{zh ? "可解析的非提案记录" : "Resolved non-proposal records"}</div><strong>{resolvedCount} / {refs.length}</strong></div>
        <div><div className="text-xs text-ink-400">{zh ? "研究置信度" : "Research confidence"}</div><strong>{confidence === null ? (zh ? "未记录" : "Not recorded") : `${Math.round(confidence * 100)}%`}</strong></div>
      </div>
      {confidence !== null ? <p className="mt-2 text-xs text-ink-400">{zh ? "该数值来自提案元数据，未经过独立校准，不代表获利概率。" : "Recorded in proposal metadata; not independently calibrated or a profit probability."}</p> : null}
      {rationale ? <details className="mt-4 text-sm"><summary className="cursor-pointer font-medium">{zh ? "创建时的分析说明" : "Creation rationale"}</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs text-ink-300">{rationale}</pre></details> : <p className="mt-4 text-sm text-ink-400">{zh ? "未保存创建时的分析说明。" : "No creation rationale was recorded."}</p>}
      {refs.length === 0 ? <p className="mt-4 text-sm text-warn" role="status">{zh ? "此提案没有关联证据引用，无法核验创建依据。" : "No evidence references were linked to this proposal; its creation basis cannot be verified."}</p> : <div className="mt-4">
        <h4 className="text-sm font-medium">{zh ? "创建时关联的证据" : "Evidence linked at creation"}</h4>
        <ul className="mt-2 divide-y divide-[color:var(--line)]">
          {items.map((item) => <li key={item.ref} className="py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><span className={item.resolved ? "text-emerald-400" : "text-warn"}>{item.resolved ? (zh ? "记录可用" : "Record available") : (zh ? "无法解析" : "Unresolved")}</span><strong className="break-words">{item.title || item.ref}</strong></div>
            <code className="mt-1 block break-all text-xs text-ink-400">{item.ref}</code>
            {item.type === "proposal" ? <p className="mt-1 text-xs text-warn">{zh ? "这是提案记录，不是独立研究来源。" : "This is a proposal record, not an independent research source."}</p> : null}
            {item.summary ? <p className="mt-1 break-words text-xs text-ink-300">{item.summary}</p> : null}
            {!item.resolved && <p className="mt-1 text-xs text-warn">{item.reason || (zh ? "原始记录不可用" : "Source record unavailable")}</p>}
            {item.resolved && item.record != null ? <details className="mt-2"><summary className="cursor-pointer text-xs underline underline-offset-4">{zh ? "查看脱敏原始记录" : "Inspect redacted source record"}</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs text-ink-300">{JSON.stringify(item.record, null, 2)}</pre></details> : null}
            {item.resolved && item.artifacts?.length ? <details className="mt-2"><summary className="cursor-pointer text-xs underline underline-offset-4">{zh ? "查看原始记录预览" : "Inspect source preview"}</summary><div className="mt-2 space-y-2">{item.artifacts.map((artifact, index) => <div key={`${artifact.path || artifact.title}:${index}`}><div className="break-all text-xs text-ink-400">{artifact.title || artifact.path}{artifact.truncated ? (zh ? " · 已截断" : " · truncated") : ""}</div>{artifact.preview ? <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs text-ink-300">{artifact.preview}</pre> : <p className="text-xs text-ink-400">{zh ? "没有可展示的内容预览" : "No preview available"}</p>}</div>)}</div></details> : null}
          </li>)}
        </ul>
      </div>}
    </> : null}
  </section>;
}

export function PublishedStrategyCreationEvidence({ strategyId }: { strategyId: string }) {
  const zh = useLocale().startsWith("zh");
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setProposalId(null);
    setError("");
    setLoading(true);
    void clientApi.proposalsList().then((result) => {
      if (cancelled) return;
      const candidates = (result.proposals || []).filter((proposal) =>
        proposal.kind === "strategy_package_proposal" && proposal.state === "applied" &&
        (proposal.metadata?.strategy_id === strategyId || proposal.target === `strategies/${strategyId}`),
      );
      candidates.sort((a, b) => String(a.ts || a.created_at || "").localeCompare(String(b.ts || b.created_at || "")));
      setProposalId(candidates[0]?.id || null);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [strategyId]);

  if (proposalId) return <StrategyCreationEvidence strategyId={strategyId} proposalId={proposalId} />;
  return <section className="border-t border-[color:var(--line)] py-5 text-sm" data-testid="strategy-creation-evidence">
    <h3 className="font-semibold">{zh ? "策略创建证据" : "Strategy creation evidence"}</h3>
    <p className="mt-2 text-ink-400" role="status">{loading ? (zh ? "查找创建提案中..." : "Looking up creation proposal...") : error ? `${zh ? "查询失败：" : "Lookup failed: "}${error}` : (zh ? "未关联已生效的创建提案，无法核验原始分析和置信度。" : "No applied creation proposal is linked; the original analysis and confidence cannot be verified.")}</p>
  </section>;
}
