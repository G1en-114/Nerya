"use client";

import { callApi, invalidateReadCache } from "./clientApi";
import { deleteThreadLocally, invalidateThreadTranscript, loadThreads, saveThreads } from "./chat";
import { clearChatDraft } from "./chatDraft";
import { getWorkspaceIdentity, subscribeWorkspaceIdentity, workspaceGeneration } from "./workspaceIdentity";

const pending = new Set<string>();
const revisions = new Map<string, number>();
subscribeWorkspaceIdentity(() => { pending.clear(); revisions.clear(); });
export const HISTORY_CHANGED_EVENT = "nerya:history-changed";
export const historyRevision = (id: string) => revisions.get(id) || 0;
export const historyPending = (id: string) => pending.has(id);
const bump = (id: string) => revisions.set(id, historyRevision(id) + 1);

export class HistoryActionError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export function historyErrorKey(error: unknown): string {
  const code = error instanceof HistoryActionError ? error.code : "";
  if (code === "history_busy") return "busy";
  if (code === "message_conflict") return "conflict";
  if (["message_not_found", "session_not_found", "session_deleted"].includes(code)) return "missing";
  if (code === "message_not_synced") return "notSynced";
  if (code === "content_too_long") return "tooLong";
  if (code === "message_read_only") return "readOnly";
  return "failed";
}
export type HistoryResult = { ok?: boolean; code?: string; error?: string; session_id?: string; message_id?: string; content?: string; title?: string; edited_at?: number; updated_at?: number };

/** Reject business failures as well as HTTP failures; never optimistically erase. */
export function commitMessageHistory(sessionId: string, messageId: string, backendId: string, patch: { text: string; edited_at?: number } | null): void {
  if (!getWorkspaceIdentity()) return;
  saveThreads(loadThreads().map(thread => {
    if (thread.id !== sessionId) return thread;
    const matches = (row: typeof thread.messages[number]) => row.id === messageId || row.backend_message_id === backendId;
    const messages = patch ? thread.messages.map(row => matches(row) && row.role === "user" ? { ...row, ...patch } : row)
      : thread.messages.filter(row => !matches(row));
    return { ...thread, messages, updated_ts: Date.now(), message_count: Math.max(0, (thread.message_count ?? thread.messages.length) - (patch ? 0 : 1)) };
  }));
}

export async function writeHistory(id: string, path: string, body: Record<string, unknown>): Promise<HistoryResult> {
  const workspace = getWorkspaceIdentity(), generation = workspaceGeneration();
  if (!workspace) throw new HistoryActionError("workspace_unknown");
  const current = () => workspace === getWorkspaceIdentity() && generation === workspaceGeneration();
  if (pending.has(id)) throw new HistoryActionError("history_busy");
  pending.add(id); bump(id);
  try {
    const result = await callApi<HistoryResult>(path, { method: "POST", body: { ...body, session_id: id }, signal: AbortSignal.timeout(15_000) });
    if (!current()) throw new HistoryActionError("workspace_changed");
    if (result.ok !== true || (result.session_id && result.session_id !== id))
      throw new HistoryActionError(result.code || result.error || "history_write_failed");
    invalidateReadCache();
    invalidateThreadTranscript(id);
    return result;
  } finally { if (current()) { pending.delete(id); bump(id); } }
}
export function notifyHistoryChanged(id: string) {
  window.dispatchEvent(new CustomEvent(HISTORY_CHANGED_EVENT, { detail: { sessionId: id } }));
}
export async function deleteConversation(id: string): Promise<void> {
  const generation = workspaceGeneration();
  if (loadThreads().find(thread => thread.id === id)?.messages.some(message => message.role === "assistant" && message.loading))
    throw new HistoryActionError("history_busy");
  await writeHistory(id, "/agent/session/delete", {});
  if (generation !== workspaceGeneration()) throw new HistoryActionError("workspace_changed");
  clearChatDraft(id);
  deleteThreadLocally(id);
  notifyHistoryChanged(id);
}
export async function renameConversation(id: string, title: string): Promise<string> {
  const generation = workspaceGeneration();
  const result = await writeHistory(id, "/agent/session/rename", { title });
  if (generation !== workspaceGeneration()) throw new HistoryActionError("workspace_changed");
  const saved = result.title || title;
  saveThreads(loadThreads().map(thread => thread.id === id ? { ...thread, title: saved, updated_ts: Date.now() } : thread));
  notifyHistoryChanged(id);
  return saved;
}
