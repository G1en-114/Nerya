"use client";

import { useEffect, useRef, useState } from "react";
import type { LiveEvent } from "../../lib/chat";
import { ApiError } from "../../lib/clientApi";
import { COMMAND_PENDING_EVENT, commandControl, commandEvents, commandGet, commandSettled,
  commandSnapshot, pendingCommands, runningCommand, settlePending, submitCommand,
  type CommandSnapshot, type ConversationCommand, type PendingCommand } from "../../lib/conversationCommands";

/** A route owns an observer, never the runtime. Server commands survive navigation. */
export function useConversationCommands(sessionId: string | undefined,
  onProjection: (command: ConversationCommand, events: LiveEvent[]) => void) {
  const sink = useRef(onProjection); sink.current = onProjection;
  const [state, setState] = useState<{ session: string; data: CommandSnapshot | null; connection: "connecting" | "online" | "offline" | "incompatible" }>({ session: "", data: null, connection: "connecting" });
  const [pending, setPending] = useState<PendingCommand[]>([]);
  const refreshRef = useRef<() => void>(() => {});
  const generation = useRef(0);
  const currentSession = useRef(sessionId); currentSession.current = sessionId;
  useEffect(() => {
    const update = () => setPending(sessionId ? pendingCommands(sessionId) : []);
    update();
    window.addEventListener(COMMAND_PENDING_EVENT, update);
    window.addEventListener("storage", update);
    return () => { window.removeEventListener(COMMAND_PENDING_EVENT, update); window.removeEventListener("storage", update); };
  }, [sessionId]);

  useEffect(() => {
    const stamp = ++generation.current;
    if (!sessionId) { setState({ session: "", data: null, connection: "connecting" }); return; }
    const controller = new AbortController();
    const cursor = new Map<string, number>();
    const seen = new Map<string, number>();
    const drained = new Set<string>();
    let busy = false, queuedRefresh = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest: CommandSnapshot | null = null;
    const valid = () => !controller.signal.aborted && generation.current === stamp;
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
        setState({ session: sessionId!, data: snapshot, connection: "online" });
        for (const summary of snapshot.commands) {
          if (!valid()) return;
          const cid = summary.command_id;
          if (summary.kind === "guide" || ["queued","removed"].includes(summary.state)) continue;
          const changed = seen.get(cid) !== summary.revision;
          if (!changed && !runningCommand(summary) && drained.has(cid)) continue;
          let command = summary;
          if (changed && commandSettled(summary) && summary.has_result) {
            command = (await commandGet(sessionId!, cid, controller.signal)).command;
          }
          const events: LiveEvent[] = [];
          if (commandSettled(command) && command.result) drained.add(cid);
          if (!drained.has(cid)) {
            // Drain bounded batches without blocking the UI on a long history.
            // If more remain the next tick starts at the exact durable cursor.
            for (let page = 0; page < 4; page++) {
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
        if (valid()) setState(previous => ({ session: sessionId!, data: previous.session === sessionId ? previous.data : null, connection: error instanceof ApiError && [404,405].includes(error.status) ? "incompatible" : "offline" }));
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
  }, [sessionId]);

  const data = state.session === sessionId ? state.data : null;
  const commands = data?.commands || [];
  async function control(action: string, command?: ConversationCommand, extra: Record<string, unknown> = {}) {
    if (!sessionId || !data) return;
    try {
      await commandControl(sessionId, action, command?.revision ?? data.queue.revision, command?.command_id, extra);
    } finally { refreshRef.current(); }
  }
  async function recover(item: PendingCommand, resend = false) {
    try {
      const found = await commandGet(item.session_id, item.command_id);
      settlePending(item.command_id);
      if (currentSession.current === item.session_id) sink.current(found.command, []);
    } catch (error) {
      // Not-found is not proof the user intended another command. Explicit
      // resend preserves the original key and cannot multiply admission.
      if (!(error instanceof ApiError && error.status === 404) || !resend) throw error;
      const accepted = await submitCommand(item.session_id, item.command_type, item.request, item);
      if (currentSession.current === item.session_id) sink.current(accepted, []);
    } finally { refreshRef.current(); }
  }
  return { data, commands, active: commands.find(runningCommand),
    pending: pending.filter(item => !sessionId || item.session_id === sessionId),
    connection: state.session === sessionId ? state.connection : "connecting",
    refresh: () => refreshRef.current(), control, recover };
}
