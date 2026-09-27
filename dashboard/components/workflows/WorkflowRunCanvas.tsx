"use client";
import { Icon as NeryaGlyph } from "../icons";
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ChoiceSelect } from "../ChoiceSelect";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { ReplayEvidence } from "./ReplayEvidence";
import { asObject } from "../../lib/workflowPresentation";
import { invocationGraph, type ReplayInvocation, type ReplayMessage } from "../../lib/workflowReplay";
import styles from "./WorkflowReplay.module.css";

export function WorkflowRunCanvas({ invocation, prompt, reply, messages = [], partial = false }: { invocation: ReplayInvocation; prompt?: unknown; reply?: unknown; messages?: ReplayMessage[]; partial?: boolean }) {
  const t = useTranslations("workflowExperience");
  const [selected, setSelected] = useState("invocation");
  const [page, setPage] = useState(0);
  const pageSize = 12;
  const count = Math.max(1, Math.ceil(invocation.calls.length / pageSize));
  const currentPage = Math.min(page, count - 1);
  const graph = useMemo(() => invocationGraph({ ...invocation, calls: invocation.calls.slice(currentPage * pageSize, (currentPage + 1) * pageSize) }, { input: t("inputs"), output: t("outputs"), call: t("call") }), [invocation, currentPage, t]);
  const active = graph.nodes.find((node) => node.id === selected) || graph.nodes[0];
  const facts = asObject(active.config);
  function select(id: string) {
    const index = invocation.calls.findIndex((call) => `call:${call.id}` === id);
    if (index >= 0) setPage(Math.floor(index / pageSize));
    setSelected(id);
  }
  return <section className={styles.replay} data-testid="workflow-invocation-canvas" data-invocation-id={invocation.id}>
    <header className={styles.replayHeader}><div><span className={styles.eyebrow}>{t("readOnly")}</span><h3>{t("callCanvas")}</h3></div><small className={styles.note}>{invocation.id}</small></header>
    <p className={styles.note}>{t("recordedCalls")}{partial ? ` ${t("partialHistory")}` : ""}</p>
    <div className={styles.replayHeader}>
      <ChoiceSelect aria-label={t("call")} value={active.id} onValueChange={select}>
        <option value="invocation">{t("selectedInvocation")}</option>
        {invocation.calls.map((call) => <option key={call.id} value={`call:${call.id}`}>{call.name} · {call.status}</option>)}
      </ChoiceSelect>
      {count > 1 && <div className="flex gap-3"><button type="button" disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); setSelected("invocation"); }} aria-label={t("selectInvocation")}><NeryaGlyph name="arrowLeft" size={18} /></button><span>{currentPage + 1} / {count}</span><button type="button" disabled={currentPage + 1 === count} onClick={() => { setPage(currentPage + 1); setSelected("invocation"); }} aria-label={t("loadMore")}><NeryaGlyph name="arrowRight" size={18} /></button></div>}
    </div>
    <div className={styles.workspace}>
      <div className={styles.canvas}><WorkflowCanvas graph={graph} selectedId={active.id} onSelect={(node) => select(node.id)} /></div>
      <aside className={styles.inspector} data-testid="workflow-invocation-io" aria-label={t("selectedInvocation")}>
        <header><h4>{active.title}</h4><p className={styles.note}>{active.status}</p></header>
        <section><strong className={styles.ioLabel}>{t("inputs")}</strong><ReplayEvidence value={facts.input} /></section>
        <section><strong className={styles.ioLabel}>{t("outputs")}</strong><ReplayEvidence value={facts.output} /></section>
      </aside>
    </div>
    {(messages.length > 0 || prompt !== undefined || reply !== undefined) && <section className={styles.transcript} data-testid="workflow-invocation-conversation"><h3>{t("conversation")}</h3>
      {prompt !== undefined && !messages.some((message) => message.role === "user") && <article className={styles.message}><span className={styles.eyebrow}>{t("prompt")}</span><ReplayEvidence value={prompt} /></article>}
      {messages.map((message) => <article key={message.id} className={styles.message} data-message-role={message.role}>
        {message.callId ? <button type="button" className="underline underline-offset-4" onClick={() => select(`call:${message.callId}`)}>{t("call")} · {message.label}</button> : <span className={styles.eyebrow}>{t(message.role === "user" ? "prompt" : "response")}</span>}
        <ReplayEvidence value={message.content} />
      </article>)}
      {reply !== undefined && !messages.some((message) => message.role === "assistant") && <article className={styles.message}><span className={styles.eyebrow}>{t("response")}</span><ReplayEvidence value={reply} /></article>}
    </section>}
  </section>;
}
