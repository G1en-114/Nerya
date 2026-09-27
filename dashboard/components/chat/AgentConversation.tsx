"use client";
import { copy as i18nCopy } from "../../lib/i18n";

import { useMemo } from "react";
import { useLocale } from "next-intl";
import { AssistantBubble, UserBubble } from "./ChatMessage";
import { StreamedMarkdown } from "./TurnBlocks";
import { MessagesIcon } from "../icons";
import { RoleAvatar } from "../RoleAvatar";
import { agentRuns, childResult, contentValue, pairOperations, readableResult, working, type AgentRun } from "../../lib/agentConversation";
import { ToolActivity } from "./ReadableExecution";
import type { AgentDetail, AgentMail, AgentWork } from "./useAgentWork";
import type { ChatResult } from "../../lib/chatResults";

function Mail({ mail, names }: { mail: AgentMail; names: Map<string, string> }) {
  const zh = useLocale().startsWith("zh");
  const label = (names.get(mail.sender) || i18nCopy(zh, "copy.components_chat_AgentConversation.001")) + ' → ' + (names.get(mail.recipient) || i18nCopy(zh, "copy.components_chat_AgentConversation.002"));
  return <div data-testid="agent-mail">
    <div className="mt-4 flex items-center gap-2 text-xs text-[color:var(--text-muted)]"><MessagesIcon size={13}/>{label}{mail.status === 'queued' ? ' · ' + i18nCopy(zh, "copy.components_chat_AgentConversation.003") : ''}</div>
    {mail.sender === 'operator' || mail.sender === 'lead'
      ? <UserBubble msg={{ id: mail.id, role: 'user', text: mail.content, ts: mail.ts * 1000 }} />
      : <AssistantBubble msg={{ id: mail.id, role: 'assistant', ts: mail.ts * 1000, turn: { reply_text: mail.content } }} />}
  </div>;
}

function Run({ row, run, messages, names, onOpenResult }: {
  row: AgentWork; run: AgentRun; messages: AgentMail[]; names: Map<string, string>; onOpenResult?: (result: ChatResult) => void;
}) {
  const zh = useLocale().startsWith("zh");
  const result = childResult(row, run.output, run.attempt, zh);
  const isActive = working(run.state);
  const final = result.text.trim().replace(/\s+/g, " ");
  const complete = run.state === "completed";
  const steps = pairOperations(run.events).filter((step) => {
    if (step.event.kind === "thinking") return false;
    if (step.event.kind !== "text") return true;
    const raw = step.data.text;
    const text = readableResult(raw, zh).trim().replace(/\s+/g, " ");
    return Boolean(text) && (!final || !final.includes(text)) && typeof contentValue(raw) === "string";
  });
  const timeline = [
    ...steps.map((step) => ({ key: `step:${step.key}`, ts: step.event.ts, node: step.event.kind.startsWith("tool_") ? <ToolActivity step={step} state={run.state} />
      : <div className="py-3 text-sm leading-relaxed"><StreamedMarkdown text={readableResult(step.data.text || step.data.error, zh)} /></div> })),
    ...messages.map((mail) => ({ key: `mail:${mail.id}`, ts: mail.sender === row.id ? mail.ts : Number((mail as AgentMail & { delivered_at?: number }).delivered_at || mail.ts), node: <Mail mail={mail} names={names} /> })),
  ].sort((a, b) => a.ts - b.ts);
  return <section data-agent-run={run.attempt}>
    {run.instruction || run.attempt === 1 ? <UserBubble msg={{ id: `${row.id}:instruction:${run.attempt}`, role: "user", ts: run.ts * 1000, text: run.instruction || row.title }} /> : null}
    <div className="native-agent-identity mb-2 mt-4 flex items-center gap-2 text-xs font-medium"><RoleAvatar role={row.name} size={32} alt="" /><span>{row.name}</span></div>
    <AssistantBubble msg={{ id: `${row.id}:run:${run.attempt}`, role: "assistant", ts: run.ts * 1000, loading: isActive, execution_status: run.state === "completed" ? "succeeded" : run.state,
      error: run.state === "failed" ? run.error || (i18nCopy(zh, "copy.components_chat_AgentConversation.007")) : undefined,
      turn: { reply_text: !isActive ? result.text : "" } }}
      traceContent={timeline.length ? <div data-testid="agent-conversation-stream">{timeline.map(item => <div key={item.key}>{item.node}</div>)}</div> : undefined}
      onOpenResult={onOpenResult && complete && result.text ? () => onOpenResult(result) : undefined} />

  </section>;
}

export function AgentConversation({ row, detail, rows, onOpenResult }: {
  row: AgentWork; detail: AgentDetail | null; rows: AgentWork[]; onOpenResult?: (result: ChatResult) => void;
}) {
  const zh = useLocale().startsWith("zh");
  const runs = useMemo(() => agentRuns(row, detail), [row, detail]);
  const names = new Map(rows.map((a) => [a.id, a.name]));
  names.set("operator", i18nCopy(zh, "copy.components_chat_AgentConversation.011")); names.set("lead", "Nerya");
  const messages = detail?.messages || [];
  const mailbox = new Map<number, AgentMail[]>();
  for (const mail of messages.filter((m) => m.status !== "queued")) {
    const deliveredAttempt = (mail as AgentMail & { attempt?: number }).attempt;
    const targetRun = mail.recipient === row.id && deliveredAttempt && runs.some((r) => r.attempt === deliveredAttempt) ? deliveredAttempt
      : [...runs].reverse().find((r) => r.ts <= mail.ts)?.attempt || runs[0]?.attempt;
    if (targetRun) mailbox.set(targetRun, [...(mailbox.get(targetRun) || []), mail]);
  }
  return <div data-testid="agent-conversation">
    {runs.map((run) => <Run key={run.attempt} row={row} run={run} names={names}
      messages={mailbox.get(run.attempt) || []} onOpenResult={onOpenResult} />)}
    {row.legacy && !row.legacySteps?.length ? <p className="mt-3 text-xs text-[color:var(--text-muted)]">{i18nCopy(zh, "copy.components_chat_AgentConversation.012")}</p> : null}
    {row.legacySteps?.map((step) => <details key={step.key} className="py-2 text-sm"><summary className="cursor-pointer">{step.label}</summary><StreamedMarkdown text={readableResult(step.detail, zh)} /></details>)}
    {messages.filter((mail) => mail.status === "queued").map((mail) => <Mail key={mail.id} mail={mail} names={names} />)}
  </div>;
}
