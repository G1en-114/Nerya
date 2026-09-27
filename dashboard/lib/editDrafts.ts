"use client";

import { getWorkspaceIdentity, subscribeWorkspaceIdentity, workspaceStorageKey } from "./workspaceIdentity";

/** Per-resource drafts survive route replacement and browser Back. Never execute. */
const PREFIX = "nerya.edit-draft.v2:";
const memory = new Map<string, unknown>();
subscribeWorkspaceIdentity(() => memory.clear());
export function readEditDraft<T>(scope: string): T | null {
  const workspace = getWorkspaceIdentity();
  if (!workspace) return null;
  const key = workspaceStorageKey(PREFIX, workspace, scope);
  if (memory.has(key)) return memory.get(key) as T;
  if (typeof window === "undefined") return null;
  try { const value = JSON.parse(sessionStorage.getItem(key) || "null"); if (value !== null) memory.set(key, value); return value as T | null; }
  catch { return null; }
}
export function writeEditDraft(scope: string, value: unknown): void {
  const workspace = getWorkspaceIdentity();
  if (!workspace) return;
  const key = workspaceStorageKey(PREFIX, workspace, scope);
  if (value === null) memory.delete(key); else memory.set(key, value);
  if (typeof window === "undefined") return;
  try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(value)); }
  catch { /* Memory fallback retains the editable state in restricted storage. */ }
}
