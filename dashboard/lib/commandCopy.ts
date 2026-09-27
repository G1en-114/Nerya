import type { CommandState } from "./conversationCommands";

const states: Record<CommandState, [string,string]> = {
  queued:["已接收，等待执行","Received, queued"], running:["正在执行","Running"],
  stopping:["正在停止，等待当前操作结束","Stopping; waiting for the current operation"],
  delivering:["正在投递补充指令","Delivering guidance"], delivered:["已送达，等待本轮读取","Delivered; waiting for this turn"],
  injected:["已加入本轮上下文","Added to this turn's context"], succeeded:["执行已结束","Execution finished"],
  failed:["本轮未完成","Turn failed"], blocked:["本轮已暂停，需要处理","Turn paused; action required"],
  awaiting_input:["等待你的回答","Waiting for your answer"],
  awaiting_approval:["等待审批","Awaiting approval"], interrupted:["已停止，已完成操作不会撤销","Stopped; completed actions remain"],
  unconfirmed:["执行结果待确认，不会自动重跑","Execution unconfirmed; no automatic replay"],
  not_consumed:["本轮结束前未读取这条指令","This turn ended before reading this guidance"], removed:["已从队列移除","Removed from queue"],
};
export function commandStateText(state: string, zh: boolean) { return states[state as CommandState]?.[zh ? 0 : 1] || (zh ? "状态待确认" : "Status unconfirmed"); }
const errors: Record<string,[string,string]> = {
  delivery_unconfirmed:["发送尚未确认，原请求和草稿已保留。请先检查状态，不要重新发起同一任务。","Delivery is unconfirmed. The original request and draft are retained. Check its status before starting another task."],
  command_not_found:["暂未查到接收记录。可以使用原请求标识重新提交，不会创建重复命令。","No receipt was found. Resubmit with the original request ID to avoid duplicate admission."],
  connection_lost:["暂时无法连接，后台任务不一定已停止。恢复连接后会继续核对。","Connection unavailable. Background work may still be running; status will be reconciled after reconnecting."],
  execution_unconfirmed:["执行结果尚未确认。已暂停队列，不会自动重复已发生的操作。","Execution remains unconfirmed. The queue is paused; completed actions will not be replayed automatically."],
  decision_pending:["请先处理当前问题或审批，再继续队列。","Resolve the current question or approval before resuming the queue."],
  queue_pause_required:["请先暂停队列，再单独重新运行这条任务。","Pause the queue before rerunning this task alone."],
  interaction_response_required:["当前任务正在等待回答，请在问题卡片中继续。","This task is waiting for your response. Continue from its question card."],
  command_revision_conflict:["状态已在其他窗口或执行端更新。已重新读取，请基于最新状态操作。","State changed in another window or in the runtime. Review the refreshed state before acting."],
  command_already_claimed:["这条消息已开始执行，不能再修改队列内容。","This message has started executing and can no longer be edited in the queue."],
  no_running_turn:["当前轮次已经结束或尚未开始。草稿已保留，可排队为下一轮。","This turn ended or has not started. The draft is retained; queue it as the next turn."],
  guide_text_only:["指导本轮只接受文字；带附件的补充请排队为下一轮。","Guidance accepts text only. Queue attachments for the next turn."],
  strategy_version_changed:["策略版本在排队期间发生变化。任务未继续执行，请检查最新差异后重新提交。","The strategy changed while this task was queued. Execution was blocked; review the latest differences before resubmitting."],
  strategy_binding_conflict:["本会话绑定的策略与请求不一致，请回到对应策略会话。","The request does not match this conversation's strategy binding."],
  external_session_read_only:["外部会话由外部客户端执行，请使用追加消息入口。","This session is executed by an external client. Use its append-message input."],
  rate_limited:["模型服务限流，自动重试已结束。已完成的工作保留在本轮。","The model is rate-limited and automatic retries have ended. Completed work is retained."],
  event_persistence_failed:["执行记录暂时无法保存，本轮已请求停止。请先检查状态。","Execution records could not be saved. A stop was requested; check the current status."],
  pending_limit:["还有待确认的发送，请先核对这些请求。","Resolve the pending deliveries before submitting more requests."],
  queue_full:["队列已满，请先移除或完成部分排队任务。","The queue is full. Remove or finish queued tasks first."],
  command_storage_unavailable:["暂时无法确认接收记录，原请求已保留。","The admission record cannot be confirmed right now. The original request is retained."],
  turn_failed:["本轮未完成，已完成的步骤仍可查看。自动重试已结束。","This turn did not finish. Completed steps remain available; automatic retries have ended."],
};
export function commandErrorText(code: string, zh: boolean) {
  return errors[code]?.[zh ? 0 : 1] || (zh ? "操作未完成，内容已保留。请检查状态或展开诊断详情。" : "The action did not finish. Content is retained; check the status or diagnostic details.");
}
