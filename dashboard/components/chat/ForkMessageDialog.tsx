"use client";

import { useRef, useState } from "react";
import { useLocale } from "next-intl";
import * as Dialog from "@radix-ui/react-dialog";
import type { UserMessage } from "../../lib/chat";
import { uuid } from "../../lib/chat";
import { callApi } from "../../lib/clientApi";
import { readEditDraft, writeEditDraft } from "../../lib/editDrafts";
import { writeChatDraft } from "../../lib/chatDraft";
import { useUnsavedChanges } from "./useUnsavedChanges";

export function ForkMessageDialog({ sessionId, message, onClose, onCreated }: {
  sessionId: string; message: UserMessage; onClose: () => void; onCreated: (id: string) => void;
}) {
  const zh = useLocale().startsWith("zh");
  const scope = `fork:${sessionId}:${message.backend_message_id}`;
  const [saved] = useState(() => readEditDraft<{ text:string; requestId?:string; original?:string }>(scope));
  const [text,setText] = useState(saved?.text ?? message.text);
  const key = useRef(saved?.original === message.text && saved.requestId ? saved.requestId : uuid()), active = useRef(false);
  const [busy,setBusy] = useState(false), [error,setError] = useState("");
  useUnsavedChanges(text !== message.text);
  async function create() {
    if (active.current || !text.trim()) return;
    active.current = true; setBusy(true); setError("");
    writeEditDraft(scope,{ text,requestId:key.current,original:message.text });
    try {
      const result = await callApi<{ ok: boolean; session_id: string; error?: string }>("/agent/commands/fork", {
        method:"POST", signal:AbortSignal.timeout(15000), body:{ session_id:sessionId,message_id:message.backend_message_id,
          expected_content:message.text,client_request_id:key.current,language:zh?"zh":"en" },
      });
      if (!result.ok || !/^branch_[a-f0-9]{32}$/.test(result.session_id)) throw new Error(result.error || "fork_failed");
      writeChatDraft(result.session_id,{ text,attachments:message.attachments || [] });
      writeEditDraft(scope,null); onCreated(result.session_id);
    } catch { setError(zh ? "分支尚未确认，草稿已保留。重试会复用同一请求，不重复创建分支。" : "The branch is not confirmed. Your draft is retained; retry uses the same request ID."); }
    finally { active.current = false; setBusy(false); }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}><Dialog.Portal>
    <Dialog.Overlay className="ui-modal-overlay" /><Dialog.Content className="ui-dialog" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
      <Dialog.Title className="text-base font-semibold">{zh ? "编辑并创建分支" : "Edit and create a branch"}</Dialog.Title>
      <Dialog.Description className="mt-2 text-sm leading-6 text-[color:var(--text-muted)]">{zh ? "复制此消息之前的对话，并把修改后的消息放入新分支输入框。不会自动发送，不复制审批状态，也不撤销或重新执行原操作。" : "Copy the conversation before this message and place your edited message in the new branch's input. Nothing is sent automatically; approvals and executed actions are not copied or undone."}</Dialog.Description>
      <form onSubmit={event => { event.preventDefault(); void create(); }}>
        <textarea autoFocus aria-label={zh ? "新分支消息" : "New branch message"} className="input-dark mt-4 min-h-36 w-full" value={text} disabled={busy}
          onChange={event => { setText(event.target.value); writeEditDraft(scope,{ text:event.target.value,requestId:key.current,original:message.text }); }} />
        {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2"><button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>{zh ? "保留草稿并关闭" : "Keep draft and close"}</button>
          <button type="submit" data-testid="create-history-branch" className="btn btn-primary" disabled={busy || !text.trim()} aria-busy={busy}>{zh ? "创建分支" : "Create branch"}</button></div>
      </form>
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
