"use client";

import type { ChatDraft } from "./chatDraft";
import { safeDraft } from "./durableDrafts";
import { getWorkspaceIdentity, subscribeWorkspaceIdentity, workspaceStorageKey } from "./workspaceIdentity";

export type WorkspaceComposeDraft = ChatDraft & { workspace_id: string; autoSend: boolean };
const PREFIX = "nerya.compose.draft.v3:";
let fallback: WorkspaceComposeDraft | null = null;
subscribeWorkspaceIdentity(() => { fallback = null; });
export function setWorkspaceComposeDraft(draft: ChatDraft & { autoSend: boolean }): boolean {
  const workspace = getWorkspaceIdentity();
  if (!workspace) return false;
  fallback = { ...safeDraft(draft), autoSend: draft.autoSend, workspace_id: workspace };
  try { sessionStorage.setItem(workspaceStorageKey(PREFIX, workspace), JSON.stringify(fallback)); } catch { /* Memory handoff still works. */ }
  return true;
}
export function takeWorkspaceComposeDraft(): WorkspaceComposeDraft | null {
  const workspace = getWorkspaceIdentity();
  if (!workspace) return null;
  let draft = fallback?.workspace_id === workspace ? fallback : null;
  fallback = null;
  try {
    const key = workspaceStorageKey(PREFIX, workspace);
    const saved = JSON.parse(sessionStorage.getItem(key) || "null");
    sessionStorage.removeItem(key);
    if (!draft && saved?.workspace_id === workspace && typeof saved.text === "string" && Array.isArray(saved.attachments)) draft = saved;
  } catch { /* Return the matching memory handoff. */ }
  return draft;
}
