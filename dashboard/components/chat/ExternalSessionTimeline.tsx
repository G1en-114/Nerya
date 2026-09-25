"use client";

import { useMemo } from 'react';
import { useLocale } from 'next-intl';
import type { ExternalCallTrace } from '../../lib/externalCalls';
import type { UserMessage } from '../../lib/chat';
import { UserBubble } from './ChatMessage';
import { conversationEntries } from '../../lib/externalConversation';
import { ExternalCallMessage, externalStatus, type ExternalApprovalProps } from './ExternalCallMessage';
import { StreamedMarkdown } from './TurnBlocks';
import { ConversationSourceIcon } from './ConversationSourceIcon';
import styles from './ExternalConversation.module.css';

export function ExternalSessionTimeline({ traces, userMessages = [], expandTools, ...approvals }: { traces: ExternalCallTrace[]; userMessages?: UserMessage[];expandTools?:boolean } & ExternalApprovalProps) {
  const zh = useLocale().startsWith('zh');
  const entries = useMemo(() => conversationEntries(traces, userMessages), [traces, userMessages]);
  const toolCount = entries.filter(entry => entry.kind === 'tool').length;
  const running = traces.some(trace => trace.status === 'running');
  const labels: Record<string, [string, string]> = {
    intent: ['工作目标', 'Goal'], hypothesis: ['待验证方向', 'Tentative direction'], evidence: ['新发现', 'Observation'],
    conclusion: ['结论', 'Conclusion'], next: ['下一步', 'Next step'], status: ['工作状态', 'Work status'],
    purpose: ['操作说明', 'Action note'], progress: ['工作进展', 'Progress'], result: ['结果说明', 'Reported result'],
  };
  if (!entries.length) return <p className={styles.empty}>{zh ? '会话已建立，等待第一条调用。' : 'Session opened. Waiting for the first call.'}</p>;
  return <div data-testid="external-timeline" className={styles.conversation} aria-label={zh ? '外部会话工作过程' : 'External conversation activity'}>
    <div className={styles.feedHeader}><span>{zh ? '工作过程' : 'Conversation activity'}</span>
      <span aria-live="polite">{running ? (zh ? '正在执行' : 'Running') : (zh ? `${toolCount} 条工具记录` : `${toolCount} tool entries`)}</span>
    </div>
    {entries.map(entry => entry.kind === 'user' ? <UserBubble key={entry.id} msg={entry.message} /> : entry.kind === 'tool' ?
      <ExternalCallMessage key={entry.id} trace={entry.trace} node={entry.node} depth={entry.depth} mirroredId={entry.mirroredId} initiallyExpanded={expandTools} {...approvals} /> :
      <article key={entry.id} data-testid="external-activity" data-activity-kind={entry.label} data-call-id={entry.trace.call_id}
        className={`${styles.entry} ${styles.messageEntry}`}>
        <div className={`${styles.symbol} ${styles.agentSymbol}`}><ConversationSourceIcon source={entry.trace.source} size={16} /></div>
        <div className={styles.body}>
          <header className={styles.messageHeader}><span>{labels[entry.label]?.[zh ? 0 : 1] || entry.label}</span>
            {entry.state && <span className={styles.status} data-state={entry.state}>{externalStatus(entry.state, zh)}</span>}
          </header>
          <div data-testid={entry.label === 'result' ? 'external-progress-results' : undefined}><StreamedMarkdown text={entry.text} /></div>
        </div>
      </article>)}
  </div>;
}
