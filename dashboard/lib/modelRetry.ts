import type { NativeBlockEnvelope } from './chat';

export type ModelRetry = {
  state: 'waiting' | 'requesting';
  status_code: number;
  attempt: number;
  max_attempts: number;
  retry_at: number;
};

/** Operational metadata only. Never render arbitrary model thinking. */
export function latestModelRetry(blocks: NativeBlockEnvelope[]): ModelRetry | null {
  let latest: ModelRetry | null = null;
  for (const envelope of blocks) {
    const block = envelope.block || envelope;
    const retry = block.retry as Record<string, unknown> | undefined;
    if (!retry || typeof retry !== 'object') continue;
    if (retry.state === 'recovered') { latest = null; continue; }
    if (retry.state !== 'waiting' && retry.state !== 'requesting') continue;
    if (![retry.status_code, retry.attempt, retry.max_attempts, retry.retry_at].every(v => typeof v === 'number' && Number.isFinite(v))) continue;
    latest = retry as ModelRetry;
  }
  return latest;
}

/** Also handles saved messages from the old HTTP 500 / LLMError wrapper. */
export function rateLimitError(raw: string, zh: boolean) {
  const summary = raw.split(/\|\s*trace:/i)[0];
  if (!/\bHTTP\s+429\b|\bapi error\s*\(429\)/i.test(summary)) return null;
  const quota = /quota_exhausted|insufficient_quota|credit_balance_exhausted/i.test(summary);
  return {
    kind: 'HTTP 429',
    message: quota
      ? (zh ? '模型服务额度不足。' : 'Provider quota exhausted.')
      : (zh ? '模型服务请求过于频繁。' : 'The model provider is rate-limiting requests.'),
    hint: quota
      ? (zh ? '请检查模型账户的额度或计费设置。' : 'Check the model account quota or billing settings.')
      : (zh ? '本轮自动重试已结束，请稍后重试。' : 'Automatic retries for this turn have ended. Please retry later.'),
    showRawByDefault: false,
  };
}
