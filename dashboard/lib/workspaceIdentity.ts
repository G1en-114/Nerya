"use client";

import { useSyncExternalStore } from "react";

let identity: string | null = null;
let generation = 0;
const listeners = new Set<() => void>();

/** Runtime identity only. A saved browser preference is never proof of ownership. */
export function setWorkspaceIdentity(value: string | null | undefined) {
  const next = typeof value === "string" && value.trim() ? value : null;
  if (next === identity) return;
  identity = next;
  generation += 1;
  for (const listener of listeners) listener();
}
export const getWorkspaceIdentity = () => identity;
export const workspaceGeneration = () => generation;
export function subscribeWorkspaceIdentity(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useWorkspaceIdentity() {
  const observed = useSyncExternalStore(subscribeWorkspaceIdentity, workspaceGeneration, () => 0);
  return observed === 0 ? null : getWorkspaceIdentity();
}
export const workspaceStorageKey = (prefix: string, workspace: string, scope = "") => prefix + JSON.stringify([workspace, scope]);
