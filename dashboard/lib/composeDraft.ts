"use client";
import type { ChatAttachment, ChatRunSettings } from "./chat";
import { setWorkspaceComposeDraft, takeWorkspaceComposeDraft } from "./workspaceComposeDraft";
export type ComposeDraft = { text: string; attachments: ChatAttachment[]; settings?: ChatRunSettings; autoSend: boolean };
/** Legacy callers now share the runtime-identity-bound handoff. Unbound old data is never auto-sent. */
export function setComposeDraftPayload(draft: ComposeDraft): void { setWorkspaceComposeDraft(draft); }
export function takeComposeDraftPayload(): ComposeDraft | null { return takeWorkspaceComposeDraft(); }
export function setComposeDraft(text: string): void { setComposeDraftPayload({ text, attachments: [], autoSend: true }); }
export function takeComposeDraft(): string { return takeComposeDraftPayload()?.text ?? ""; }
