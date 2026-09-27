import { commandErrorText } from "./commandCopy";

/** Keep debugging useful without copying credentials into visible diagnostics. */
export function redactDiagnosticText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passphrase|secret)["']?\s*[:=]\s*)(["'])(.*?)\2/gi, "$1$2[redacted]$2")
    .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passphrase|secret)\s*[:=]\s*)[^\s,;"'}]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .slice(0, 20000);
}
export function conversationError(raw: string, zh: boolean) {
  let code = "", status: number | undefined;
  try {
    const data: unknown = JSON.parse(raw);
    if (data && typeof data === "object") {
      const error = data as { code?: unknown; status_code?: unknown };
      if (typeof error.code === "string") code = error.code;
      if (typeof error.status_code === "number") status = error.status_code;
    }
  } catch { /* Older transcripts contain transport error strings. */ }
  if(code==="turn_failed" && (status===401||status===403))code="model_auth_failed";
  if(code==="turn_failed" && status===429)code="rate_limited";
  if (!code) {
    if (/429|rpm\s+exhausted|rate[_ -]?limit/i.test(raw)) { code = "rate_limited"; status = 429; }
    else if (/unauthorized|HTTP\s+(401|403)/i.test(raw)) code = "service_auth_failed";
    else if (/api\s+error\s*\((401|403)\)|invalid[_ -]api[_ -]key/i.test(raw)) code = "model_auth_failed";
    else if (/upstream_unreachable|ECONNREFUSED/i.test(raw)) code = "backend_unreachable";
    else if (/context.*(exceed|large)|maximum.*context|context_length/i.test(raw)) code = "context_limit";
    else if (/timeout|ETIMEDOUT|504/i.test(raw)) code = "request_timeout";
    else code = "turn_failed";
  }
  const messages: Record<string,[string,string]> = {
    service_auth_failed:["本地服务鉴权未通过。本轮没有成功完成，请检查服务与界面使用的登录配置。","Service authentication failed. Check that the dashboard and backend use the same access configuration."],
    model_auth_failed:["模型提供方拒绝了认证。请检查模型配置中的密钥；本轮不会继续自动重试。","The model provider rejected authentication. Check its credentials; automatic retries have ended."],
    backend_unreachable:["界面暂时无法连接本地服务。已发送的任务可能仍在执行，请先检查服务状态。","The dashboard cannot reach the local service. Accepted work may still be running; check its status first."],
    context_limit:["请求超过模型实际接受的上下文限制。已完成步骤保留，请检查模型窗口配置或减少引用后重新运行。","The request exceeded the model's accepted context limit. Completed work is retained; review its window configuration or references."],
    strategy_version_changed:["策略在排队期间已变化。请检查新版后再提交。","The strategy changed while queued. Review the new version before submitting again."],
    request_timeout:["请求等待超时。超时不表示后台执行已撤销，请先核对本轮状态。","The request timed out. This does not undo background execution; reconcile its status first."],
  };
  return { code, status, message: messages[code]?.[zh ? 0 : 1] || commandErrorText(code,zh),
    needsSettings: ["service_auth_failed","model_auth_failed","context_limit"].includes(code),
    canRerun: !["execution_unconfirmed","backend_unreachable","request_timeout","event_persistence_failed","delivery_unconfirmed"].includes(code),
    diagnostics: redactDiagnosticText(raw) };
}
