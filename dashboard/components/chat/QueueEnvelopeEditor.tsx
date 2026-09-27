"use client";

import { useEffect, useRef, useState } from "react";
import { NextIntlClientProvider, useLocale, useMessages } from "next-intl";
import { clientApi } from "../../lib/clientApi";
import { buildChatModelOptions, type ChatModelOption } from "../../lib/chat";
import { commandErrorCode, queueEditDraft, queueEditRequest, type ConversationCommand, type QueueEditDraft } from "../../lib/conversationCommands";
import { commandErrorText } from "../../lib/commandCopy";
import { readEditDraft, writeEditDraft } from "../../lib/editDrafts";
import { getWorkspaceIdentity, workspaceGeneration } from "../../lib/workspaceIdentity";
import { ChatInput } from "./ChatInput";
import { ComposerModelMenu } from "./ComposerRunControls";
import { useUnsavedChanges } from "./useUnsavedChanges";

export function QueueEnvelopeEditor({ command, current, onSave, onClose }: {
  command: ConversationCommand; current?: ConversationCommand; onClose: () => void;
  onSave: (command: ConversationCommand, request: Record<string, unknown>) => Promise<unknown>;
}) {
  const locale = useLocale(), zh = locale.startsWith("zh"), messages = useMessages();
  const scope = "queue:" + command.command_id;
  const [base, setBase] = useState(command);
  const [draft, setDraft] = useState<QueueEditDraft>(() => {
    const saved = readEditDraft<Partial<QueueEditDraft>>(scope);
    return saved && typeof saved.text === "string" ? { ...queueEditDraft(command), ...saved } : queueEditDraft(command);
  });
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [models, setModels] = useState<ChatModelOption[]>([]);
  const mounted = useRef(true);
  const conflict = !current || current.state !== "queued" || current.queue_editable === false || current.revision !== draft.revision;
  useUnsavedChanges(JSON.stringify(draft) !== JSON.stringify(queueEditDraft(base)));
  useEffect(() => {
    mounted.current = true;
    let active = true;
    void Promise.allSettled([clientApi.llmTiers(), clientApi.llmModels(), clientApi.llmConfig()]).then(([tiers, models, config]) => {
      if (active) setModels(buildChatModelOptions({ tiers: tiers.status === "fulfilled" ? tiers.value : null,
        models: models.status === "fulfilled" ? models.value : null, config: config.status === "fulfilled" ? config.value : null }));
    });
    return () => { active = false; mounted.current = false; };
  }, []);
  function update(next: QueueEditDraft) {
    const safe = { ...next, attachments: next.attachments.map(file => {
      const { data_url, text, ...saved } = file; return saved;
    }) };
    setDraft(safe); writeEditDraft(scope, safe);
  }
  async function save() {
    if (busy || conflict || !getWorkspaceIdentity()) return;
    const workspace = getWorkspaceIdentity(), generation = workspaceGeneration();
    setBusy(true); setError("");
    writeEditDraft(scope, draft);
    try {
      await onSave({ ...base, revision: draft.revision }, queueEditRequest(base, draft));
      if (!mounted.current || workspace !== getWorkspaceIdentity() || generation !== workspaceGeneration()) return;
      writeEditDraft(scope, null); onClose();
    } catch (reason) {
      if (mounted.current && workspace === getWorkspaceIdentity() && generation === workspaceGeneration()) setError(commandErrorText(commandErrorCode(reason), zh));
    } finally { if (mounted.current) setBusy(false); }
  }
  const saveLabel = zh ? "保存队列更改" : "Save queue changes";
  return <div className="space-y-2 py-3" data-testid="queue-envelope-editor">
    <p className="text-sm font-medium">{zh ? "编辑排队消息" : "Edit queued message"}</p>
    {conflict && <div role="alert" className="text-sm text-[color:var(--warn)]">
      <p>{zh ? "消息版本已变化或已开始执行。完整编辑草稿已保留。" : "This message changed or started running. Your complete draft is retained."}</p>
      {current?.state === "queued" && current.queue_editable !== false && <button type="button" disabled={busy} className="btn btn-ghost" onClick={() => {
        setBase(current); update({ ...draft, revision: current.revision }); setError("");
      }}>{zh ? "保留草稿，基于当前版本继续编辑" : "Keep draft and edit against current version"}</button>}
    </div>}
    {command.kind === "resume" ? <>
      <label className="block text-sm">{zh ? "继续本轮的补充说明" : "Continuation feedback"}
        <textarea className="w-full" value={draft.text} disabled={busy} onChange={event => update({ ...draft, text: event.target.value })} />
      </label>
      <ComposerModelMenu settings={draft.settings} onSettingsChange={settings => update({ ...draft, settings })} modelOptions={models} disabled={busy} />
      <button type="button" disabled={busy || conflict || !draft.text.trim()} onClick={() => void save()}>{saveLabel}</button>
    </> : <NextIntlClientProvider locale={locale} messages={{ ...messages, chat: { ...(messages.chat as Record<string, string>), send: saveLabel } }}>
      <ChatInput value={draft.text} onChange={text => update({ ...draft, text })} onSend={() => void save()}
        sending={false} submitting={busy} draftLocked={busy} locked={conflict}
        lockMessage={zh ? "当前版本不可保存；可以继续编辑草稿。" : "This version cannot be saved; you can keep editing the draft."}
        placeholder={zh ? "编辑此次排队输入…" : "Edit this queued input…"}
        settings={draft.settings} onSettingsChange={settings => update({ ...draft, settings })} modelOptions={models}
        attachments={draft.attachments} onAttachmentsChange={attachments => update({ ...draft, attachments })} sessionId={command.session_id} />
    </NextIntlClientProvider>}
    <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>{zh ? "关闭（保留草稿）" : "Close (keep draft)"}</button>
    {error && <p role="alert" className="text-sm text-[color:var(--danger)]">{error}</p>}
  </div>;
}
