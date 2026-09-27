/** Connection-only presentation helpers. Never cache or persist credential values. */
export const CONNECTION_ERRORS = new Set([
  "auth_error", "missing_fields", "network_error", "rate_limited", "wallet_not_ready",
  "vault_unavailable", "connector_unavailable", "unsupported_provider", "account_changed",
  "account_exists", "unknown_account", "invalid_balance", "invalid_account_id",
  "connection_busy", "invalid_account", "provider_change_requires_new_account", "connection_failed",
]);

export function connectionErrorCode(value: unknown): string {
  const obj = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const payload = obj.payload && typeof obj.payload === "object" ? obj.payload as Record<string, unknown> : obj;
  const code = String(payload.error || "");
  if (CONNECTION_ERRORS.has(code)) return code;
  if (obj.status === 401 || obj.status === 403) return "session_expired";
  if (obj.status === 404) return "service_update_required";
  return "network_error";
}

export function connectionId(venue: string, nonce: string): string {
  const prefix = venue.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40) || "account";
  return `${prefix}_${nonce.replace(/-/g, "").slice(0, 10)}`;
}

export function providerLabel(value: string): string {
  return value.replace(/\s*\(ccxt\)/gi, "").replace(/\s*v5$/i, "").trim();
}

export function safeProviderUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
