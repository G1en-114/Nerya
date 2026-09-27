"use client";
import { copy as i18nCopy } from "../../lib/i18n";
import { useLocale } from 'next-intl';
import { liveEventsToBlocks, type ChatThread, type NativeBlock } from '../../lib/chat';
import { isShellTool } from './tool-cards/predicates';
import { ShellCard } from './tool-cards/ShellCard';

export function WorkspaceTerminal({ thread }: { thread: ChatThread | null }) {
  const zh = useLocale().startsWith('zh');
  const rows: NativeBlock[] = [];
  for (const message of thread?.messages || []) {
    if (message.role !== 'assistant') continue;
    const blocks = [...(message.turn?.blocks || []), ...liveEventsToBlocks(message.live_events || [])].map(env => env.block || env as NativeBlock).filter(isShellTool);
    const calls = new Map<string, NativeBlock>();
    blocks.forEach((block, index) => { const key = String(block.call_id || block.tool_call_id || index); const prior = calls.get(key); calls.set(key, prior ? { ...prior, ...block, payload: block.payload || prior.payload } : block); });
    rows.push(...calls.values());
  }
  return <div className="h-full overflow-auto p-4" data-testid="workspace-terminal">
    <p className="mb-4 text-xs text-[color:var(--text-muted)]">{i18nCopy(zh, "copy.components_chat_WorkspaceTerminal.001")}</p>
    {rows.length ? <div className="space-y-3">{rows.map((block, i) => <ShellCard key={i} block={block} variant={block.kind === 'tool_result' ? 'result' : 'use'} />)}</div> : <p className="py-8 text-center text-sm text-[color:var(--text-muted)]">{i18nCopy(zh, "copy.components_chat_WorkspaceTerminal.002")}</p>}
  </div>;
}
