import type { LiveEvent } from "./chat";

/** Only transport identity may deduplicate a delta. Equal text is not identity. */
export function streamEventKey(event: LiveEvent): string {
  if (event.event_id) return String(event.event_id);
  if (typeof event.seq !== "number") return "";
  return [event.session_id || "", event.turn_id || "", event.epoch || "", event.seq].join(":");
}

export function mergeStreamEvents(...batches: readonly LiveEvent[][]): LiveEvent[] {
  const out: LiveEvent[] = [];
  const seen = new Set<string>();
  for (const batch of batches) for (const event of batch) {
    const key = streamEventKey(event);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(event);
  }
  // A replay page can fill an earlier gap. Order only events sharing a sequence
  // domain; never compare counters from different turns or restarted buses.
  const domains = new Map<string, { indexes:number[]; events:LiveEvent[]; ordered:boolean }>();
  for (const [index,event] of out.entries()) {
    if (!Number.isFinite(event.seq)) continue;
    const scope = JSON.stringify([event.session_id || "", event.turn_id || "", event.epoch || ""]);
    let domain = domains.get(scope);
    if (!domain) { domain={indexes:[],events:[],ordered:true}; domains.set(scope,domain); }
    if (domain.events.length && domain.events.at(-1)!.seq > event.seq) domain.ordered=false;
    domain.indexes.push(index); domain.events.push(event);
  }
  for (const domain of domains.values()) if (!domain.ordered) {
    domain.events.sort((a,b)=>a.seq-b.seq);
    domain.indexes.forEach((index,position)=>{out[index]=domain.events[position];});
  }
  return out;
}
