"use client";

import { useState } from "react";
import { useLocale } from "next-intl";
import type { Reconciliation, useConversationCommands } from "./useConversationCommands";
import { callApi } from "../../lib/clientApi";
import type { ConversationCommand } from "../../lib/conversationCommands";
import { commandErrorCode } from "../../lib/conversationCommands";
import { commandErrorText, commandStateText } from "../../lib/commandCopy";
import styles from "./ConversationControls.module.css";
import { QueueEnvelopeEditor } from "./QueueEnvelopeEditor";
import { useWorkspaceIdentity, workspaceGeneration } from "../../lib/workspaceIdentity";

type Engine = ReturnType<typeof useConversationCommands>;
export function ConversationControls({ engine, onContinue, onReuse }: {
  engine: Engine; onContinue: (turnId: string) => void; onReuse: (text: string) => void;
}) {
  const zh = useLocale().startsWith("zh");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [diagnostics, setDiagnostics] = useState<Record<string, Reconciliation>>({});
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const workspace = useWorkspaceIdentity(), generation = workspaceGeneration();
  const [editState, setEditing] = useState<{ command: ConversationCommand; workspace: string | null; generation: number } | null>(null);
  const editing = editState?.workspace === workspace && editState?.generation === generation ? editState : null;
  const queue = engine.commands.filter(command => command.state === "queued" && command.kind !== "guide");
  const [dismissedGuidance,setDismissedGuidance]=useState<string[]>([]);
  const guidance = engine.commands.filter(command => command.kind === "guide" && !dismissedGuidance.includes(command.command_id) &&
    ((["queued","delivering","delivered"].includes(command.state)&&command.turn_id===engine.active?.turn_id)||command.state==="not_consumed")).slice(-4);
  const uncertain = engine.commands.filter(command => command.state === "unconfirmed");
  const checkpoint = engine.data?.checkpoint;
  const latestExecution=engine.commands.filter(command=>command.kind!=="guide"&&!["queued","removed"].includes(command.state)).sort((a,b)=>b.created_at-a.created_at)[0];
  const queueBlocked=uncertain.length>0 || ["awaiting_approval","awaiting_input"].includes(latestExecution?.state||engine.data?.queue.pause_reason||"");
  const latestCheckpointCommand=engine.commands.filter(command=>command.kind!=="guide"&&command.turn_id===checkpoint?.turn_id).sort((a,b)=>b.created_at-a.created_at)[0];
  const needsResume=checkpoint&&!engine.active&&latestCheckpointCommand&&["blocked","interrupted"].includes(latestCheckpointCommand.state)&&!latestCheckpointCommand.error;
  async function action(key: string, execute: () => Promise<unknown>) {
    if (busy) return;
    setBusy(key); setError("");
    try { await execute(); } catch (reason) { setError(commandErrorText(commandErrorCode(reason), zh)); }
    finally { setBusy(""); }
  }
  const control = (name: string, command?: ConversationCommand, extra?: Record<string, unknown>) =>
    action(name+(command?.command_id || ""), async () => {
      const response = await engine.control(name, command, extra);
      if (command && response.reconciliation) setDiagnostics(previous => ({ ...previous, [command.command_id]: response.reconciliation! }));
    });
  if (!editing && !queue.length && !guidance.length && !engine.pending.length && !uncertain.length && !needsResume && engine.connection !== "offline") return null;
  return <section className={styles.root} data-testid="conversation-controls" aria-label={zh ? "运行与排队消息" : "Execution and queued messages"}>
    <div className={styles.inner}>
      {engine.connection === "offline" && <div className={styles.notice} role="status"><span>{commandErrorText("connection_lost", zh)}</span><button type="button" onClick={engine.refresh}>{zh ? "检查连接" : "Check connection"}</button></div>}
      {engine.pending.map(item => <div className={styles.notice} key={item.command_id} data-testid="command-delivery-unconfirmed">
        <p>{commandErrorText("delivery_unconfirmed", zh)}</p>
        <div className={styles.actions}><button type="button" disabled={!!busy} onClick={() => void action("check"+item.command_id, () => engine.recover(item))}>{zh ? "检查原请求" : "Check original request"}</button>
          <button type="button" disabled={!!busy} onClick={() => void action("resend"+item.command_id, () => engine.recover(item, true))}>{zh ? "重新发送" : "Resend message"}</button></div>
      </div>)}
      {uncertain.map(command => <div className={styles.notice} key={command.command_id} role="status">
        <span>{zh?"队列已暂停":"Queue paused"}</span><button type="button" disabled={!!busy} onClick={() => void control("reconcile", command)}>{zh ? "核对执行结果" : "Reconcile execution"}</button>
        {diagnostics[command.command_id]&&<div>
          <p>{diagnostics[command.command_id].status==="lookup_failed"?(zh?"证据查询失败。执行状态仍未确认，可重试查询。":"Evidence lookup failed. Execution remains unconfirmed; retry the lookup."):diagnostics[command.command_id].status==="insufficient_evidence"?(zh?"没有找到与原请求精确匹配的终态证据。请检查工具、订单或交易回执，暂勿重放操作。":"No terminal evidence matches this exact request. Check tool, order, or transaction receipts before repeating any action."):(zh?"已匹配原请求的执行证据。":"Execution evidence matches the original request.")}</p>
          <details><summary>{zh?"请求标识与证据":"Request identity and evidence"}</summary>
            <p>{command.command_id} · {command.turn_id}</p>
            <button type="button" disabled={!!busy} onClick={()=>void action("evidence"+command.command_id,async()=>{
              const result=await callApi(diagnostics[command.command_id].evidence_path);
              setEvidence(previous=>({...previous,[command.command_id]:JSON.stringify(result,null,2)}));
            })}>{zh?"查看已保存事件":"View saved events"}</button>
            {evidence[command.command_id]&&<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{evidence[command.command_id]}</pre>}
          </details>
        </div>}
      </div>)}
      {queue.length > 0 && <details data-testid="conversation-queue">
        <summary>{zh ? `排队消息 · ${queue.length}` : `Queued messages · ${queue.length}`}{engine.data?.queue.paused ? (zh ? " · 已暂停" : " · Paused") : ""} · {queue[0]?.input.slice(0,80)}</summary>
        <div className={styles.queueHeader}><span>{engine.data?.queue.paused ? (zh ? "队列已暂停" : "Queue paused") : (zh ? "本轮结束后按顺序执行" : "Runs after this turn")}</span>
          <button type="button" disabled={!!busy || queueBlocked} onClick={() => void control(engine.data?.queue.paused ? "resume" : "pause")}>{engine.data?.queue.paused ? (zh ? "继续排队消息" : "Resume queue") : (zh ? "暂停队列" : "Pause queue")}</button></div>
        <ol className={styles.queue}>
          {queue.map((command, index) => <li key={command.command_id} data-command-id={command.command_id}>
            <span className={styles.preview}>{command.input || (zh ? "附件任务" : "Attachment task")}</span>
              {command.attachments.length > 0 && <small>{zh ? `${command.attachments.length} 个附件` : `${command.attachments.length} attachments`}</small>}
              <div className={styles.actions}>
                <button type="button" disabled={!!busy || command.queue_editable === false} onClick={() => setEditing({ command, workspace, generation })} title={command.queue_editable === false ? (zh ? "审批与计划回复由原决策管理" : "Approval and plan responses are managed by their decision") : undefined}>{zh ? "编辑" : "Edit"}</button>
                <button type="button" disabled={!!busy || index === 0} onClick={() => void control("move", command, { before_command_id: queue[index-1]?.command_id })} aria-label={zh ? "上移消息" : "Move message up"}>↑</button>
                <button type="button" disabled={!!busy || index === queue.length-1} onClick={() => void control("move", command, { before_command_id: queue[index+2]?.command_id || null })} aria-label={zh ? "下移消息" : "Move message down"}>↓</button>
                <button type="button" disabled={!!busy} onClick={() => void control("remove", command)}>{zh ? "移除" : "Remove"}</button>
              </div>
          </li>)}
        </ol>
      </details>}
      {editing && <QueueEnvelopeEditor key={workspace+":"+generation+":"+editing.command.command_id} command={editing.command}
        current={engine.commands.find(command => command.command_id === editing.command.command_id)}
        onSave={(command, request) => engine.control("edit", command, { request })} onClose={() => setEditing(null)} />}
      {guidance.map(command => <div key={command.command_id} className={styles.guidance} data-testid="guidance-receipt" data-state={command.state}>
        <span className={styles.preview}>{command.input}</span><span>{commandStateText(command.state, zh)}</span>
        {command.state === "not_consumed" && <button type="button" onClick={() => onReuse(command.input)}>{zh ? "放回输入框" : "Return to input"}</button>}
        {command.state === "not_consumed"&&<button type="button" aria-label={zh?"收起未采用的指导":"Dismiss unused guidance"} onClick={()=>setDismissedGuidance(ids=>[...ids,command.command_id])}>×</button>}
      </div>)}
      {needsResume && <div className={styles.resume}><span>{zh ? "本轮已暂停" : "This turn is paused"}</span>
        <button type="button" disabled={!!busy || engine.connection !== "online"} title={zh?"继续本轮，其他排队消息保持暂停。":"Continue this turn; other queued messages remain paused."} onClick={() => onContinue(checkpoint.turn_id)}>{zh ? "从断点继续" : "Continue checkpoint"}</button></div>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </div>
  </section>;
}
