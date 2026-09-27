"use client";

import * as Dialog from "@radix-ui/react-dialog";
import {InfoIcon,XIcon} from "../icons";
import { useState } from "react";
import { useLocale } from "next-intl";
import type { AssistantMessage, ChatAttachment } from "../../lib/chat";
import { ReferenceSnapshot } from "./ReferenceSnapshot";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
export function ConversationContext({ message }: { message: AssistantMessage }) {
  const zh = useLocale().startsWith("zh"), locale = zh ? "zh-CN" : "en-US";
  const [open, setOpen] = useState(false);
  const context = object(message.turn?.context_snapshot), budget = object(message.turn?.budget);
  const requested = object(context.requested_model), accepted = object(context.accepted_model), strategy = object(context.strategy_source);
  const response = object(context.interaction_response);
  const memory = object(budget.memory_usage);
  const memories = Array.isArray(memory.included) ? memory.included.map(object) : [];
  const omittedMemories = Array.isArray(memory.omitted) ? memory.omitted.length : 0;
  const attachmentReceipts = (message.turn?.attachments || []).filter(item => typeof item.model_sent === "boolean");
  const original = typeof context.input_text === "string" ? context.input_text : "";
  const attachments = Array.isArray(context.attachments) ? context.attachments.map(object) : [];
  const format = (value: unknown) => number(value) === null ? (zh ? "未提供" : "Not reported") : new Intl.NumberFormat(locale).format(Number(value));
  if (!Object.keys(context).length && !Object.keys(budget).length && !attachmentReceipts.length) return null;
  return <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Trigger asChild><button type="button" aria-label={zh?"本轮详情":"Turn details"} title={zh?"本轮详情":"Turn details"} className="inline-flex h-8 w-8 items-center justify-center rounded text-[color:var(--text-muted)] hover:bg-[color:var(--panel-bg)]" data-testid="turn-context"><InfoIcon size={14}/></button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="ui-modal-overlay"/><Dialog.Content className="ui-dialog max-h-[80vh] overflow-y-auto" aria-describedby={undefined}><div className="mb-3 flex items-center justify-between gap-3"><Dialog.Title className="text-sm font-semibold">{zh?"本轮上下文与用量":"Turn context and usage"}</Dialog.Title><Dialog.Close className="ui-icon-button" aria-label={zh?"关闭":"Close"}><XIcon size={16}/></Dialog.Close></div>
    {open && <div className="space-y-3 border-t border-[color:var(--line)] py-3">
      {Object.keys(response).length > 0 && <div className="rounded border border-[color:var(--line)] p-3 text-sm"><p>{String(response.title || (zh ? "用户决定" : "User decision"))}</p><p className="mt-1 text-[color:var(--text-muted)]">{response.action === "revise" ? (zh ? "请求修改计划" : "Requested plan revision") : response.action === "accept" || response.action === "answer" ? (zh ? "已提交回答或确认" : "Answer or confirmation submitted") : String(response.action || "")}</p>{typeof response.text === "string" && response.text && <p className="mt-2 whitespace-pre-wrap">{response.text}</p>}</div>}
      <dl className="grid grid-cols-[minmax(100px,auto)_minmax(0,1fr)] gap-x-4 gap-y-2">
        <dt>{zh ? "接收时的模型" : "Model at admission"}</dt><dd className="break-words">{[accepted.provider, accepted.model].filter(value => typeof value === "string" && value).join(" · ") || (zh ? "运行时解析" : "Resolved at execution")}</dd>
        <dt>{zh ? "提供方报告的模型" : "Provider-reported model"}</dt><dd className="break-words">{[budget.reported_provider,budget.reported_model].filter(value => typeof value === "string" && value).join(" · ") || (zh ? "未提供" : "Not reported")}</dd>
        <dt>{zh ? "请求的窗口" : "Requested window"}</dt><dd>{format(requested.model_context_window)}</dd>
        <dt>{zh ? "执行采用的窗口预算" : "Execution window budget"}</dt><dd>{format(budget.context_window)}</dd>
        <dt>{zh ? "最近一次输入用量" : "Last prompt tokens"}</dt><dd>{format(budget.prompt_tokens_last)}</dd>
        <dt>{zh ? "本轮累计输入 / 输出" : "Turn input / output totals"}</dt><dd>{format(budget.input_tokens_total)} / {format(budget.output_tokens_total)}</dd>
        <dt>{zh ? "上下文压缩次数" : "Context compactions"}</dt><dd>{format(budget.compaction_count)}</dd>
        {Boolean(context.strategy_id) && <><dt>{zh ? "绑定策略" : "Bound strategy"}</dt><dd className="break-all font-mono">{String(context.strategy_id)}</dd><dt>{zh ? "候选提案" : "Candidate proposal"}</dt><dd className="break-all">{String(context.proposal_id || (zh ? "已发布版本" : "Published version"))}</dd></>}
        {Boolean(strategy.revision) && <><dt>{zh ? "接收时的版本" : "Revision at admission"}</dt><dd className="break-all font-mono">{String(strategy.revision)}</dd></>}
      </dl>
      {attachmentReceipts.length > 0 && <section><h3 className="text-sm font-medium">{zh ? "附件接收情况" : "Attachment delivery"}</h3>{attachmentReceipts.map(item => <div key={item.id} className="mt-2 text-xs"><span>{item.name}</span><span className={item.model_sent ? "ml-2 text-[color:var(--text-muted)]" : "ml-2 text-warn"}>{item.model_sent ? (zh ? "已加入模型请求" : "Included in model request") : (zh ? "未发送给模型" : "Not sent to model")}</span>{!item.model_sent && item.reason && <p className="mt-1 break-words text-[color:var(--text-muted)]">{item.reason}</p>}</div>)}<p className="mt-2 text-xs text-[color:var(--text-muted)]">{zh ? "加入请求不等于模型已正确理解；缺少记录的附件不推断为成功。" : "Inclusion does not prove correct model interpretation. Missing receipts are not assumed successful."}</p></section>}
      {Object.keys(memory).length > 0 && <details><summary className="cursor-pointer py-2">{zh ? "本轮记忆上下文" : "Memory context for this turn"} · {memories.length}</summary>
        {memory.reason === "checkpoint_context_reused" ? <p>{zh ? "本轮沿用检查点上下文，没有重新注入记忆。" : "This continuation reused checkpoint context; memory was not newly injected."}</p> : <>
          <p>{zh ? "以下为本轮请求采用的冻结记忆清单。" : "Frozen memory entries attached for this turn's request."}</p>
          {memories.map((item,index) => <div key={String(item.memory_id || index)} className="mt-2 border-l border-[color:var(--line)] pl-3"><p className="break-words">{String(item.stable_key || item.category || item.kind || "Memory")}</p><p className="break-all text-xs text-[color:var(--text-muted)]">{String(item.source_ref || (zh ? "来源未记录" : "Source not recorded"))} · {String(item.version || "").slice(0,12)}</p></div>)}
          {omittedMemories > 0 && <p className="mt-2 text-xs">{zh ? "因预算或读取状态未采用：" : "Omitted for budget or read state: "}{omittedMemories}</p>}
          {!memories.length && <p>{memory.reason === "use_disabled" ? (zh ? "已关闭记忆使用。" : "Memory use is disabled.") : (zh ? "本轮没有记录采用的记忆条目。" : "No included memory entries were recorded for this turn.")}</p>}
        </>}
      </details>}
      <p>{zh ? "窗口预算是配置，不等于提供方已验证的最大能力。累计用量不是当前上下文大小；未报告的值不会按零显示。" : "Window budgets are configuration, not a provider-verified limit. Cumulative usage is not current context size; unreported values are not shown as zero."}</p>
      {attachments.length > 0 && <div className="flex flex-wrap gap-2">{attachments.map((item,index) => <ReferenceSnapshot key={String(item.id || index)}
        attachment={{ name:String(item.name || "Reference"), artifact_uri:typeof item.artifact_uri === "string" ? item.artifact_uri : undefined, reference:item.reference as ChatAttachment["reference"] }}
        className="rounded-md border border-[color:var(--line)] px-2 py-1.5 text-left hover:bg-[color:var(--card)]" />)}</div>}
      {original && <details><summary className="cursor-pointer py-1">{zh ? "生成本轮时的原始输入" : "Original input for this turn"}</summary><p className="max-h-40 overflow-auto whitespace-pre-wrap break-words py-2">{original}</p></details>}
    </div>}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
