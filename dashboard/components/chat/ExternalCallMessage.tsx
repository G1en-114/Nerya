"use client";

import { useMemo, useState } from 'react';
import { useLocale } from 'next-intl';
import type { ExternalCallNode, ExternalCallTrace } from '../../lib/externalCalls';
import { toolName, toolTitle, toolOutput, targetsOf, fileRange, fileBody, toolKind } from '../../lib/externalConversation';
import { externalNodeMessage } from '../../lib/externalNative';
import type { ApprovalCard } from '../../lib/clientApi';
import { NativeBlocksTrack, activeProposalsFromTurn } from './TurnBlocks';
import { contentValue, readableResult } from "../../lib/agentConversation";
import { StreamedMarkdown, StrategyProposalsHoist } from "./TurnBlocks";
import { ResearchReplyCards } from './ResearchReplyCards';
import { BacktestReplyCards } from './BacktestReplyCards';
import { Icon } from "../icons";
import { recordOf } from "../../lib/externalCalls";
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
export function ExternalCallMessage({ trace, node = trace, depth = 0, mirroredId, initiallyExpanded, proposalIds, backtestVerdicts, ...approvals }: {
  trace: ExternalCallTrace; node?: ExternalCallNode; depth?: number; mirroredId?: string; initiallyExpanded?:boolean;
  proposalIds?: string[]; backtestVerdicts?: Record<string, string>;
} & ExternalApprovalProps) {
  const zh = useLocale().startsWith('zh');
  const [disclosure,setDisclosure] = useState<{status:string;open:boolean}|null>(null);
  const expanded = disclosure?.status === node.status ? disclosure.open : initiallyExpanded ?? !["succeeded","completed"].includes(node.status);
  const [rawOpen, setRawOpen] = useState(false);
  const message = useMemo(() => externalNodeMessage(trace, node), [trace, node]);
  const proposals=activeProposalsFromTurn(message.turn)
    .filter(proposal => !proposalIds || proposalIds.includes(String(proposal.id)))
    .map(proposal => backtestVerdicts?.[String(proposal.id)] ? { ...proposal, backtest_verdict: backtestVerdicts[String(proposal.id)] } : proposal);
  const rawOutput=toolOutput(node.result),kind=toolKind(node),range=fileRange(node,rawOutput);
  const command=recordOf(node.arguments).command;
  const target=targetsOf(node,rawOutput.data)[0];
  const resultBlock=message.turn?.blocks?.map(env=>env.block||env).find(block=>block.kind==="tool_result");
  const output=readableResult(contentValue(resultBlock?.result),zh);
  const visualBlocks=(message.turn?.blocks||[]).filter(env=>["chart","attachment","approval_request"].includes(String((env.block||env).kind||"")));
  const needsPermission=["awaiting_approval","waiting_approval","pending_approval"].includes(node.status);
  return <article id={node.call_id} data-testid={depth ? 'external-call-step' : 'external-call'}
    data-find-entry={node.call_id} data-tool={toolName(node.tool)} data-source={trace.source} data-status={node.status} data-turn-id={trace.turn_id}
    className={styles.entry} style={{ marginLeft: Math.min(depth, 4) * 16 }}>
    {mirroredId && <span id={mirroredId} hidden />}
    <div className={styles.body}>
      <details className={styles.toolDetails} open={expanded} onToggle={event=>{const open=event.currentTarget.open;if(open!==expanded)setDisclosure({status:node.status,open});}}>
        <summary className={styles.toolSummary}><Icon name={kind==="shell"?"terminal":"document"} size={14}/><span className={styles.toolSubject}>{toolTitle(node,zh)}{target?" · "+target:""}</span><span role="status" data-state={node.status} className={styles.status}>{externalStatus(node.status, zh)}</span>{typeof node.elapsed_ms==="number"&&<span className={styles.duration}>{node.elapsed_ms}ms</span>}</summary>
        {expanded&&<>{needsPermission ? <NativeBlocksTrack envelopes={message.turn?.blocks || []} live={Boolean(message.loading)} presentation="expanded" {...approvals}/> : <div className="max-h-80 overflow-auto py-2 text-xs">{kind==="shell"?<><pre className="whitespace-pre-wrap break-words text-xs">{typeof command==="string"?"$ "+command+String.fromCharCode(10):""}{rawOutput.stdout}{rawOutput.stderr?String.fromCharCode(10)+rawOutput.stderr:""}</pre>{typeof rawOutput.data.exit_code==="number"&&<p className="mt-2 text-[color:var(--text-muted)]">exit {rawOutput.data.exit_code}</p>}</>:kind==="read"?<><p className="mb-2 text-[color:var(--text-muted)]">{zh?"文件内容":"File contents"}{range.start!==null&&range.end!==null?" · "+range.start+"–"+range.end:""}</p><pre className="whitespace-pre-wrap break-words text-xs">{fileBody(node,rawOutput)}</pre></>:<StreamedMarkdown text={output || (message.loading ? (zh ? "等待工具返回…" : "Waiting for tool output…") : (zh ? "没有正文输出。" : "No text output."))}/>}</div>}
          {rawOutput.error&&<p role="status" className="py-2 text-xs text-danger">{rawOutput.error}</p>}
          {!needsPermission && visualBlocks.length>0&&<NativeBlocksTrack envelopes={visualBlocks} presentation="expanded" {...approvals}/>}
          <details data-testid="external-technical-details" className={styles.raw} onToggle={event=>setRawOpen(event.currentTarget.open)}><summary>{zh?"原始调用数据":"Raw call data"}</summary>{rawOpen&&<pre>{JSON.stringify({session_id:trace.remote_session_id,turn_id:trace.turn_id,call_id:node.call_id,tool:node.tool,input:node.arguments,output:node.result},null,2)}</pre>}</details>
        </>}
      </details>
      {proposals.length>0&&<div className="my-4"><StrategyProposalsHoist proposals={proposals}/></div>}
      <ResearchReplyCards message={message} />
      <BacktestReplyCards message={message} />

    </div>
  </article>;
}
