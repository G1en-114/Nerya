import type { ArtifactIndex, VerifierOutcome, ExecutionState } from "./workbench";
import { type AssistantMessage, type ChatThread, type NativeBlock, type NativeBlockEnvelope, type TurnPayload } from "./chat";

export type ChatResult = { id: string; title: string; text: string; ts: number; turnId?: string; agentId?: string; attempt?: number; evidence?: { artifacts?: ArtifactIndex; verifier?: VerifierOutcome; execution?: ExecutionState } };
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const normalized = (value: unknown): string => text(value).replace(/\s+/g, " ");

/** Only explicitly public fields can become a result; reasoning is never a fallback. */
export function finalReplyText(message: AssistantMessage): string {
  // External call/progress rows belong to the conversation, never the final-answer canvas.
  if (message.loading || message.error || !message.turn || message.turn.external_call) return "";
  const turn = message.turn;
  return text(turn.reply_text) || text(turn.final_text) || text(turn.decision?.text);
}

/** Reuse the event reducer's text blocks; tool outputs and thinking stay in the trace. */
export function publicReplyText(message: AssistantMessage, blocks: NativeBlockEnvelope[]): string {
  if (message.turn?.external_call) return "";
  return finalReplyText(message) || blocks.flatMap(env => {
    const block = env.block || env as NativeBlock;
    return (block.kind || env.kind) === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n\n");
}

export function withoutPublicText(blocks: NativeBlockEnvelope[]): NativeBlockEnvelope[] {
  return blocks.filter(env => ((env.block || env as NativeBlock).kind || env.kind) !== "text");
}

/** Canvas reads the same saved turns as chat, not a second copy or a generated summary. */
export function collectChatResults(thread: ChatThread | null): ChatResult[] {
  if (!thread) return [];
  let request = thread.title;
  const results: ChatResult[] = [];
  for (const message of thread.messages) {
    if (message.role === "user") { request = message.text || request; continue; }
    const body = finalReplyText(message);
    if (body) results.push({ id: message.id, title: request.split("\n")[0].slice(0, 120),
      text: body, ts: message.ts, turnId: message.turn?.turn_id, evidence: { artifacts:message.turn?.artifact_index,verifier:message.turn?.verifier_outcome,execution:message.turn?.execution_state } });
  }
  return results;
}

/** Remove only the final text/its streamed fragments from the execution trace. */
export function withoutFinalReply(blocks: NativeBlockEnvelope[], reply: string): NativeBlockEnvelope[] {
  const final = normalized(reply);
  if (!final) return blocks;
  return blocks.filter((env) => {
    const block = env.block || env as NativeBlock;
    if ((block.kind || env.kind) !== "text") return true;
    const chunk = normalized(block.text);
    return Boolean(chunk) && !final.includes(chunk);
  });
}

export function turnWithoutFinalReply(turn: TurnPayload, reply: string): TurnPayload {
  const final = normalized(reply);
  return { ...turn, blocks: withoutFinalReply(turn.blocks || [], reply),
    events: turn.events?.filter((event) => !final || normalized(event.text) !== final) };
}
