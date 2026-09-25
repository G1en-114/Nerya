"use client";

export type DesktopState = {
  desktop_version?: string;
  phase: "starting" | "ready" | "failed";
  local_url?: string;
  access_url?: string;
  workspace?: string;
  sharing: boolean;
  shared_addresses?: string[];
  port?: number;
  external_url?: string;
  notifications: boolean;
  notification_permission?: "granted" | "quiet" | "denied" | "prompt" | "unknown";
  notification_error?: string | null;
  language?: "zh" | "en";
  error?: string;
};
export type DesktopOptions = Partial<Pick<DesktopState, "sharing" | "port" | "external_url" | "notifications" | "language">>;
type Command = "desktop_status" | "desktop_configure" | "desktop_test_notification" | "desktop_start_dragging" | "desktop_quit" | "desktop_notification_settings";
type Bridge = { core: { invoke<T>(command: Command, args?: Record<string, unknown>): Promise<T> } };
function bridge(): Bridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { __TAURI__?: Bridge }).__TAURI__;
}
export function isDesktop(): boolean { return typeof bridge()?.core?.invoke === "function"; }
export function desktopStatus(): Promise<DesktopState> {
  return bridge()?.core.invoke<DesktopState>("desktop_status") ?? Promise.reject(new Error("desktop_only"));
}
export function configureDesktop(options: DesktopOptions): Promise<DesktopState> {
  return bridge()?.core.invoke<DesktopState>("desktop_configure", { options }) ?? Promise.reject(new Error("desktop_only"));
}
export function testDesktopNotification(): Promise<{ delivery: "delivered" | "submitted" }> {
  return bridge()?.core.invoke<{ delivery: "delivered" | "submitted" }>("desktop_test_notification") ?? Promise.reject(new Error("desktop_only"));
}
export function openNotificationSettings(): Promise<void> {
  return bridge()?.core.invoke<void>("desktop_notification_settings") ?? Promise.reject(new Error("desktop_only"));
}
export function startDesktopDragging(): Promise<void> {
  return bridge()?.core.invoke<void>("desktop_start_dragging") ?? Promise.reject(new Error("desktop_only"));
}
