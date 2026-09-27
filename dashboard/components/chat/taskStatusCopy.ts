import { statusLabel, type TaskStatus } from '../../lib/workbench';

/** Compact visible copy; keep waiting states ahead of a previous completion. */
export function shortTaskStatus(status: TaskStatus, zh: boolean): string {
  if (status.waiting_for === 'user') return zh ? '等待回答' : 'Awaiting reply';
  if (status.waiting_for === 'approval') return zh ? '等待审批' : 'Awaiting approval';
  if (status.waiting_for === 'configuration') return zh ? '等待配置' : 'Setup needed';
  if (status.completion === 'external_reported') return zh ? '已报告完成' : 'Reported complete';
  if (status.execution === 'unconfirmed') return zh ? '结果待确认' : 'Unconfirmed';
  return statusLabel(status, zh);
}
