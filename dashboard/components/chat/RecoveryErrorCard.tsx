"use client";
import {useState} from "react";
import {useLocale} from "next-intl";
import * as Dialog from "@radix-ui/react-dialog";
import {InfoIcon,XIcon} from "../icons";
import {conversationError} from "../../lib/conversationError";

/** One current error, one recovery action; diagnostics never expand the transcript. */
export function ErrorCard({error,onRetry,onContinue}:{error:string;onRetry?:()=>void;onContinue?:()=>void}){
 const zh=useLocale().startsWith("zh"),model=conversationError(error,zh);
 const [copied,setCopied]=useState(false);
 return <div role="alert" data-turn-section="error" className="my-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-[color:var(--line-hi)] bg-[color:var(--card)] px-3 py-2.5">
   <InfoIcon size={16} className="shrink-0 text-warn"/>
   <p className="min-w-[180px] flex-1 text-[13px] leading-6 text-[color:var(--text-base)]">{model.message}</p>
   <div className="flex items-center gap-2 text-xs">
     {onContinue?<button type="button" className="min-h-8 rounded px-2 hover:bg-[color:var(--panel-bg)]" onClick={onContinue}>{zh?"继续本轮":"Continue this turn"}</button>:onRetry&&model.canRerun?<button type="button" data-turn-section="error-retry" className="min-h-8 rounded px-2 hover:bg-[color:var(--panel-bg)]" onClick={onRetry}>{zh?"重新运行":"Run again"}</button>:null}
     {model.needsSettings&&<a href="/settings" className="min-h-8 px-2 py-1.5 underline">{zh?"模型设置":"Model settings"}</a>}
     <Dialog.Root><Dialog.Trigger asChild><button type="button" data-turn-section="error-toggle" className="min-h-8 rounded px-2 text-[color:var(--text-muted)] hover:bg-[color:var(--panel-bg)]">{zh?"详情":"Details"}</button></Dialog.Trigger>
       <Dialog.Portal><Dialog.Overlay className="ui-modal-overlay"/><Dialog.Content className="ui-dialog" style={{width:'min(680px,calc(100vw - 24px))'}}><div className="flex items-center justify-between gap-4"><Dialog.Title className="text-sm font-semibold">{zh?"错误详情":"Error details"}</Dialog.Title><Dialog.Close className="ui-icon-button" aria-label={zh?"关闭":"Close"}><XIcon size={16}/></Dialog.Close></div><Dialog.Description className="mt-3 text-sm text-[color:var(--text-muted)]">{model.message}</Dialog.Description>
       <pre data-turn-section="error-raw" className="my-4 max-h-[55vh] overflow-auto whitespace-pre-wrap break-all rounded bg-[color:var(--bg)] p-3 text-xs leading-5">{model.diagnostics}</pre><button type="button" className="btn btn-secondary text-xs" onClick={async()=>{try{await navigator.clipboard.writeText(model.diagnostics);setCopied(true);}catch{setCopied(false);}}}>{copied?(zh?"已复制":"Copied"):(zh?"复制脱敏信息":"Copy redacted details")}</button>
       </Dialog.Content></Dialog.Portal>
     </Dialog.Root>
   </div>
 </div>;
}
