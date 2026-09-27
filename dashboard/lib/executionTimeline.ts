import type { NativeBlock, NativeBlockEnvelope, TurnPayload, LiveEvent } from "./chat";
import { operationIdentity, pairOperations, record, type ToolStep } from "./agentConversation";

export type ExecutionMember = { id:string; name:string; status:string; task:string };
export function executionSteps(blocks:NativeBlockEnvelope[], turn?:TurnPayload):ToolStep[] {
  const events = new Map<string,{seq:number;ts:number;kind:string;data:Record<string,unknown>}>();
  let seq=0;
  for (const [index,envelope] of blocks.entries()) {
    const block=record(envelope.block||envelope),kind=String(block.kind||envelope.kind||"");
    if(!["tool_use","tool_result"].includes(kind))continue;
    const id=operationIdentity(block),key=id?kind+":"+id:kind+":"+seq;
    const previous=events.get(key);
    events.set(key,{seq:previous?.seq??index,ts:0,kind,data:block});
    seq++;
  }
  // Old turns may only have a persisted tool trace. Do not duplicate modern blocks.
  if(!events.size)for(const [index,entry] of (turn?.tool_trace||[]).entries()) {
    events.set("legacy:"+index,{seq:seq++,ts:0,kind:"tool_result",data:{...entry,action:entry.action||entry.skill_id,call_id:"legacy:"+index}});
  }
  return pairOperations([...events.values()]);
}

export function executionMembers(events:LiveEvent[]):ExecutionMember[] {
  const members=new Map<string,ExecutionMember>();
  for(const e of events) {
    if(!e.kind.startsWith("team.")&&!e.kind.startsWith("subagent."))continue;
    const nested=record(e.event||e.data),name=String(e.subagent||e.role||nested.role||e.name||"");
    if(!name)continue;
    const id=String(e.agent_id||[e.team_run_id||e.group_id||"",e.team_task_id||name].join(":"));
    const previous=members.get(id);
    let status=String(e.status||nested.status||previous?.status||"queued");
    if(e.kind==="subagent.end")status=e.ok===false?"failed":"completed";
    else if(e.kind==="subagent.start")status="running";
    else if(e.kind.endsWith(".timeout"))status="timeout";
    members.set(id,{id,name,status,task:String(e.team_task_subject||e.task||previous?.task||"")});
  }
  return [...members.values()];
}

export function executionArtifacts(blocks:NativeBlockEnvelope[]):NativeBlockEnvelope[] {
  return blocks.filter(env=>["chart","attachment","approval_request"].includes(String((env.block||env as NativeBlock).kind||env.kind||"")));
}

export function executionDefaultOpen(loading:boolean, state:string, finalReply:string):boolean {
  return loading || !(["succeeded","completed"].includes(state) && Boolean(finalReply.trim()));
}

export type ExecutionEntry = { kind:"tool"; key:string; step:ToolStep } | { kind:"thinking"|"text"; key:string; block:NativeBlock; active:boolean };

/** Match results at the original call position, while preserving reasoning boundaries. */
export function executionEntries(blocks:NativeBlockEnvelope[], steps:ToolStep[], live:boolean):ExecutionEntry[] {
  const byId = new Map(steps.filter(step=>operationIdentity(step.data)).map(step => [operationIdentity(step.data), step]));
  const byBlock = new Map(steps.map(step => [step.event.data,step]));
  const used = new Set<string>(), entries:ExecutionEntry[] = [];
  let tail=-1;
  blocks.forEach((env,index)=>{if(["text","thinking","tool_use","tool_result"].includes(String((env.block||env).kind)))tail=index;});
  blocks.forEach((env,index) => {
    const b = (env.block || env) as NativeBlock, kind = String(b.kind || env.kind || "");
    if (kind === "tool_use" || kind === "tool_result") {
      const step = byId.get(operationIdentity(b)) || byBlock.get(b);
      if (step && !used.has(step.key)) { used.add(step.key); entries.push({ kind:"tool", key:`tool:${step.key}`, step }); }
    } else if ((kind === "thinking" || kind === "text") && typeof b.text === "string" && b.text.trim() && !b.retry) {
      const key = `${kind}:${b.stream_id || env.index || b.index || index}`;
      const active = live && b.completed !== true && (typeof b.presentation_active === "boolean" ? b.presentation_active : index===tail);
      entries.push({ kind, key, block:b, active });
    }
  });
  for (const step of steps) if (!used.has(step.key)) entries.push({kind:"tool",key:`tool:${step.key}`,step});
  return entries;
}

/** A single public body keeps its existing surface; intermediate multi-stage narration stays in order. */
export function partitionTranscript(blocks:NativeBlockEnvelope[], finalReply:string, fallbackReply:string) {
  const texts = blocks.filter(env => (env.block || env).kind === "text");
  const last = texts.at(-1);
  const reply = finalReply || (texts.length > 1 ? String((last?.block || last)?.text || "") : fallbackReply);
  const normalized = (value:unknown) => typeof value === "string" ? value.trim().replace(/\s+/g," ") : "";
  return { reply, work:blocks.filter(env => {
    if ((env.block || env).kind !== "text") return true;
    if (texts.length <= 1 || env === last) return false;
    return normalized((env.block || env).text) !== normalized(reply);
  }) };
}

/** Committed order wins; retained stream results only fill absent evidence, never replace a real result. */
export function enrichCommittedBlocks(committed:NativeBlockEnvelope[], streamed:NativeBlockEnvelope[]) {
  if (!committed.length) return streamed;
  const results = new Map(streamed.filter(env => (env.block || env).kind === "tool_result")
    .map(env => [operationIdentity(record(env.block || env)), env]));
  return committed.map(env => {
    const b = record(env.block || env);
    if (b.kind !== "tool_result" || b.result != null) return env;
    const live = results.get(operationIdentity(b));
    return live ? {...env,block:{...record(live.block || live),...b,result:record(live.block || live).result}} : env;
  });
}
