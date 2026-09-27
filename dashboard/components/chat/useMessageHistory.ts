"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { ChatThread, UserMessage } from "../../lib/chat";
import { confirm, toast } from "../../lib/dialogs";
import { readEditDraft, writeEditDraft } from "../../lib/editDrafts";
import { useUnsavedChanges } from "./useUnsavedChanges";
import { commitMessageHistory, HistoryActionError, historyErrorKey, historyPending, writeHistory } from "../../lib/historyClient";

type Target = { sessionId: string; message: UserMessage; original: string };
type Edit = Target & { draft: string };

/** One pending history transaction per conversation. The server owns success. */
export function useMessageHistory({ thread, disabled, onCommit }: {
  thread: ChatThread | null; disabled: boolean;
  onCommit: (sessionId: string, messageId: string, patch: { text: string; edited_at?: number } | null) => void;
}) {
  const t = useTranslations("chatHistory");
  const draftKey = (sid:string,mid:string) => `message:${sid}:${mid}`;
  const [edit, setEdit] = useState<Edit | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Target | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const confirmRef = useRef(false);
  const [editError, setEditError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const focusReturn = useRef<HTMLElement | null>(null);
  const latest = useRef({ thread, disabled, onCommit });
  latest.current = { thread, disabled, onCommit };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setEdit(null); setDeleteTarget(null); setEditError(""); setDeleteError(""); }, [thread?.id]);

  useUnsavedChanges(Boolean(edit && edit.draft !== edit.original));
  const owns = (id: string) => mounted.current && latest.current.thread?.id === id;
  function restoreFocus() {
    requestAnimationFrame(() => {
      if (!mounted.current) return;
      if (focusReturn.current?.isConnected) focusReturn.current.focus();
      else document.querySelector<HTMLTextAreaElement>('[data-chat-composer] textarea')?.focus();
    });
  }
  function currentTarget(messageId: string): Target | null {
    const current = latest.current;
    if (!current.thread || current.disabled || pendingRef.current || historyPending(current.thread.id)) return null;
    const message = current.thread.messages.find(row => row.id === messageId);
    if (!message || message.role !== "user") return null;
    if (!message.backend_message_id) { toast({ tone: "warn", message: t("notSynced") }); return null; }
    return { sessionId: current.thread.id, message, original: message.text };
  }
  async function discardEdit(): Promise<boolean> {
    if (pendingRef.current || confirmRef.current) return false;
    if (!edit || edit.draft === edit.original) return true;
    confirmRef.current = true;
    try {
      return await confirm({ title: t("discardTitle"), message: t("discardHelp"),
        okLabel: t("discard"), cancelLabel: t("keepEditing"), tone: "danger" });
    } finally { confirmRef.current = false; }
  }
  async function start(messageId: string) {
    const target = currentTarget(messageId);
    if (!target || !(await discardEdit()) || !owns(target.sessionId)) return;
    focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const saved = readEditDraft<{ original:string; draft:string }>(draftKey(target.sessionId,target.message.backend_message_id!));
    setEdit({ ...target, draft: saved?.original === target.original ? saved.draft : target.original }); setEditError(""); setDeleteTarget(null);
  }
  async function cancel() {
    const sid = edit?.sessionId;
    if (!(await discardEdit()) || (sid && !owns(sid))) return;
    if (edit) writeEditDraft(draftKey(edit.sessionId,edit.message.backend_message_id!),null);
    setEdit(null); setEditError(""); restoreFocus();
  }
  function change(draft: string) {
    if (edit) writeEditDraft(draftKey(edit.sessionId,edit.message.backend_message_id!),{ original:edit.original,draft });
    setEdit(previous => previous ? { ...previous, draft } : null); setEditError("");
  }
  async function save() {
    const target = edit;
    if (!target || pendingRef.current || latest.current.disabled || !owns(target.sessionId)) return;
    if (!target.draft.trim() || target.draft === target.original) return;
    pendingRef.current = true; setPending(true); setEditError("");
    try {
      const result = await writeHistory(target.sessionId, "/agent/session/message/edit", {
        message_id: target.message.backend_message_id, content: target.draft, expected_content: target.original,
      });
      const patch = { text: typeof result.content === "string" ? result.content : target.draft,
        edited_at: result.edited_at ?? Date.now() / 1000 };
      writeEditDraft(draftKey(target.sessionId,target.message.backend_message_id!),null);
      commitMessageHistory(target.sessionId, target.message.id, target.message.backend_message_id!, patch);
      if (mounted.current) latest.current.onCommit(target.sessionId, target.message.id, patch);
      if (owns(target.sessionId)) { setEdit(null); restoreFocus(); }
    } catch (error) { if (owns(target.sessionId)) setEditError(t(historyErrorKey(error))); }
    finally { pendingRef.current = false; if (mounted.current) setPending(false); }
  }
  async function requestDelete(messageId: string) {
    const target = currentTarget(messageId);
    if (!target || !(await discardEdit()) || !owns(target.sessionId)) return;
    focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEdit(null); setDeleteError(""); setDeleteTarget(target);
  }
  function cancelDelete() { if (!pendingRef.current) { setDeleteTarget(null); setDeleteError(""); restoreFocus(); } }
  async function confirmDelete() {
    const target = deleteTarget;
    if (!target || pendingRef.current || !owns(target.sessionId)) return;
    if (latest.current.disabled) { setDeleteError(t("busy")); return; }
    pendingRef.current = true; setPending(true); setDeleteError("");
    try {
      if (!target.message.backend_message_id) throw new HistoryActionError("message_not_synced");
      await writeHistory(target.sessionId, "/agent/session/message/delete", {
        message_id: target.message.backend_message_id, expected_content: target.original,
      });
      commitMessageHistory(target.sessionId, target.message.id, target.message.backend_message_id!, null);
      if (mounted.current) latest.current.onCommit(target.sessionId, target.message.id, null);
      if (owns(target.sessionId)) { setDeleteTarget(null); restoreFocus(); }
    } catch (error) { if (owns(target.sessionId)) setDeleteError(t(historyErrorKey(error))); }
    finally { pendingRef.current = false; if (mounted.current) setPending(false); }
  }
  return { edit, pending, editError, deleteTarget, deleteError, start, cancel, change, save, requestDelete, cancelDelete, confirmDelete };
}
