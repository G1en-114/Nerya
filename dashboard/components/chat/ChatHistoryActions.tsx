"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import * as Dialog from "@radix-ui/react-dialog";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { EditIcon, MoreIcon, TrashIcon } from "../icons";
import { deleteConversation, historyErrorKey, renameConversation } from "../../lib/historyClient";

export function HistoryDeleteDialog({ open, title, description, preview, busy, error, onConfirm, onCancel }: {
  open: boolean; title: string; description: string; preview: string; busy: boolean; error: string;
  onConfirm: () => void; onCancel: () => void;
}) {
  const t = useTranslations("chatHistory");
  const cancelRef = useRef<HTMLButtonElement>(null);
  return <Dialog.Root open={open} onOpenChange={next => { if (!next && !busy) onCancel(); }}>
    <Dialog.Portal><Dialog.Overlay className="ui-modal-overlay" /><Dialog.Content className="ui-dialog"
      onOpenAutoFocus={event => { event.preventDefault(); cancelRef.current?.focus(); }}
      onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
      <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
      <Dialog.Description className="mt-3 text-sm leading-6 text-[color:var(--text-muted)]">{description}</Dialog.Description>
      <p className="mt-3 max-h-28 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-[color:var(--card)] p-3 text-sm">{preview.slice(0, 400)}</p>
      {error ? <p role="alert" className="mt-3 text-sm text-danger">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <button ref={cancelRef} type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>{t("cancel")}</button>
        <button type="button" className="btn ui-danger-button" disabled={busy} aria-busy={busy} onClick={onConfirm}><TrashIcon size={15} />{t(busy ? "deleting" : "delete")}</button>
      </div>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}

/** Same actions for ordinary and strategy-bound chats, with honest async state. */
export function ConversationActions({ id, title, onDeleted, onRenamed }: {
  id: string; title: string; onDeleted?: () => void; onRenamed?: (title: string) => void;
}) {
  const t = useTranslations("chatHistory");
  const [action, setAction] = useState<"rename" | "delete" | null>(null);
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  function close() {
    if (busyRef.current) return;
    setAction(null); setError("");
    requestAnimationFrame(() => triggerRef.current?.focus());
  }
  async function commit() {
    if (busyRef.current || !action) return;
    const requested = action;
    const clean = draft.trim().replace(/\s+/g, " ");
    if (requested === "rename" && (!clean || clean === title || clean.length > 80)) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      if (requested === "delete") { await deleteConversation(id); onDeleted?.(); }
      else { const saved = await renameConversation(id, clean); onRenamed?.(saved); }
      setAction(null);
      requestAnimationFrame(() => { if (triggerRef.current?.isConnected) triggerRef.current.focus(); });
    } catch (value) { setError(t(historyErrorKey(value))); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <>
    <Menu.Root><Menu.Trigger asChild><button ref={triggerRef} type="button" aria-label={t("actions", { title })}
      className="ui-icon-button ml-1 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
      data-testid={`conversation-actions-${id}`}><MoreIcon size={16} /></button></Menu.Trigger>
      <Menu.Portal><Menu.Content className="ui-select-menu min-w-40" align="start" sideOffset={6} collisionPadding={8}
        onCloseAutoFocus={event => { if (action) event.preventDefault(); }}>
        <Menu.Item className="ui-select-option" onSelect={() => { setDraft(title); setError(""); setAction("rename"); }}><EditIcon size={15} />{t("rename")}</Menu.Item>
        <Menu.Item className="ui-select-option text-danger" onSelect={() => { setError(""); setAction("delete"); }}><TrashIcon size={15} />{t("deleteConversation")}</Menu.Item>
      </Menu.Content></Menu.Portal>
    </Menu.Root>
    <HistoryDeleteDialog open={action === "delete"} title={t("deleteConversation")} description={t("deleteConversationHelp")}
      preview={title} busy={busy} error={error} onConfirm={() => { void commit(); }} onCancel={close} />
    <Dialog.Root open={action === "rename"} onOpenChange={next => { if (!next) close(); }}>
      <Dialog.Portal><Dialog.Overlay className="ui-modal-overlay" /><Dialog.Content className="ui-dialog"
        onOpenAutoFocus={event => { event.preventDefault(); inputRef.current?.focus(); inputRef.current?.select(); }}
        onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
        <Dialog.Title className="text-base font-semibold">{t("rename")}</Dialog.Title>
        <Dialog.Description className="mt-2 text-sm text-[color:var(--text-muted)]">{t("renameHelp")}</Dialog.Description>
        <form onSubmit={event => { event.preventDefault(); void commit(); }}>
          <input ref={inputRef} aria-label={t("title")} value={draft} maxLength={80} disabled={busy}
            onChange={event => { setDraft(event.target.value); setError(""); }} className="input-dark mt-4 w-full"
            onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229) { if (event.key === "Enter") event.preventDefault(); } }} />
          {error ? <p role="alert" className="mt-3 text-sm text-danger">{error}</p> : null}
          <div className="mt-5 flex justify-end gap-2"><button type="button" className="btn btn-ghost" disabled={busy} onClick={close}>{t("cancel")}</button>
            <button type="submit" className="btn btn-primary" disabled={busy || !draft.trim() || draft.trim() === title} aria-busy={busy}>{t(busy ? "saving" : "save")}</button></div>
        </form>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </>;
}
