import type { ChatAttachment, ChatRunSettings } from "./chat";

export type ChatDraft = { text: string; attachments: ChatAttachment[]; settings?: ChatRunSettings };
export const EMPTY_CHAT_DRAFT: ChatDraft = { text: "", attachments: [] };
const PREFIX = "nerya.chat.draft.v1:";
const memory = new Map<string, ChatDraft>();

export function readChatDraft(scope: string): ChatDraft {
  const cached = memory.get(scope);
  if (cached) return cached;
  if (typeof window === "undefined") return EMPTY_CHAT_DRAFT;
  try {
    const value = JSON.parse(sessionStorage.getItem(PREFIX + scope) || "null");
    if (value && typeof value.text === "string" && Array.isArray(value.attachments)) {
      const draft = { text: value.text, settings:value.settings, attachments: value.attachments.filter((item: ChatAttachment) => item && typeof item.id === "string") };
      memory.set(scope, draft);
      return draft;
    }
  } catch { /* Memory fallback works in privacy mode and when storage is full. */ }
  return EMPTY_CHAT_DRAFT;
}

export function writeChatDraft(scope: string, draft: ChatDraft): void {
  memory.set(scope, draft);
  if (typeof window === "undefined") return;
  try {
    if (!draft.text && !draft.attachments.length) sessionStorage.removeItem(PREFIX + scope);
    else sessionStorage.setItem(PREFIX + scope, JSON.stringify({ ...draft, attachments: draft.attachments.map(file =>
      ({ ...file, data_url: undefined, text: undefined,reason:file.artifact_uri?file.reason:"reselect_required" })) }));
  } catch { /* Keep the current in-memory draft rather than silently reverting it. */ }
}

export function clearChatDraft(scope: string): void { writeChatDraft(scope, EMPTY_CHAT_DRAFT); }
