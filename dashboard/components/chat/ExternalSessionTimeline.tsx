"use client";

import { useMemo,useRef,type RefObject } from 'react';
import { useLocale } from 'next-intl';
import { ConversationFind } from './ConversationFind';
import { TurnWindow, useReadingAnchor } from './ConversationTimeline';
import { useTimelineReveal } from './timelineReveal';
import type { ExternalCallTrace } from '../../lib/externalCalls';
import type { UserMessage } from '../../lib/chat';
import { UserBubble } from './ChatMessage';
import { conversationEntries } from '../../lib/externalConversation';
import { ExternalCallMessage, externalStatus, type ExternalApprovalProps } from './ExternalCallMessage';
import { StreamedMarkdown, activeProposalsFromTurn } from './TurnBlocks';
import { externalNodeMessage } from '../../lib/externalNative';
import { collectBacktestResults } from '../../lib/backtestResults';
import { ConversationSourceIcon } from './ConversationSourceIcon';
import styles from './ExternalConversation.module.css';

export function ExternalSessionTimeline({ traces, userMessages = [], expandTools, scrollRef, session:sessionProp, hasMore, onOlder, loadingOlder, ...approvals }: { traces: ExternalCallTrace[]; userMessages?: UserMessage[];expandTools?:boolean;scrollRef?:RefObject<HTMLDivElement>;session?:string;hasMore?:boolean;onOlder?:()=>void;loadingOlder?:boolean } & ExternalApprovalProps) {
  const zh = useLocale().startsWith('zh');
  const entries = useMemo(() => conversationEntries(traces, userMessages), [traces, userMessages]);
  const proposalDisplay = useMemo(() => {
    const owners = new Map<string, string>(), verdicts: Record<string, string> = {};
    for (const entry of entries) {
      if (entry.kind !== 'tool') continue;
      const message = externalNodeMessage(entry.trace, entry.node);
      for (const proposal of activeProposalsFromTurn(message.turn)) owners.set(String(proposal.id), entry.id);
      for (const result of collectBacktestResults({ messages: [message] })) {
        if (result.proposalId) verdicts[result.proposalId] = result.status === 'completed' ? result.verdict : 'FAIL';
      }
    }
    const idsByEntry = new Map<string, string[]>();
    for (const [id, owner] of owners) idsByEntry.set(owner, [...(idsByEntry.get(owner) || []), id]);
    return { idsByEntry, verdicts };
  }, [entries]);
  const scopeRef=useRef<HTMLDivElement>(null),fallbackRoot=useRef<HTMLDivElement>(null);
  const root=scrollRef||fallbackRoot;
  const session=sessionProp||[traces[0]?.source,traces[0]?.remote_session_id].join(":");
  const {forced,reveal,cancel}=useTimelineReveal({session,scopeRef,scrollRef:root,hasMore,onOlder,loadingOlder,
    resolveUnit:id=>entries.find(entry=>entry.id===id||(entry.kind==='tool'&&entry.node.call_id===id))?.id});
  useReadingAnchor(session,scopeRef,root,entries.length,reveal);
  const findEntries=useMemo(()=>entries.map(entry=>({id:entry.id,text:entry.kind==='user'?entry.message.text:entry.kind==='message'?entry.text:JSON.stringify({tool:entry.node.tool,input:entry.node.arguments})})),[entries]);
  const toolCount = entries.filter(entry => entry.kind === 'tool').length;
  const running = traces.some(trace => trace.status === 'running');
  const labels: Record<string, [string, string]> = {
    intent: ['工作目标', 'Goal'], hypothesis: ['待验证方向', 'Tentative direction'], evidence: ['新发现', 'Observation'],
    conclusion: ['结论', 'Conclusion'], next: ['下一步', 'Next step'], status: ['工作状态', 'Work status'],
    purpose: ['操作说明', 'Action note'], progress: ['工作进展', 'Progress'], result: ['结果说明', 'Reported result'],
  };
  if (!entries.length) return <p className={styles.empty}>{zh ? '会话已建立，等待第一条调用。' : 'Session opened. Waiting for the first call.'}</p>;
  return <div key={session} ref={scopeRef} data-timeline-session={session} data-testid="external-timeline" className={styles.conversation} aria-label={zh ? '外部会话工作过程' : 'External conversation activity'}>
    {scrollRef&&<ConversationFind key={session} session={session} scrollRef={scrollRef} entries={findEntries} onCancelReveal={cancel} onReveal={(id,match,signal)=>reveal({session,id,match,focus:false},signal)} hasMore={hasMore} onOlder={onOlder} loadingOlder={loadingOlder}/>}
    <div className={styles.feedHeader}><span>{zh ? '工作过程' : 'Conversation activity'}</span>
      <span aria-live="polite">{running ? (zh ? '正在执行' : 'Running') : (zh ? `${toolCount} 条工具记录` : `${toolCount} tool entries`)}</span>
    </div>
    {hasMore&&<button type="button" disabled={loadingOlder} onClick={onOlder} className="min-h-9 text-xs">{loadingOlder?(zh?'加载中…':'Loading…'):(zh?'加载更早记录':'Load older history')}</button>}
    {entries.map(entry => <TurnWindow key={entry.id} unit={{id:entry.id,live:entry.kind==='tool'&&['running','awaiting_approval','waiting_approval','pending_approval','blocked'].includes(entry.node.status)}} root={root} session={session} forced={!scrollRef||forced===entry.id}>
      <div data-find-entry={entry.id}>
      {entry.kind === 'user' ? <UserBubble msg={entry.message}/> : entry.kind === 'tool' ?
      <ExternalCallMessage key={entry.id} trace={entry.trace} node={entry.node} depth={entry.depth} mirroredId={entry.mirroredId} initiallyExpanded={expandTools} proposalIds={proposalDisplay.idsByEntry.get(entry.id) || []} backtestVerdicts={proposalDisplay.verdicts} {...approvals} /> :
      <article key={entry.id} data-find-entry={entry.id} data-testid="external-activity" data-activity-kind={entry.label} data-call-id={entry.trace.call_id}
        className={`${styles.entry} ${styles.messageEntry}`}>
        <div className={`${styles.symbol} ${styles.agentSymbol}`}><ConversationSourceIcon source={entry.trace.source} size={16} /></div>
        <div className={styles.body}>
          <header className={styles.messageHeader}><span>{labels[entry.label]?.[zh ? 0 : 1] || entry.label}</span>
            {entry.state && <span className={styles.status} data-state={entry.state}>{externalStatus(entry.state, zh)}</span>}
          </header>
          <div data-find-text data-testid={entry.label === 'result' ? 'external-progress-results' : undefined}><StreamedMarkdown text={entry.text} /></div>
        </div>
      </article>}</div></TurnWindow>)}
  </div>;
}
