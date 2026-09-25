"use client";

import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { ChatAttachment, ChatRunSettings } from "../../lib/chat";
import { draftWindowId,savedDrafts,saveDurableDraft,type SavedDraft } from "../../lib/durableDrafts";
import { getRuntimeInfo } from "./useWorkbench";
import { EMPTY_CHAT_DRAFT, readChatDraft, writeChatDraft, type ChatDraft } from "../../lib/chatDraft";

/** Persist by route identity, never by whichever session an async reply last used. */
export function useChatDraft(scope: string) {
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const [snapshot, setSnapshot] = useState<{ scope: string; draft: ChatDraft }>({ scope, draft: EMPTY_CHAT_DRAFT });
  const workspace=useRef("");
  const edited=useRef(new Set<string>());
  const [recovery,setRecovery]=useState<SavedDraft[]>([]);
  const [storageError,setStorageError]=useState(false);
  useEffect(()=>{
    let disposed=false;
    getRuntimeInfo().then(async info=>{
      workspace.current=info.workspace_id;
      const rows=await savedDrafts(info.workspace_id,scope);
      if(disposed)return;
      const own=rows.find(row=>row.windowId===draftWindowId());
      const current=readChatDraft(scope);
      if(own&&!edited.current.has(scope)&&!current.text&&!current.attachments.length){writeChatDraft(scope,own.draft);setSnapshot({scope,draft:own.draft});}
      setRecovery(rows.filter(row=>row.windowId!==draftWindowId()));
    }).catch(()=>{if(!disposed)setStorageError(true);});
    const error=()=>setStorageError(true);window.addEventListener("nerya:draft-storage-unavailable",error);
    return()=>{disposed=true;window.removeEventListener("nerya:draft-storage-unavailable",error);};
  },[scope]);
  useEffect(() => { setSnapshot({ scope, draft: readChatDraft(scope) }); }, [scope]);
  const update = useCallback((apply: (draft: ChatDraft) => ChatDraft) => {
    const draft = apply(readChatDraft(scope));
    writeChatDraft(scope, draft);
    edited.current.add(scope);
    if(workspace.current)saveDurableDraft(workspace.current,scope,draft);
    // A late completion may clear its own draft, never the newly opened chat.
    if (activeScope.current === scope) setSnapshot({ scope, draft });
  }, [scope]);
  const setText = useCallback((value: SetStateAction<string>) => update(draft => ({ ...draft,
    text: typeof value === "function" ? value(draft.text) : value })), [update]);
  const setAttachments = useCallback((value: SetStateAction<ChatAttachment[]>) => update(draft => ({ ...draft,
    attachments: typeof value === "function" ? value(draft.attachments) : value })), [update]);
  const draft = snapshot.scope === scope ? snapshot.draft : EMPTY_CHAT_DRAFT;
  const setSettings=useCallback((settings:ChatRunSettings)=>update(draft=>({...draft,settings})),[update]);
  return { text: draft.text, attachments: draft.attachments, settings:draft.settings, setSettings,setText, setAttachments, recovery,storageError,
    restore:(row:SavedDraft)=>{update(()=>row.draft);setRecovery([]);},dismissRecovery:()=>setRecovery([]) };
}
