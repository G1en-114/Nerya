"use client";

import { useEffect, useRef, useState } from "react";
import type { LiveEvent } from "../../lib/chat";
import { ApiError } from "../../lib/clientApi";
import { getWorkspaceIdentity, useWorkspaceIdentity, workspaceGeneration } from "../../lib/workspaceIdentity";
import { COMMAND_PENDING_EVENT, commandControl, commandEvents, commandGet, commandSettled,
  commandSnapshot, CommandClientError, pendingCommands, runningCommand, settlePending, submitCommand,
  type CommandSnapshot, type ConversationCommand, type PendingCommand } from "../../lib/conversationCommands";

export type Reconciliation = { status: "matched" | "insufficient_evidence" | "lookup_failed";
  command_id: string; session_id: string; turn_id: string | null; source?: string | null; evidence_path: string };

export function settleSnapshotPending(sessionId: string, commands: ConversationCommand[]) {
  const received = new Set(commands.filter(command => command.session_id === sessionId).map(command => command.command_id));
  for (const item of pendingCommands(sessionId)) {
    if (item.session_id === sessionId && received.has(item.command_id)) settlePending(item.command_id, item.workspace_id);
  }
}

/** A route owns an observer, never the runtime. Server commands survive navigation. */
export function useConversationCommands(sessionId: string | undefined,
  onProjection: (command: ConversationCommand, events: LiveEvent[]) => void) {
  const workspace = useWorkspaceIdentity(), identityGeneration = workspaceGeneration();
  const ownsWorkspace = () => Boolean(workspace && workspace === getWorkspaceIdentity() && identityGeneration === workspaceGeneration());
  const sink = useRef(onProjection); sink.current = onProjection;
  const [state, setState] = useState<{ session: string; workspace: string | null; identityGeneration: number; data: CommandSnapshot | null; connection: "connecting" | "online" | "offline" | "incompatible" }>({ session: "", workspace: null, identityGeneration: -1, data: null, connection: "connecting" });
  const [pending, setPending] = useState<PendingCommand[]>([]);
  const refreshRef = useRef<() => void>(() => {});
  const generation = useRef(0);
  const currentSession = useRef(sessionId); currentSession.current = sessionId;
  useEffect(() => {
    const update = () => setPending(sessionId && ownsWorkspace() ? pendingCommands(sessionId) : []);
    update();
    window.addEventListener(COMMAND_PENDING_EVENT, update);
    window.addEventListener("storage", update);
    return () => { window.removeEventListener(COMMAND_PENDING_EVENT, update); window.removeEventListener("storage", update); };
  }, [sessionId, workspace, identityGeneration]);

  useEffect(() => {
    const stamp = ++generation.current;
    if (!sessionId || !ownsWorkspace()) { setState({ session: "", workspace, identityGeneration, data: null, connection: "connecting" }); return; }
    const controller = new AbortController();
    const cursor = new Map<string, number>();
    const seen = new Map<string, number>();
    const drained = new Set<string>();
    let busy = false, queuedRefresh = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest: CommandSnapshot | null = null;
    const valid = () => !controller.signal.aborted && generation.current === stamp && ownsWorkspace() && currentSession.current === sessionId;
    async function tick() {
      if (!valid()) return;
      if (busy) { queuedRefresh = true; return; }
      if (timer) clearTimeout(timer);
      busy = true;
      try {
        const snapshot = await commandSnapshot(sessionId!, controller.signal);
        if (!valid()) return;
        if (!Array.isArray(snapshot.commands) || !snapshot.queue) throw new Error("Invalid command snapshot");
        latest = snapshot;
        settleSnapshotPending(sessionId!, snapshot.commands);
        setState({ session: sessionId!, workspace, identityGeneration, data: snapshot, connection: "online" });
        for (const summary of snapshot.commands) {
          if (!valid()) return;
          if (summary.session_id !== sessionId) continue;
          const cid = summary.command_id;
          if (summary.kind === "guide" || ["queued","removed"].includes(summary.state)) continue;
          const changed = seen.get(cid) !== summary.revision;
          if (!changed && !runningCommand(summary) && drained.has(cid)) continue;
          let command = summary;
          if (changed && commandSettled(summary) && summary.has_result) {
            command = (await commandGet(sessionId!, cid, controller.signal)).command;
            if (!valid()) return;
            if (command.session_id !== sessionId || command.command_id !== cid) throw new CommandClientError("receipt_invalid", true);
          }
          const events: LiveEvent[] = [];
          if (commandSettled(command) && command.result) drained.add(cid);
          if (!drained.has(cid)) {
            // Drain bounded batches without blocking the UI on a long history.
            // If more remain the next tick starts at the exact durable cursor.
            for (let page = 0; page < 4; page++) {
              if (!valid()) return;
              const response = await commandEvents(sessionId!, cid, cursor.get(cid) || 0, controller.signal);
              if (!valid()) return;
              events.push(...response.events);
              cursor.set(cid, response.cursor);
              if (!response.has_more) {
                if (commandSettled(command)) drained.add(cid);
                break;
              }
            }
          }
          if (!valid()) return;
          if (changed || events.length) sink.current(command, events);
          seen.set(cid, command.revision);
        }
      } catch(error) {
        if (valid()) setState(previous => ({ session: sessionId!, workspace, identityGeneration, data: previous.session === sessionId && previous.workspace === workspace && previous.identityGeneration === identityGeneration ? previous.data : null, connection: error instanceof ApiError && [404,405].includes(error.status) ? "incompatible" : "offline" }));
      } finally {
        busy = false;
        if (valid()) {
          const active = latest?.commands.some(runningCommand);
          const delay = queuedRefresh ? 0 : document.hidden ? 5000 : active ? 500 : 2000;
          queuedRefresh = false;
          timer = setTimeout(tick, delay);
        }
      }
    }
    refreshRef.current = () => { if (!document.hidden) void tick(); };
    const visible = () => { if (!document.hidden) void tick(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", visible);
    void tick();
    return () => {
      controller.abort(); if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible); window.removeEventListener("online", visible);
      refreshRef.current = () => {};
    };
  }, [sessionId, workspace, identityGeneration]);

  const ownsState = ownsWorkspace() && state.session === sessionId && state.workspace === workspace && state.identityGeneration === identityGeneration;
  const data = ownsState ? state.data : null;
  const commands = data?.commands || [];
  async function control(action: string, command?: ConversationCommand, extra: Record<string, unknown> = {}) {
    if (!sessionId || !data || !ownsWorkspace() || (command && command.session_id !== sessionId)) throw new CommandClientError("connection_lost");
    try {
      const response=await commandControl(sessionId, action, command?.revision ?? data.queue.revision, command?.command_id, extra);
      if (!ownsWorkspace() || currentSession.current !== sessionId) throw new CommandClientError("workspace_changed", true);
      if(Array.isArray(response.commands))setState({session:sessionId,workspace,identityGeneration,data:response,connection:"online"});
      return response as typeof response & { reconciliation?: Reconciliation };
    } finally { if (ownsWorkspace() && currentSession.current === sessionId) refreshRef.current(); }
  }
  async function recover(item: PendingCommand, resend = false) {
    const valid = () => ownsWorkspace() && item.workspace_id === workspace && item.session_id === sessionId && currentSession.current === sessionId;
    if (!valid()) throw new CommandClientError("workspace_mismatch");
    try {
      const found = await commandGet(item.session_id, item.command_id);
      if (!valid()) throw new CommandClientError("workspace_changed", true);
      if (found.command.session_id !== item.session_id || found.command.command_id !== item.command_id) throw new CommandClientError("receipt_invalid", true);
      settlePending(item.command_id, item.workspace_id);
      if (currentSession.current === item.session_id) sink.current(found.command, []);
    } catch (error) {
      // Not-found is not proof the user intended another command. Explicit
      // resend preserves the original key and cannot multiply admission.
      if (!valid() || !(error instanceof ApiError && error.status === 404) || !resend) throw error;
      const accepted = await submitCommand(item.session_id, item.command_type, item.request, item);
      if (!valid()) throw new CommandClientError("workspace_changed", true);
      if (currentSession.current === item.session_id) sink.current(accepted, []);
    } finally { if (ownsWorkspace() && currentSession.current === sessionId) refreshRef.current(); }
  }
  return { data, commands, active: commands.find(runningCommand),
    pending: ownsWorkspace() ? pending.filter(item => item.workspace_id === workspace && item.session_id === sessionId) : [],
    connection: ownsState ? state.connection : "connecting",
    refresh: () => { if (ownsWorkspace()) refreshRef.current(); }, control, recover };
}
