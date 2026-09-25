"use client";
import { useLocale } from "next-intl";
import type { ChatRunSettings,ChatThread } from "../../lib/chat";
export function ComposerContextSummary({thread,settings}:{thread:ChatThread|null;settings:ChatRunSettings}){
  const zh=useLocale().startsWith("zh");
  const last=thread?.messages.findLast(m=>m.role==="assistant");
  const budget=last?.role==="assistant"?last.turn?.budget:undefined;
  const prompt=budget?.prompt_tokens_last,window=budget?.context_window;
  return <details className="mx-auto max-w-[800px] px-4 py-1 text-xs text-[color:var(--text-muted)]" data-testid="composer-context">
    <summary className="min-h-9 cursor-pointer py-2">{zh?"下一轮：":"Next turn: "}{settings.model_id|| (zh?"默认模型":"Default model")} · {settings.reasoning_effort||"off"}{typeof prompt==="number" ? " · "+prompt.toLocaleString()+(typeof window==="number"?" / "+window.toLocaleString():"")+" tokens" : ""}</summary>
    <p>{zh?"更改用于下一轮。用量来自最近一次模型请求，未报告的用量保持未知。":"Changes apply to the next turn. Usage is from the last model request; unreported usage remains unknown."}</p>
    {typeof budget?.compaction_count==="number"&&budget.compaction_count>0&&<p>{zh?"上下文压缩次数：":"Context compactions: "}{budget.compaction_count}</p>}
  </details>;
}
