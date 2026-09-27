/** Canonical transcript units, before conversationEntries expands native cards. */
export type ExternalHistoryMessage = {
  message_id?: string;
  role: 'user' | 'assistant';
  content: string;
  ts?: string | number;
  turn_id?: string;
  meta?: Record<string, unknown>;
  turn?: Record<string, unknown> | null;
  history_key?: [number, number, string];
};

export type ExternalHistoryPage = {
  ok: boolean;
  session_id: string;
  pagination?: 'external_calls_v1';
  messages: ExternalHistoryMessage[];
  refreshed_messages?: ExternalHistoryMessage[];
  missing_call_ids?: string[];
  next_before_cursor?: string | null;
  next_after_cursor?: string | null;
  has_more?: boolean;
  has_newer?: boolean;
  history_revision?: number;
  read_at?: number;
  code?: string;
  reset_required?: boolean;
};

export type ExternalHistoryState = {
  session_id: string;
  messages: ExternalHistoryMessage[];
  history_revision: number;
  read_at: number;
  /** Each call can be refreshed independently from the latest history page. */
  versions: Record<string, number>;
  next_before_cursor: string | null;
  next_after_cursor: string | null;
  has_more: boolean;
  has_newer: boolean;
};

function callId(message: ExternalHistoryMessage): string | undefined {
  const call = message.turn?.external_call;
  return call && typeof call === 'object' && 'call_id' in call && typeof call.call_id === 'string'
    ? call.call_id : undefined;
}

function identity(message: ExternalHistoryMessage): string {
  const call = callId(message);
  return call ? `call:${call}` : `message:${message.message_id}`;
}

function compare(a: ExternalHistoryMessage, b: ExternalHistoryMessage): number {
  const x = a.history_key!, y = b.history_key!;
  return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
}

export type ExternalHistoryMerge =
  | { status: 'applied'; state: ExternalHistoryState }
  | { status: 'ignored' | 'reset' | 'error'; code?: string };

/**
 * Scope generation MUST change on workspace/session switch and history reset.
 * replace starts a contiguous tail/anchor window; older/newer extend its edges.
 * refresh updates loaded units only and preserves page cursors. To follow new
 * calls without gaps, use after=next_after_cursor (including at the tail),
 * draining pages while has_newer. Serialize requests extending each edge.
 * Never group or deduplicate by turn_id.
 */
export function applyExternalHistoryPage(
  current: ExternalHistoryState | null,
  page: ExternalHistoryPage,
  scope: { sessionId: string; requestGeneration: number; currentGeneration: number;
    mode: 'replace' | 'older' | 'newer' | 'refresh' },
): ExternalHistoryMerge {
  if (scope.requestGeneration !== scope.currentGeneration || page.session_id !== scope.sessionId
      || (current && current.session_id !== scope.sessionId)) return { status: 'ignored' };
  if (!page.ok) {
    return { status: page.reset_required || page.code === 'session_deleted' ? 'reset' : 'error', code: page.code };
  }
  if (page.pagination !== 'external_calls_v1' || page.read_at == null || page.history_revision == null
      || [...page.messages, ...(page.refreshed_messages || [])].some(m => !m.message_id || !m.history_key))
    return { status: 'error', code: 'invalid_external_page' };
  if (current && page.history_revision < current.history_revision) return { status: 'ignored' };
  if (current && scope.mode === 'replace' && page.read_at < current.read_at) return { status: 'ignored' };
  if (current && page.history_revision !== current.history_revision && scope.mode !== 'replace')
    return { status: 'reset', code: 'external_history_changed' };
  if (!current && scope.mode !== 'replace') return { status: 'reset', code: 'external_history_missing' };

  const replacing = scope.mode === 'replace';
  const messages = new Map((replacing ? [] : current!.messages).map(m => [identity(m), m]));
  const versions: Record<string, number> = replacing ? {} : { ...current!.versions };
  for (const message of [...page.messages, ...(page.refreshed_messages || [])]) {
    const key = identity(message);
    if (scope.mode === 'refresh' && !messages.has(key)) continue;
    if ((versions[key] ?? -Infinity) >= page.read_at) continue;
    const previous = messages.get(key);
    // Each API unit is a complete snapshot. Replace it, retaining DOM message
    // identity; shallow-merging nodes/status would resurrect stale approvals.
    messages.set(key, previous ? { ...message, message_id: previous.message_id } : message);
    versions[key] = page.read_at;
  }
  for (const id of page.missing_call_ids || []) {
    const key = `call:${id}`;
    if ((versions[key] ?? -Infinity) <= page.read_at) {
      messages.delete(key);
      versions[key] = page.read_at; // Keep a tombstone against late older pages.
    }
  }
  const updateBefore = replacing || scope.mode === 'older';
  const updateAfter = replacing || scope.mode === 'newer';
  return { status: 'applied', state: {
    session_id: scope.sessionId, messages: [...messages.values()].sort(compare),
    history_revision: page.history_revision, read_at: Math.max(page.read_at, current?.read_at ?? 0), versions,
    next_before_cursor: updateBefore ? page.next_before_cursor ?? null : current!.next_before_cursor,
    has_more: updateBefore ? Boolean(page.has_more) : current!.has_more,
    next_after_cursor: updateAfter ? page.next_after_cursor ?? null : current!.next_after_cursor,
    has_newer: updateAfter ? Boolean(page.has_newer) : current!.has_newer,
  } };
}
