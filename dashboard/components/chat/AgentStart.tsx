"use client";
import { copy as i18nCopy } from "../../lib/i18n";

import { useId, useRef, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronRightIcon } from "../icons";
import { WorkspaceTabs } from "./WorkspaceTabs";type Topic = { id: string; label: string };
type Starter = { id: string; topic: string; label: string; prompt: string };


export function AgentStart({ composer, value, onChange, disabled = false }: {
  composer: ReactNode; value: string; onChange: (value: string) => void; disabled?: boolean;
}) {
  const zh = useLocale().startsWith("zh");
  const t = useTranslations("chat.agentStart");
  const topics = Object.values(t.raw("topics") as Record<string, Topic>);
  const starters = Object.values(t.raw("starters") as Record<string, Starter>);
  const id = useId().replace(/:/g, "");
  const root = useRef<HTMLDivElement>(null);
  const [topic, setTopic] = useState("suggested");
  const [last, setLast] = useState<{ before: string; after: string } | null>(null);
  const visible = topic === "suggested" ? starters.slice(0, 4) : starters.filter((item) => item.topic === topic);
  function choose(item: Starter) {
    if (disabled) return;
    const prompt = item.prompt;
    const after = value.trimEnd().endsWith(prompt) ? value : value.trim() ? `${value.trimEnd()}\n\n${prompt}` : prompt;
    if (after !== value) { setLast({ before: value, after }); onChange(after); }
    root.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }
  const canUndo = last && value === last.after;
  return <div ref={root} className="flex min-h-0 flex-1 overflow-y-auto" data-testid="agent-start">
    <div className="mx-auto my-auto w-full max-w-[800px] px-4 py-8 sm:px-6 sm:py-10">
      <div className="mb-7 text-left sm:mb-8">
        <h1 className="text-balance text-[26px] font-semibold tracking-tight leading-tight text-[color:var(--text-base)] sm:text-[30px]">{i18nCopy(zh, "copy.components_chat_AgentStart.001")}</h1>
        <p className="mt-3 max-w-[60ch] text-pretty text-sm leading-6 text-[color:var(--text-muted)]">{i18nCopy(zh, "copy.components_chat_AgentStart.002")}</p>
      </div>
      {composer}
      <div hidden={!canUndo} className="mt-2 flex min-h-7 items-center justify-between gap-2 px-1 text-xs text-[color:var(--text-muted)]" role="status">
        <span>{canUndo ? (i18nCopy(zh, "copy.components_chat_AgentStart.003")) : (i18nCopy(zh, "copy.components_chat_AgentStart.004"))}</span>
        {canUndo ? <button type="button" disabled={disabled} className="min-h-8 shrink-0 rounded px-2 underline focus-visible:ring-2 focus-visible:ring-brand-400" onClick={() => { if (last && value === last.after) { onChange(last.before); setLast(null); root.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus(); } }}>{i18nCopy(zh, "copy.components_chat_AgentStart.005")}</button> : null}
      </div>
      <div className="mt-5 [&_[role=tablist]]:border-0 [&_[role=tablist]]:px-0 [&_[role=tab]]:min-h-9 [&_[role=tab]]:rounded-full [&_[role=tab]]:border-0 [&_[role=tab]]:px-3 [&_[role=tab]]:text-xs [&_[aria-selected=true]]:bg-[color:var(--panel-bg)]">
        <WorkspaceTabs id={`start-${id}`} label={i18nCopy(zh, "copy.components_chat_AgentStart.006")} tabs={topics.map((item) => ({ id: item.id, label: item.label }))} value={topic} onChange={setTopic} />
      </div>
      {topics.map((item) => <section key={item.id} id={`start-${id}-panel-${item.id}`} role="tabpanel" aria-labelledby={`start-${id}-tab-${item.id}`} hidden={topic !== item.id} className={topic === item.id ? "mt-3" : "hidden"}>
        {topic === item.id ? <div className="grid gap-2 sm:grid-cols-2">{visible.map((question, index) => <button type="button" key={question.id} disabled={disabled} onClick={() => choose(question)} data-testid="starter-question"
          title={i18nCopy(zh, "copy.components_chat_AgentStart.007")}
          className={`group flex min-h-14 w-full items-center gap-3 rounded-xl border border-[color:var(--line)] px-4 py-3 text-left text-[13px] leading-6 text-[color:var(--text-base)] transition-colors hover:border-[color:var(--line-hi)] hover:bg-[color:var(--card)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 disabled:opacity-40 sm:text-sm ${visible.length === 3 && index === 2 ? "sm:col-span-2" : ""}`}>
          <span className="min-w-0 flex-1">{question.label}</span><ChevronRightIcon size={14} className="shrink-0 text-[color:var(--text-muted)] motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5" />
        </button>)}</div> : null}
      </section>)}
    </div>
  </div>;
}
