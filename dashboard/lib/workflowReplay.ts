import type { WorkflowGraph, WorkflowKind, WorkflowNode } from "./workflowTypes";

export type RecordedCall = { id: string; name: string; kind?: "script" | "agent"; input?: unknown; output?: unknown; status: string };
export type ReplayInvocation = { id: string; kind: "script" | "agent"; title: string; status: string; input?: unknown; output?: unknown; calls: RecordedCall[] };

/** Build a read-only evidence graph, never project today's code onto old runs. */
export function invocationGraph(run: ReplayInvocation, labels: { input: string; output: string; call: string }): WorkflowGraph {
  const node = (id: string, kind: WorkflowKind, title: string, x: number, y: number, input: unknown, output: unknown, status: string): WorkflowNode => ({
    id, kind, title, subtitle: status, resource: id, position: { x, y },
    config: { input, output }, description: status,
    binding: { file: null, path: null }, editable: false, status,
  });
  const nodes = [node("invocation", run.kind, run.title, 40, 80, run.input, run.output, run.status)];
  run.calls.forEach((call, index) => nodes.push(node(`call:${call.id}`, call.kind || "script", call.name || labels.call, 380 + Math.floor(index / 6) * 340, 40 + index % 6 * 190, call.input, call.output, call.status)));
  const edges = nodes.slice(1).map((child) => ({ id: `contains:${child.id}`, source: "invocation", target: child.id, relation: "contains", origin: "runtime" as const, label: labels.call }));
  return { id: `replay:${run.id}`, nodes, edges };
}

export function selectedInvocation<T>(items: T[], selected: string, key: (item: T) => string): T | undefined {
  // An explicitly selected missing invocation must NEVER fall back to the latest.
  return selected ? items.find((item) => key(item) === selected) : items[0];
}

export type ReplayMessage = { id: string; role: "user" | "assistant" | "tool"; content: unknown; callId?: string; label?: string };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Only recorded public blocks; missing correlation IDs are never guessed. */
export function publicReplay(value: unknown): { calls: RecordedCall[]; messages: ReplayMessage[] } {
  const calls = new Map<string, RecordedCall>();
  const messages: ReplayMessage[] = [];
  for (const [index, raw] of (Array.isArray(value) ? value : []).entries()) {
    const block = object(raw);
    const kind = String(block.kind || "");
    if (["text", "user", "assistant"].includes(kind)) {
      messages.push({ id: `message:${index}`, role: kind === "user" ? "user" : "assistant", content: block.text ?? block.content });
    } else if (kind === "tool_use" || kind === "tool_result") {
      const id = String(block.call_id || `unlinked:${index}`);
      const previous = calls.get(id);
      const name = String(block.tool || block.name || [block.skill_id, block.action].filter(Boolean).join(".") || previous?.name || id);
      const input = kind === "tool_use" ? block.payload ?? block.input : previous?.input;
      const output = kind === "tool_result" ? block.result ?? block.error : previous?.output;
      const status = kind === "tool_result" ? block.ok === false || block.ok === 0 || block.error != null ? "error" : block.ok === true || block.ok === 1 ? "returned" : "unknown" : previous?.status || "unknown";
      calls.set(id, { id, name, input, output, status });
      messages.push({ id: `message:${index}`, role: "tool", callId: id, label: name, content: kind === "tool_use" ? input : output });
    }
  }
  return { calls: [...calls.values()], messages };
}

export function recordedTurnReplay(value: unknown) {
  const turn = object(value);
  const rows: Array<{ ts: string; index: number; block: Record<string, unknown> }> = [];
  for (const item of Array.isArray(turn.messages) ? turn.messages : []) {
    const message = object(item);
    if (message.role !== "user" && message.role !== "assistant") continue;
    rows.push({ ts: String(message.ts || ""), index: rows.length, block: { kind: message.role, content: message.content } });
  }
  for (const item of Array.isArray(turn.events) ? turn.events : []) {
    const event = object(item), payload = object(event.payload);
    rows.push({ ts: String(event.ts || ""), index: rows.length, block: {
      kind: event.phase, call_id: event.call_id, tool: event.tool, ok: event.ok,
      payload: payload.payload, result: payload.result, error: payload.error,
    } });
  }
  rows.sort((a, b) => a.ts.localeCompare(b.ts) || a.index - b.index);
  return publicReplay(rows.map((row) => row.block));
}

export function rememberInvocation(id: string, scope: "strategy" | "evolution") {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("workflow_log", scope);
  if (id) url.searchParams.set("workflow_run", id);
  else url.searchParams.delete("workflow_run");
  if (/\/strategies\/[^/]+$/.test(url.pathname)) url.searchParams.set("tab", "workflow");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}
