"use client";

import { useState } from "react";
import { useLocale } from "next-intl";
import type { useConversationCommands } from "./useConversationCommands";
import type { ConversationCommand } from "../../lib/conversationCommands";
import { commandErrorCode } from "../../lib/conversationCommands";
import { commandErrorText, commandStateText } from "../../lib/commandCopy";
import styles from "./ConversationControls.module.css";
import { readEditDraft, writeEditDraft } from "../../lib/editDrafts";
import { useUnsavedChanges } from "./useUnsavedChanges";

type Engine = ReturnType<typeof useConversationCommands>;
export function ConversationControls({ engine, onContinue, onReuse }: {
  engine: Engine; onContinue: (turnId: string) => void; onReuse: (text: string) => void;
}) {
  const zh = useLocale().startsWith("zh");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ command: ConversationCommand; text: string } | null>(null);
  useUnsavedChanges(Boolean(editing && editing.text !== editing.command.input));
  const queue = engine.commands.filter(command => command.state === "queued" && command.kind !== "guide");
  const guidance = engine.commands.filter(command => command.kind === "guide" && command.state !== "removed").slice(-4);
  const uncertain = engine.commands.filter(command => command.state === "unconfirmed");
  const checkpoint = engine.data?.checkpoint;
  const needsResume = checkpoint && !engine.active && engine.commands.some(command => command.turn_id === checkpoint.turn_id && ["failed","blocked","interrupted"].includes(command.state));
  async function action(key: string, execute: () => Promise<unknown>) {
    if (busy) return;
    setBusy(key); setError("");
    try { await execute(); } catch (reason) { setError(commandErrorText(commandErrorCode(reason), zh)); }
    finally { setBusy(""); }
  }
  const control = (name: string, command?: ConversationCommand, extra?: Record<string, unknown>) =>
    action(name+(command?.command_id || ""), () => engine.control(name, command, extra));
  if (!engine.active && !queue.length && !guidance.length && !engine.pending.length && !uncertain.length && !needsResume && engine.connection !== "offline") return null;
  return <section className={styles.root} data-testid="conversation-controls" aria-label={zh ? "运行与排队消息" : "Execution and queued messages"}>
    <div className={styles.inner}>
      {engine.connection === "offline" && <div className={styles.notice} role="status"><span>{commandErrorText("connection_lost", zh)}</span><button type="button" onClick={engine.refresh}>{zh ? "检查连接" : "Check connection"}</button></div>}
      {engine.active && <div className={styles.status} role="status" data-testid="command-execution-state" data-state={engine.active.state}>
        <span className={styles.dot} aria-hidden /><span>{commandStateText(engine.active.state, zh)}</span>
        <span className={styles.muted}>{queue.length ? (zh ? `另有 ${queue.length} 条排队` : `${queue.length} queued`) : ""}</span>
      </div>}
      {engine.pending.map(item => <div className={styles.notice} key={item.command_id} data-testid="command-delivery-unconfirmed">
        <p>{commandErrorText("delivery_unconfirmed", zh)}</p>
        <div className={styles.actions}><button type="button" disabled={!!busy} onClick={() => void action("check"+item.command_id, () => engine.recover(item))}>{zh ? "检查原请求" : "Check original request"}</button>
          <button type="button" disabled={!!busy} onClick={() => void action("resend"+item.command_id, () => engine.recover(item, true))}>{zh ? "用原标识重新提交" : "Resubmit original ID"}</button></div>
      </div>)}
      {uncertain.map(command => <div className={styles.notice} key={command.command_id} role="status">
        <span>{commandStateText(command.state, zh)}</span><button type="button" disabled={!!busy} onClick={() => void control("reconcile", command)}>{zh ? "核对执行结果" : "Reconcile execution"}</button>
      </div>)}
      {queue.length > 0 && <details data-testid="conversation-queue">
        <summary>{zh ? `排队消息 · ${queue.length}` : `Queued messages · ${queue.length}`} · {queue[0]?.input.slice(0,80)}</summary>
        <div className={styles.queueHeader}><span>{engine.data?.queue.paused ? (zh ? "队列已暂停，不会自动重放" : "Queue paused; no automatic replay") : (zh ? "本轮结束后按顺序执行" : "Runs in order after this turn")}</span>
          <button type="button" disabled={!!busy || uncertain.length > 0} onClick={() => void control(engine.data?.queue.paused ? "resume" : "pause")}>{engine.data?.queue.paused ? (zh ? "继续队列" : "Resume queue") : (zh ? "暂停队列" : "Pause queue")}</button></div>
        <ol className={styles.queue}>
          {queue.map((command, index) => <li key={command.command_id} data-command-id={command.command_id}>
            {editing?.command.command_id === command.command_id ? <form onSubmit={event => { event.preventDefault(); void action("save", async () => {
              await engine.control("edit", editing.command, { text: editing.text }); writeEditDraft('queue:'+editing.command.command_id,null); setEditing(null);
            }); }}>
              <label className={styles.srOnly} htmlFor={command.command_id+"-edit"}>{zh ? "编辑排队消息" : "Edit queued message"}</label>
              <textarea id={command.command_id+"-edit"} autoFocus value={editing.text} maxLength={16000} disabled={!!busy}
                onChange={event => { setEditing({ ...editing, text:event.target.value }); writeEditDraft('queue:'+command.command_id,{ text:event.target.value, revision:editing.command.revision }); }}
                onKeyDown={event => { if (event.key === "Escape" && !event.nativeEvent.isComposing && !busy) setEditing(null); }} />
              <div className={styles.actions}><button type="button" disabled={!!busy} onClick={() => setEditing(null)}>{zh ? "取消" : "Cancel"}</button><button type="submit" disabled={!!busy || !editing.text.trim()}>{zh ? "保存消息" : "Save message"}</button></div>
            </form> : <><span className={styles.preview}>{command.input || (zh ? "附件任务" : "Attachment task")}</span>
              {command.attachments.length > 0 && <small>{zh ? `${command.attachments.length} 个附件` : `${command.attachments.length} attachments`}</small>}
              <div className={styles.actions}>
                <button type="button" disabled={!!busy} onClick={() => { const saved=readEditDraft<{ text:string; revision:number }>('queue:'+command.command_id); setEditing({ command,text:saved?.revision === command.revision ? saved.text : command.input }); }}>{zh ? "编辑" : "Edit"}</button>
                <button type="button" disabled={!!busy || index === 0} onClick={() => void control("move", command, { before_command_id: queue[index-1]?.command_id })} aria-label={zh ? "上移消息" : "Move message up"}>↑</button>
                <button type="button" disabled={!!busy || index === queue.length-1} onClick={() => void control("move", command, { before_command_id: queue[index+2]?.command_id || null })} aria-label={zh ? "下移消息" : "Move message down"}>↓</button>
                <button type="button" disabled={!!busy} onClick={() => void control("remove", command)}>{zh ? "移除" : "Remove"}</button>
              </div></>}
          </li>)}
        </ol>
      </details>}
      {guidance.map(command => <div key={command.command_id} className={styles.guidance} data-testid="guidance-receipt" data-state={command.state}>
        <span className={styles.preview}>{command.input}</span><span>{commandStateText(command.state, zh)}</span>
        {command.state === "not_consumed" && <button type="button" onClick={() => onReuse(command.input)}>{zh ? "放回输入框" : "Return to input"}</button>}
      </div>)}
      {needsResume && <div className={styles.resume}><span>{zh ? "已保留可继续的执行断点。继续不会重新开始原任务。" : "A resumable checkpoint is available. Continuing does not restart the original task."}</span>
        <button type="button" disabled={!!busy || engine.connection !== "online"} onClick={() => onContinue(checkpoint.turn_id)}>{zh ? "从断点继续" : "Continue checkpoint"}</button></div>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </div>
  </section>;
}
