"use client";
import {useLocale} from "next-intl";
import type {AgentWork} from "./useAgentWork";
export function CollaborationSummary({agents,onOpen}:{agents:AgentWork[];onOpen:()=>void}){
 const zh=useLocale().startsWith("zh");
 if(!agents.length)return null;
 const active=agents.filter(a=>["running","queued"].includes(a.state)),blocked=agents.filter(a=>["failed","blocked","interrupted"].includes(a.state));
 return <details className="mx-auto w-full max-w-[860px] px-4 py-2 text-xs" data-testid="collaboration-summary">
  <summary className="min-h-10 cursor-pointer py-3">{zh?"Agent 协作":"Agent collaboration"} · {active.length} {zh?"执行中":"active"} · {blocked.length} {zh?"需要处理":"need attention"}</summary>
  <ul className="space-y-2">{agents.map(a=><li key={a.id} className="flex flex-wrap gap-2"><strong>{a.name}</strong><span className="min-w-0 flex-1">{a.title}</span><span>{a.state} · {zh?"第":"Attempt "}{a.attempt}{zh?" 次":""}</span></li>)}</ul>
  <button type="button" className="min-h-11 underline" onClick={onOpen}>{zh?"查看成员上下文与结果":"Inspect member context and results"}</button>
  <p className="text-[color:var(--text-muted)]">{zh?"继续成员任务沿用该成员已保存的上下文与权限。":"Continuing a member reuses its saved context and permissions."}</p>
 </details>;
}
