import type { ChatAttachment, ChatRunSettings } from "./chat";
import { getWorkspaceIdentity, subscribeWorkspaceIdentity, workspaceGeneration, workspaceStorageKey } from "./workspaceIdentity";

export type ChatDraft = { text: string; attachments: ChatAttachment[]; settings?: ChatRunSettings; revision?: number };
export type DraftReceipt = { workspace: string; generation: number; scope: string; revision: number };
export const EMPTY_CHAT_DRAFT: ChatDraft = { text: "", attachments: [] };
const PREFIX = "nerya.chat.draft.v2:";
const LEGACY_PREFIX = "nerya.chat.draft.v1:";
const memory = new Map<string, ChatDraft>();
subscribeWorkspaceIdentity(() => memory.clear());
export const hasChatDraft = (draft: ChatDraft) => Boolean(draft.text || draft.attachments.length || draft.settings);

export function readChatDraft(scope: string, workspace = getWorkspaceIdentity()): ChatDraft {
  if (!workspace || workspace !== getWorkspaceIdentity()) return EMPTY_CHAT_DRAFT;
  const key = workspaceStorageKey(PREFIX, workspace, scope);
  const cached = memory.get(key);
  if (cached) return cached;
  if (typeof window === "undefined") return EMPTY_CHAT_DRAFT;
  try {
    let value = JSON.parse(sessionStorage.getItem(key) || "null");
    if (!value) {
      const legacy = JSON.parse(sessionStorage.getItem(LEGACY_PREFIX + scope) || "null");
      // Untagged legacy data cannot be attributed to the current runtime.
      if (legacy?.workspace_id === workspace) value = legacy;
    }
    if (value?.workspace_id === workspace && typeof value.text === "string" && Array.isArray(value.attachments)) {
      const draft: ChatDraft = { text: value.text, settings: value.settings, revision: Number.isSafeInteger(value.revision) ? value.revision : 0,
        attachments: value.attachments.filter((item: ChatAttachment) => item && typeof item.id === "string") };
      memory.set(key, draft);
      return draft;
    }
  } catch { /* Memory fallback works in privacy mode and when storage is full. */ }
  return EMPTY_CHAT_DRAFT;
}

export function writeChatDraft(scope: string, draft: ChatDraft, workspace = getWorkspaceIdentity()): ChatDraft {
  if (!workspace || workspace !== getWorkspaceIdentity()) return draft;
  const key = workspaceStorageKey(PREFIX, workspace, scope);
  const next = { ...draft, revision: (readChatDraft(scope, workspace).revision || 0) + 1 };
  memory.set(key, next);
  if (typeof window !== "undefined") try {
    // Persist the revision even for an empty draft; an old ACK must not match an ABA edit.
    sessionStorage.setItem(key, JSON.stringify({ ...next, workspace_id: workspace, attachments: next.attachments.map(file =>
      ({ ...file, data_url: undefined, text: undefined, reason: file.artifact_uri ? file.reason : "reselect_required" })) }));
  } catch { /* Keep the current in-memory draft rather than silently reverting it. */ }
  return next;
}

export function captureChatDraft(scope: string): DraftReceipt | null {
  const workspace = getWorkspaceIdentity();
  return workspace ? { workspace, scope, generation: workspaceGeneration(), revision: readChatDraft(scope).revision || 0 } : null;
}
export function clearChatDraftIfUnchanged(receipt: DraftReceipt | null): boolean {
  if (!receipt || receipt.workspace !== getWorkspaceIdentity() || receipt.generation !== workspaceGeneration()) return false;
  const draft = readChatDraft(receipt.scope);
  if ((draft.revision || 0) !== receipt.revision) return false;
  writeChatDraft(receipt.scope, { ...draft, text: "", attachments: [] });
  return true;
}
export function clearChatDraft(scope: string): void { writeChatDraft(scope, EMPTY_CHAT_DRAFT); }
