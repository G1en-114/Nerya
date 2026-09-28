import type { AssistantMessage, ChatThread, NativeBlock, NativeBlockEnvelope } from './chat';
import { conversationEntries, fileBody, toolName, toolOutput } from './externalConversation';
import { conversationTimestamp, isExternalSource, recordOf, type ExternalCallNode, type ExternalCallTrace } from './externalCalls';
import { collectResearchVisuals } from './researchVisuals';
import { isChartBlockShape } from './chartBlock';

/** Transport adapter only. Business rendering belongs to the normal native block pipeline. */
export function externalNodeMessage(trace: ExternalCallTrace, node: ExternalCallNode = trace): AssistantMessage {
  const running = node.status === 'running';
  const out = toolOutput(running ? undefined : node.result);
  const name = toolName(node.tool);
  const separator = !node.tool.startsWith('nerya_native_') ? name.indexOf('__') : -1;
  const action = separator > 0 ? name.slice(separator + 2) : name;
  const skill = separator > 0 ? name.slice(0, separator) : 'native';
  const failed = node.status !== 'succeeded' || out.data.ok === false || Boolean(out.error);
  // Unwrap MCP content parts once; retain every structured business field. Raw transport
  // remains in external_call, not in the user's strategy/report content.
  const result = { ...out.data };
  if (Array.isArray(result.content) && result.content.every(part => ['text', 'json', 'shell', 'diff'].includes(String(recordOf(part).type)))) delete result.content;
  if (result.name === node.tool || result.name === action) delete result.name;
  if (out.text) result.text = fileBody(node, out);
  if (out.stdout) result.stdout = out.stdout;
  if (out.stderr) result.stderr = out.stderr;
  if (out.diffs.length) result.diff = out.diffs.join('\n');
  const block: NativeBlock = { kind: running ? 'tool_use' : 'tool_result', call_id: node.call_id,
    action, skill_id: skill, payload: recordOf(node.arguments), elapsed_ms: node.elapsed_ms,
    metadata: recordOf(out.data.metadata),
    ...(!running ? { result, ok: !failed, error: out.error || null, error_kind: typeof recordOf(result.error).code === 'string' ? String(recordOf(result.error).code) : null } : {}),
  };
  const blocks: NativeBlockEnvelope[] = [{ block }];
  if (!failed) for (const value of node.presentation_blocks || []) {
    if (isChartBlockShape(value)) blocks.push({ block: { ...value, ts: undefined, call_id: node.call_id } });
  }
  const message: AssistantMessage = { id: node.call_id, role: 'assistant',
    ts: conversationTimestamp(node.started_at || trace.started_at) ?? 0, loading: running,
    turn: { harness: 'external', turn_id: trace.turn_id, blocks } };
  if (!failed) {
    // Same result traversal as local research. Includes stdout_json and bulk descriptors,
    // but never infers instruments from prose or resurrects failed/request-only output.
    const research = collectResearchVisuals({ messages: [message] });
    const ids = new Set(blocks.map(env => env.block?.chart_id).filter(Boolean));
    for (const chart of research.charts) if (!ids.has(chart.chart_id)) {
      blocks.push({ block: { ...chart, ts: undefined, call_id: node.call_id } }); ids.add(chart.chart_id);
    }
  }
  return message;
}

/** Feed ALL existing collectors (charts, resources, portfolio, browser, agents)
 * the same native blocks, including on reload of pre-adapter saved sessions. */
export function projectExternalThread(thread: ChatThread | null): ChatThread | null {
  if (!thread) return thread;
  if (!Array.isArray(thread.messages)) return { ...thread, messages: [], transcript_loaded: false };
  const source = isExternalSource(thread.source) ? thread.source : thread.id.match(/^ext_(mcp|tunnel)_[0-9a-f]{32}$/)?.[1];
  const hasCalls = thread.messages.some(message => message.role === 'assistant' && message.turn?.external_call);
  if (!hasCalls) return source && source !== thread.source ? { ...thread, source } : thread;
  return { ...thread, source: source || thread.source, messages: thread.messages.map(message => {
    if (message.role !== 'assistant' || !message.turn?.external_call) return message;
    const trace = message.turn.external_call;
    if (trace.remote_session_id !== thread.id) return message;
    const blocks = conversationEntries([trace]).flatMap(entry => entry.kind === 'tool'
      ? externalNodeMessage(trace, entry.node).turn?.blocks || [] : []);
    return { ...message, turn: { ...message.turn, blocks } };
  }) };
}
