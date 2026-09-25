"use client";

import { useMemo, useState } from 'react';
import { useLocale } from 'next-intl';
import type { ExternalCallNode, ExternalCallTrace } from '../../lib/externalCalls';
import { toolName, toolTitle, toolOutput, targetsOf } from '../../lib/externalConversation';
import { externalNodeMessage } from '../../lib/externalNative';
import type { ApprovalCard } from '../../lib/clientApi';
import { NativeBlocksTrack, activeProposalsFromTurn } from './TurnBlocks';
import { ResearchReplyCards } from './ResearchReplyCards';
import styles from './ExternalConversation.module.css';

export function externalStatus(status: string, zh: boolean) {
  const labels: Record<string, [string, string]> = {
    running: ['执行中', 'Running'], succeeded: ['完成', 'Completed'], failed: ['失败', 'Failed'],
    awaiting_approval: ['等待审批', 'Awaiting approval'], interrupted: ['已中断', 'Interrupted'],
    completed: ['任务完成 · 客户端上报', 'Task complete · client reported'], blocked: ['受阻', 'Blocked'],
  };
  return labels[status]?.[zh ? 0 : 1] || status;
}
export type ExternalApprovalProps = {
  pendingApprovals?: Map<string, ApprovalCard>;
  onApprovalAction?: (callbackData: string) => void;
  resolvingApprovalIds?: Set<string>;
};

/** Only session provenance differs. Never implement a second strategy/chart/tool renderer. */
export function ExternalCallMessage({ trace, node = trace, depth = 0, mirroredId, initiallyExpanded, ...approvals }: {
  trace: ExternalCallTrace; node?: ExternalCallNode; depth?: number; mirroredId?: string; initiallyExpanded?:boolean;
} & ExternalApprovalProps) {
  const zh = useLocale().startsWith('zh');
  const [expanded,setExpanded] = useState(initiallyExpanded ?? !["succeeded","completed"].includes(node.status));
  const [rawOpen, setRawOpen] = useState(false);
  const message = useMemo(() => externalNodeMessage(trace, node), [trace, node]);
  const proposals=activeProposalsFromTurn(message.turn);
  const target=targetsOf(node,toolOutput(node.result).data)[0];
  return <article id={node.call_id} data-testid={depth ? 'external-call-step' : 'external-call'}
    data-tool={toolName(node.tool)} data-source={trace.source} data-status={node.status} data-turn-id={trace.turn_id}
    className={styles.entry} style={{ marginLeft: Math.min(depth, 4) * 16 }}>
    {mirroredId && <span id={mirroredId} hidden />}
    <div className={styles.body}>
      <div className={styles.messageHeader}>
        <span role="status" data-state={node.status} className={styles.status}>{externalStatus(node.status, zh)}</span>
        {depth > 0 && <span>{zh ? '内部步骤' : 'Child step'}</span>}
      </div>
      <details open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}>
        <summary className="min-h-11 cursor-pointer py-3 text-sm">{toolTitle(node,zh)}{target?" · "+target:""}{typeof node.elapsed_ms==="number" ? " · "+node.elapsed_ms+"ms" : ""}</summary>
      {expanded && <NativeBlocksTrack envelopes={message.turn?.blocks || []} live={Boolean(message.loading)} presentation="expanded" {...approvals} />}
      </details>
      {!expanded&&proposals.map(proposal=><a key={String(proposal.id)} className="flex min-h-11 items-center gap-2 py-2 text-sm underline" href={"/strategies?strategy_id="+encodeURIComponent(String(proposal.strategy_id||""))+"&proposal_id="+encodeURIComponent(String(proposal.id))}>{String(proposal.summary||proposal.strategy_id)} · {zh?"查看候选与验证":"Review candidate and validation"}</a>)}
      <ResearchReplyCards message={message} />
      <details data-testid="external-technical-details" className={styles.raw} onToggle={event => setRawOpen(event.currentTarget.open)}>
        <summary>{zh ? '原始调用数据' : 'Raw call data'}</summary>
        {rawOpen && <pre>{JSON.stringify({ session_id: trace.remote_session_id, turn_id: trace.turn_id,
          call_id: node.call_id, parent_call_id: node.parent_call_id, native_call_id: mirroredId,
          tool: node.tool, input: node.arguments, output: node.result,
          ...(node === trace ? { native_steps: trace.nodes } : {}),
        }, null, 2)}</pre>}
      </details>
    </div>
  </article>;
}
