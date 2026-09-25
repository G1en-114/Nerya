"use client";
import { useRef, useState } from "react";
import { useLocale } from "next-intl";
import { callApi, ApiError } from "../../lib/clientApi";
import type { Interaction } from "../../lib/workbench";
import { readEditDraft, writeEditDraft } from "../../lib/editDrafts";

export function InteractionPanel({items,onResolved}:{items:Interaction[];onResolved:()=>void}) {
  return <div className="mx-auto w-full max-w-[860px] space-y-3 px-4">{items.map(item=><InteractionCard key={item.interaction_id} item={item} onResolved={onResolved}/>)}</div>;
}
function InteractionCard({item,onResolved}:{item:Interaction;onResolved:()=>void}) {
  const zh=useLocale().startsWith("zh");
  const key="interaction:"+item.interaction_id;
  const [draft,setDraft]=useState(()=>readEditDraft<{text:string;selected:string[];response_id:string}>(key) || {text:"",selected:[],response_id:crypto.randomUUID()});
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const lock=useRef(false);
  const [expanded,setExpanded]=useState(item.state!=="deferred");
  function change(next:Partial<typeof draft>){const value={...draft,...next};setDraft(value);writeEditDraft(key,value);}
  async function respond(action:"answer"|"defer") {
    if(lock.current)return;lock.current=true;setBusy(true);setError("");
    try {
      const result=await callApi<{ok:boolean;error?:string}>("/agent/interactions/respond",{method:"POST",body:{...draft,session_id:item.session_id,interaction_id:item.interaction_id,expected_revision:item.revision,action}});
      if(!result.ok)throw new Error(result.error);
      if(action==="answer")writeEditDraft(key,null);else {setExpanded(false);change({response_id:crypto.randomUUID()});}
      onResolved();
    } catch(reason) {
      const conflict=reason instanceof ApiError&&reason.status===409;
      setError(conflict?(zh?"任务状态已变化或断点仍在保存。刷新状态后重试，回答已保留。":"The task changed or its checkpoint is still saving. Refresh and retry; your answer is retained."):(zh?"回答尚未确认送达，可用同一请求重试。":"Delivery is unconfirmed. Retry the same response."));
      onResolved();
    } finally {lock.current=false;setBusy(false);}
  }
  return <section className="rounded-lg border border-[color:var(--line)] bg-[color:var(--card)] p-4" data-testid="user-interaction" aria-labelledby={item.interaction_id}>
    <button type="button" className="flex min-h-11 w-full items-center justify-between gap-3 text-left" onClick={()=>setExpanded(!expanded)} aria-expanded={expanded}>
      <strong id={item.interaction_id}>{item.payload.title}</strong><span className="text-xs text-[color:var(--text-muted)]">{item.kind==="plan"?(zh?"计划待确认":"Plan to review"):(zh?"需要你的回答":"Your answer needed")}</span>
    </button>
    {expanded&&<form onSubmit={e=>{e.preventDefault();void respond("answer");}} className="space-y-3">
      {item.payload.message&&<p className="whitespace-pre-wrap text-sm">{item.payload.message}</p>}
      {item.payload.steps&&<ol className="list-decimal space-y-1 pl-5 text-sm">{item.payload.steps.map((step,i)=><li key={i}>{step}</li>)}</ol>}
      {item.payload.deliverables?.length ? <p className="text-sm">{zh?"交付物：":"Deliverables: "}{item.payload.deliverables.join(" · ")}</p>:null}
      {item.payload.constraints?.length ? <p className="text-sm">{zh?"约束：":"Constraints: "}{item.payload.constraints.join(" · ")}</p>:null}
      {item.payload.choices?.map(choice=><label key={choice} className="flex min-h-11 items-center gap-3 rounded px-2 hover:bg-[color:var(--panel-bg)]"><input type={item.payload.multiple?"checkbox":"radio"} name={item.interaction_id} checked={draft.selected.includes(choice)} disabled={busy}
        onChange={e=>change({selected:item.payload.multiple ? e.target.checked?[...draft.selected,choice]:draft.selected.filter(v=>v!==choice):[choice]})}/><span>{choice}</span></label>)}
      <label className="block text-sm">{zh?"补充说明":"Additional details"}<textarea className="input-dark mt-1 min-h-20 w-full" value={draft.text} maxLength={12000} disabled={busy} onChange={e=>change({text:e.target.value})}/></label>
      {item.kind==="plan"&&<p className="text-xs text-[color:var(--text-muted)]">{zh?"接受后开始执行这一版计划，原有工具和资金审批仍然有效。":"Accepting starts this plan version. Existing tool and financial approvals still apply."}</p>}
      <div className="flex flex-wrap gap-2"><button type="submit" disabled={busy||(item.kind==="question"&&!draft.text.trim()&&!draft.selected.length)} className="btn btn-primary min-h-11">{busy?(zh?"发送中…":"Sending…"):item.kind==="plan"?(zh?"接受计划并开始":"Accept plan and start"):(zh?"回答并继续":"Answer and continue")}</button>
      <button type="button" className="btn btn-secondary min-h-11" disabled={busy} onClick={()=>void respond("defer")}>{zh?"稍后处理":"Handle later"}</button></div>
    </form>}
    {error&&<p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
  </section>;
}
