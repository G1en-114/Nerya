"use client";

import { ApiError, callApi } from "./clientApi";
import type { AssistantMessage, ChatAttachment, ChatThread, LiveEvent, TurnPayload } from "./chat";
import { uuid } from "./chat";

export type CommandState = "queued" | "running" | "stopping" | "delivering" | "delivered" | "injected" |
  "succeeded" | "failed" | "blocked" | "awaiting_approval" | "awaiting_input" | "interrupted" | "unconfirmed" | "not_consumed" | "removed";
export type CommandKind = "send" | "resume" | "guide";
export type ConversationCommand = {
  command_id: string; session_id: string; kind: CommandKind; state: CommandState;
  revision: number; turn_id: string; position: number; created_at: number; updated_at: number;
  input: string; attachments: ChatAttachment[]; context: Record<string, unknown>;
  show_user?: boolean; has_result?: boolean; result?: TurnPayload | null;
  error?: { code?: string; status_code?: number; request_id?: string; retrying?: boolean } | null;
};
export type CommandSnapshot = {
  ok: boolean; commands: ConversationCommand[];
  queue: { paused: boolean | number; pause_reason: string; revision: number };
  checkpoint?: { turn_id: string; resumable: boolean; resume_count?: number } | null;
  branch_of?: { session_id: string; message_id: string } | null;
};
export type PendingCommand = { command_id: string; session_id: string; command_type: CommandKind;
  request: Record<string, unknown>; created_at: number };
export const COMMAND_PENDING_EVENT = "nerya:command-pending";
const KEY = "nerya.chat.pending-commands.v1";
const PREFIX = "nerya.chat.pending-command.v2:";
const memory = new Map<string, PendingCommand>();
const volatile = new Set<string>();
export const runningCommand = (command: ConversationCommand) => command.kind !== "guide" && ["running", "stopping"].includes(command.state);
export const commandSettled = (command: ConversationCommand) => !["queued", "running", "stopping", "delivering", "delivered"].includes(command.state);

export function pendingCommands(sid?: string): PendingCommand[] {
  if (typeof window !== "undefined") {
    try {
      const legacy: unknown = JSON.parse(localStorage.getItem(KEY) || "[]");
      if (Array.isArray(legacy)) {
        for (const item of legacy.slice(-32)) if (item && typeof item.command_id === "string") localStorage.setItem(PREFIX+item.command_id,JSON.stringify(item));
        localStorage.removeItem(KEY);
      }
      const found = new Map<string,PendingCommand>();
      for (let index=0; index<localStorage.length; index++) {
        const key=localStorage.key(index); if (!key?.startsWith(PREFIX)) continue;
        const item=JSON.parse(localStorage.getItem(key) || "null");
        if (item && typeof item.command_id === "string" && typeof item.session_id === "string" &&
            ["send","resume","guide"].includes(item.command_type) && item.request && typeof item.request === "object") found.set(item.command_id,item);
      }
      // Per-command keys prevent two tabs from overwriting each other's pending
      // requests. A removal in another tab clears the corresponding clue here.
      for (const id of memory.keys()) if (!found.has(id) && !volatile.has(id)) memory.delete(id);
      for (const [id,item] of found) memory.set(id,item);
    } catch { /* A blocked preference store does not turn an ACK into a failure. */ }
  }
  return [...memory.values()].filter(item => !sid || item.session_id === sid);
}
function persistPending(id: string, value: PendingCommand | null) {
  if (typeof window === "undefined") return;
  try {
    if (value) localStorage.setItem(PREFIX+id,JSON.stringify(value)); else localStorage.removeItem(PREFIX+id);
    volatile.delete(id);
  } catch { if (value) volatile.add(id); }
  window.dispatchEvent(new Event(COMMAND_PENDING_EVENT));
}
export function settlePending(id: string) { memory.delete(id); volatile.delete(id); persistPending(id,null); }

export class CommandClientError extends Error {
  constructor(public readonly code: string, public readonly uncertain = false) { super(code); this.name = "CommandClientError"; }
}
export function commandErrorCode(error: unknown): string {
  if (error instanceof CommandClientError) return error.code;
  if (error instanceof ApiError && error.payload && typeof error.payload === "object") {
    return String((error.payload as { error?: string }).error || "command_failed");
  }
  return "connection_lost";
}
async function request<T extends { ok?: boolean }>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 12000);
  try {
    const result = await callApi<T & { error?: string }>(path, { method: body === undefined ? "GET" : "POST", body, signal: controller.signal });
    if (result.ok === false) throw new CommandClientError(result.error || "command_failed");
    return result;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
function query(sid: string, id?: string) {
  const q = new URLSearchParams({ session_id: sid });
  if (id) q.set("command_id", id);
  return q.toString();
}
export const commandSnapshot = (sid: string, signal?: AbortSignal) => request<CommandSnapshot>(`/agent/commands?${query(sid)}`, undefined, signal);
export const commandGet = (sid: string, id: string, signal?: AbortSignal) => request<{ ok: boolean; command: ConversationCommand }>(`/agent/commands?${query(sid,id)}`, undefined, signal);
export const commandEvents = (sid: string, id: string, after: number, signal?: AbortSignal) => request<{
  ok: boolean; events: LiveEvent[]; cursor: number; has_more: boolean;
}>(`/agent/commands/events?${query(sid,id)}&after_seq=${after}&limit=500`, undefined, signal);
export const commandControl = (sid: string, action: string, revision: number, commandId?: string, extra: Record<string, unknown> = {}) =>
  request<CommandSnapshot & { command?: ConversationCommand }>("/agent/commands/control", {
    session_id: sid, action, expected_revision: revision, command_id: commandId, ...extra,
  });

/** One deliberate send, one stable key. Network failures never trigger a new turn. */
export async function submitCommand(sid: string, kind: CommandKind, body: Record<string, unknown>, existing?: PendingCommand) {
  pendingCommands();
  if (!existing && memory.size >= 32) throw new CommandClientError("pending_limit");
  const pending = existing || { command_id: uuid(), session_id: sid, command_type: kind, request: body, created_at: Date.now() };
  memory.set(pending.command_id, pending);
  persistPending(pending.command_id,pending);
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  try {
    const result = await request<{ ok: boolean; command: ConversationCommand; duplicate: boolean }>("/agent/commands", pending);
    if (!result.command?.command_id || result.command.command_id !== pending.command_id) throw new CommandClientError("receipt_invalid",true);
    settlePending(pending.command_id);
    recordCommandTiming({ command_id: pending.command_id, phase: "ack", ms: (typeof performance !== "undefined" ? performance.now() : Date.now())-started });
    return result.command;
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      settlePending(pending.command_id);
      throw new CommandClientError(commandErrorCode(error));
    }
    if (error instanceof CommandClientError && !error.uncertain) {
      settlePending(pending.command_id); throw error;
    }
    throw new CommandClientError("delivery_unconfirmed", true);
  }
}

// Local, bounded, content-free diagnostics. No prompt or provider key leaves the device.
const timing: { command_id: string; phase: string; ms: number }[] = [];
export function recordCommandTiming(item: { command_id: string; phase: string; ms: number }) {
  timing.push({ ...item, ms: Math.max(0, Math.round(item.ms)) });
  if (timing.length > 100) timing.splice(0, timing.length-100);
}
export const commandTimings = () => [...timing];

/** Projection only: source command identity prevents ACK/reload/stream duplicates. */
export function projectCommand(thread: ChatThread, command: ConversationCommand, fresh: LiveEvent[] = []): ChatThread {
  if (command.session_id !== thread.id || command.kind === "guide" || ["queued","removed"].includes(command.state)) return thread;
  const messages = [...thread.messages];
  const tid = command.turn_id;
  if (command.kind === "send" && command.show_user !== false && !messages.some(m => m.role === "user" && (m.command_id === command.command_id || m.backend_message_id === `${tid}:user`))) {
    messages.push({ id: command.command_id+":user", role: "user", ts: command.created_at*1000,
      text: command.input, attachments: command.attachments, command_id: command.command_id,
      backend_message_id: `${tid}:user`, delivery_state: "received" });
  }
  const index = messages.findIndex(m => m.role === "assistant" && (m.command_id === command.command_id || m.backend_message_id === `${tid}:assistant`));
  const old = index >= 0 ? messages[index] as AssistantMessage : undefined;
  const oldCreated = old?.command_created_at ?? Number(old?.turn?.context_snapshot?.captured_at || 0);
  // A resumed turn keeps turn_id. Its older command snapshot must never put
  // the turn back into the previous failure/stop state after reconnecting.
  if (old?.command_id && old.command_id !== command.command_id && oldCreated > command.created_at) return thread;
  const live = runningCommand(command);
  const events = new Map((old?.live_events || []).map(event => [event.event_id || `${event.kind}:${event.seq}`,event]));
  for (const event of fresh) events.set(event.event_id || `${event.kind}:${event.seq}`,event);
  const turn = command.result || old?.turn || { turn_id: tid };
  const error = ["failed","unconfirmed"].includes(command.state)
    ? JSON.stringify(command.error || { code: command.state === "unconfirmed" ? "execution_unconfirmed" : "turn_failed", retrying: false }) : undefined;
  const next: AssistantMessage = { ...old, id: old?.id || command.command_id+":assistant", role: "assistant",
    ts: old?.ts || command.created_at*1000, backend_message_id: `${tid}:assistant`,
    command_id: command.command_id, command_created_at:command.created_at, command_revision: command.revision, execution_status: command.state,
    loading: live, error, turn: { ...turn, command_id: command.command_id, context_snapshot: command.context },
    started_ms: old?.started_ms || (live ? Date.now() : undefined),
    elapsed_ms: command.result?.execution_elapsed_ms ?? old?.elapsed_ms,
    live_events: [...events.values()], live_cursor: fresh.at(-1)?.seq ?? old?.live_cursor };
  if (index >= 0) messages[index] = next; else messages.push(next);
  return { ...thread, messages, imported: false, message_count: messages.length,
    updated_ts: Math.max(thread.updated_ts || 0, command.updated_at*1000) };
}
