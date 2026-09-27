"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { clientApi } from "../../lib/clientApi";
import {
  buildChatModelOptions, loadRunSettings, saveRunSettings, DEFAULT_CHAT_RUN_SETTINGS,
  type ChatModelOption, type ChatRunSettings,
} from "../../lib/chat";
import { setWorkspaceComposeDraft, takeWorkspaceComposeDraft } from "../../lib/workspaceComposeDraft";
import { AgentStart } from "../chat/AgentStart";
import { ChatInput } from "../chat/ChatInput";
import { useWorkbench } from "../chat/useWorkbench";
import { RuntimeNotice } from "../chat/RuntimeNotice";
import { useChatDraft } from "../chat/useChatDraft";

export function CommandHome() {
  const router = useRouter();
  const t = useTranslations("commandHome");
  const zh = useLocale().startsWith("zh");
  const draft=useChatDraft("home");
  const { text, setText, attachments, setAttachments } = draft;
  const workbench=useWorkbench();
  const [settings, setSettings] = useState<ChatRunSettings>(DEFAULT_CHAT_RUN_SETTINGS);
  const [modelOptions, setModelOptions] = useState<ChatModelOption[]>([]);
  const [navigating, setNavigating] = useState(false);
  const submitted = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Do not summon the on-screen keyboard as soon as a phone opens home.
    const focus = window.setTimeout(() => {
      if (window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus();
    }, 30);
    let cancelled = false;
    void Promise.allSettled([clientApi.llmTiers(), clientApi.llmModels(), clientApi.llmConfig()])
      .then(([tiers, models, config]) => {
        if (!cancelled) setModelOptions(buildChatModelOptions({
          tiers: tiers.status === "fulfilled" ? tiers.value : null,
          models: models.status === "fulfilled" ? models.value : null,
          config: config.status === "fulfilled" ? config.value : null,
        }));
      });
    return () => { cancelled = true; window.clearTimeout(focus); };
  }, []);
  useEffect(() => {
    if (!draft.ready) return;
    const handoff = takeWorkspaceComposeDraft();
    if (handoff) draft.replace(handoff);
  }, [draft.ready, draft.workspaceId]);
  useEffect(() => {
    submitted.current = false; setNavigating(false);
    setSettings(draft.workspaceId ? loadRunSettings() : DEFAULT_CHAT_RUN_SETTINGS);
  }, [draft.workspaceId]);

  useEffect(()=>{if(draft.settings)setSettings(draft.settings);},[draft.settings]);
  function submit() {
    if (!draft.ready || workbench.connection!=="online" || submitted.current || (!text.trim() && !attachments.length)) return;
    const receipt = draft.capture();
    if (!setWorkspaceComposeDraft({ text: text.trim(), attachments, settings, autoSend: true })) return;
    submitted.current = true;
    setNavigating(true);
    saveRunSettings(settings);
    draft.clearIfUnchanged(receipt);
    router.push("/chat");
  }

  return <div className="command-home-root flex min-h-0 flex-1 flex-col">
    <RuntimeNotice workbench={workbench}/>
    {draft.recovery.length>0&&<div className="mx-auto flex w-full max-w-[860px] flex-wrap gap-2 px-4 py-2 text-xs">{draft.recovery.slice(0,3).map(row=><button type="button" className="min-h-11 underline" key={row.key} onClick={()=>draft.restore(row)}>{row.draft.text.slice(0,60)||row.draft.attachments[0]?.name} ↩</button>)}<button type="button" className="min-h-11" aria-label="Dismiss recovered drafts" onClick={draft.dismissRecovery}>×</button></div>}
    <AgentStart value={text} onChange={setText} disabled={navigating} composer={
      <ChatInput variant="hero" inputRef={inputRef} value={text} onChange={setText} onSend={submit}
        sending={navigating} locked={!draft.ready||navigating||workbench.connection!=="online"} draftLocked={navigating} placeholder={t("placeholder")}
        lockMessage={navigating ? (zh ? "正在打开会话…" : "Opening conversation…") : (zh ? "连接工作区后即可发送；可以先撰写草稿。" : "Send when the workspace connects. You can draft now.")}
        settings={settings} onSettingsChange={next=>{setSettings(next);draft.setSettings(next);}} modelOptions={modelOptions}
        attachments={attachments} onAttachmentsChange={setAttachments} />
    } />
  </div>;
}
export default CommandHome;
