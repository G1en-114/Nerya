import type { ChatMessage } from './chat';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const identity = (value: unknown) => String(record(value).approval_id || record(value).id || '');

/** Patch both live-event and restored-block representations of one decision. */
export function resolveMessageApproval(message: ChatMessage, approvalId: string, state: string): ChatMessage {
  if (message.role !== 'assistant' || !['approved','rejected','expired','cancelled'].includes(state)) return message;
  const events = message.live_events || [];
  const blocks = message.turn?.blocks || [];
  const matches = events.some(event => identity(event) === approvalId && String(event.kind).startsWith('approval.'))
    || blocks.some(env => {const block=record(record(env).block || env);return block.kind==='approval_request' && identity(block)===approvalId;});
  if (!matches) return message;
  const eventResolved=events.some(event=>event.kind==='approval.resolved' && identity(event)===approvalId && event.state===state);
  let changed=false;
  const updated=blocks.map(env=>{
    const block=record(record(env).block || env);
    if(block.kind!=='approval_request' || identity(block)!==approvalId || block.state===state && block.resolved_state===state)return env;
    changed=true;
    return {...env,block:{...block,state,resolved_state:state}};
  });
  if(eventResolved && !changed)return message;
  return {...message, ...(message.turn ? {turn:{...message.turn,blocks:updated}} : {}),
    live_events:eventResolved ? events : [...events,{kind:'approval.resolved',seq:Date.now(),ts:Date.now()/1000,approval_id:approvalId,state}]};
}
