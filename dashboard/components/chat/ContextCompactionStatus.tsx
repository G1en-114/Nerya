"use client";
import { useLocale } from "next-intl";
import type { LiveEvent } from "../../lib/chat";

export function ContextCompactionStatus({events}:{events:LiveEvent[]}) {
  const zh=useLocale().startsWith("zh");
  const event=events.findLast(item=>["compact.start","compact.complete","context.degraded"].includes(item.kind));
  if(!event)return null;
  const running=event.kind==="compact.start", degraded=event.kind==="context.degraded"||event.preservation_status==="failed"||event.status==="context_degraded";
  const label=degraded?(zh?"上下文保留不完整，请核对早期约束":"Context is incomplete; review earlier constraints"):
    running?(zh?"正在整理上下文":"Organizing context"):
    event.status==="applied"?(zh?"上下文已整理":"Context organized"):(zh?"上下文整理未改变历史":"Context organization did not change history");
  const causes:Record<string,string>={message_count:zh?"历史消息较多":"Message count",token_pressure:zh?"接近窗口预算":"Window pressure",context_overflow:zh?"提供方报告上下文溢出":"Provider context overflow",checkpoint_conflict:zh?"历史同时被修改":"Concurrent history edit"};
  return <details className="mb-3 rounded border border-[color:var(--line)] px-3 py-2 text-xs" data-testid="context-compaction-status"><summary className={degraded?"cursor-pointer text-warn":"cursor-pointer text-[color:var(--text-muted)]"}>{label}</summary><div className="mt-2 space-y-1 text-[color:var(--text-muted)]">
    <p>{causes[String(event.cause||event.reason)]||String(event.cause||event.reason||"")}</p>
    {typeof event.before_message_count==="number"&&<p>{zh?"消息数：":"Messages: "}{event.before_message_count}{typeof event.after_message_count==="number"?" → "+event.after_message_count:""}</p>}
    {typeof event.before_chars==="number"&&<p>{zh?"字符估算：":"Estimated characters: "}{event.before_chars}{typeof event.after_chars==="number"?" → "+event.after_chars:""}</p>}
    <p>{zh?"任务状态是规划记录，不代表授权或已完成验证；原始记录仍保留。":"Task state is planning data, not authorization or verified completion. Original records are retained."}</p>
  </div></details>;
}
