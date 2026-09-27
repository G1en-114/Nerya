export const AUTH_TOKEN_KEY = "nerya.admin_jwt.v1";
export const AUTH_EXPIRES_KEY = "nerya.admin_jwt_expires_at.v1";
export const AUTH_EVENT = "nerya:auth_changed";

function browser(): boolean {
  return typeof window !== "undefined";
}

function normaliseHost(host: string): string {
  const raw = (host || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("[") && raw.includes("]")) return raw.slice(1, raw.indexOf("]"));
  if (raw === "::1") return raw;
  if (raw.indexOf(":") === raw.lastIndexOf(":")) return raw.split(":")[0];
  return raw.split(":")[0];
}

export function isLocalDashboardHost(hostname?: string): boolean {
  const host = normaliseHost(hostname ?? (browser() ? window.location.hostname : ""));
  return !host || host === "localhost" || host === "::1" || host === "0.0.0.0" || host.startsWith("127.");
}

export function getStoredAuthToken(): string {
  if (!browser()) return "";
  try {
    const expires = Number(window.localStorage.getItem(AUTH_EXPIRES_KEY));
    if (expires > 0 && expires <= Date.now() / 1000) return "";
    return window.localStorage.getItem(AUTH_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

/** Suppress same-tab notification only when a caller is completing a save transaction.
 * Requests still send the new token; navigation mounts and validates AuthGate again.
 */
export function setStoredAuthToken(token: string, expiresAt?: number, options?: { notify?: boolean }): void {
  if (!browser()) return;
  try {
    window.localStorage.setItem(AUTH_TOKEN_KEY, token);
    if (expiresAt) window.localStorage.setItem(AUTH_EXPIRES_KEY, String(expiresAt));
    else window.localStorage.removeItem(AUTH_EXPIRES_KEY);
    if (options?.notify !== false) window.dispatchEvent(new Event(AUTH_EVENT));
  } catch {
    // ignore storage failures; requests will simply remain unauthenticated.
  }
}

export function clearStoredAuthToken(): void {
  if (!browser()) return;
  try {
    window.localStorage.removeItem(AUTH_TOKEN_KEY);
    window.localStorage.removeItem(AUTH_EXPIRES_KEY);
    window.dispatchEvent(new Event(AUTH_EVENT));
  } catch {
    // ignore
  }
}

export function authHeaders(base?: HeadersInit): Headers {
  const headers = new Headers(base);
  const token = getStoredAuthToken();
  if (token && !headers.has("authorization") && !headers.has("x-nerya-token")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

export function safeLoginNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\\\x00-\x1f\x7f]/.test(value)) return "/dashboard";
  const parsed = new URL(value, "http://nerya.invalid");
  if (parsed.origin !== "http://nerya.invalid") return "/dashboard";
  const path = parsed.pathname;
  return path === "/login" || path.startsWith("/login/") ? "/dashboard" : `${path}${parsed.search}${parsed.hash}`;
}

let loginRedirectPending = false;
export function redirectToLogin(): void {
  if (!browser() || window.location.pathname === "/login" || loginRedirectPending) return;
  loginRedirectPending = true;
  const path = `${window.location.pathname}${window.location.search || ""}${window.location.hash || ""}`;
  window.location.replace(`/login?next=${encodeURIComponent(path)}`);
}

export function handleAuthFailure(status: number, responseBody = ""): void {
  // A denied operation is not necessarily an expired session. Keep valid
  // credentials on permission errors, but recover rejected tokens everywhere.
  let reason = "";
  try { reason = JSON.parse(responseBody)?.reason || ""; } catch { /* non-JSON error */ }
  const rejectedToken = ["invalid_token", "expired_token", "missing_token", "not_jwt", "jwt_not_configured", "remote_without_token", "remote_dashboard_missing_token"].includes(reason);
  if (status !== 401 && !(status === 403 && rejectedToken)) return;
  clearStoredAuthToken();
  redirectToLogin();
}
