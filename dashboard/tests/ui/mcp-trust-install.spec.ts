import { test, expect, type Page } from "@playwright/test";
import { mergeTunnelRuntime, type McpStatus } from "../../lib/mcpSettings";

function initial(): McpStatus {
  return { ok: true, revision: "fixture-1", enabled: true, auth_mode: "oauth2",
    trust_mode: "workspace", sdk_installed: true, admin_password_configured: true,
    public_url: "https://fixture.example", endpoint: "https://fixture.example/mcp",
    oauth_issuer: "https://fixture.example/mcp/oauth", detected_public_urls: [],
    openai_tunnel: { installed: false, installing: false, install_supported: true, install_error: "",
      enabled: true, tunnel_id: "", api_key_configured: false, running: false, ready: false, error: "",
      install_command: "brew install openai/tools/tunnel-client", api_tool: { type: "mcp", server_label: "nerya" } } };
}

async function mock(page: Page, options: { failFirst?: boolean; supported?: boolean; locale?: string } = {}) {
  const current = initial();
  current.openai_tunnel.install_supported = options.supported !== false;
  const writes: { path: string; body: Record<string, any> }[] = [];
  const errors: string[] = [];
  let installs = 0;
  let polls = 0;
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(locale => {
    localStorage.setItem("nerya.ui_settings.v1", JSON.stringify({ language: locale, darkMode: "dark", refreshSeconds: 0 }));
  }, options.locale || "en");
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api\/proxy/, "");
    const post = route.request().method() === "POST";
    const body = post ? route.request().postDataJSON() || {} : {};
    if (post) writes.push({ path, body });
    let value: unknown = { ok: true, data: {}, items: [], events: [], accounts: [], sessions: [], approvals: [], installed: [], entries: [], total: 0, has_more: false };
    if (path === "/mcp-settings/tunnel/install") {
      installs++; polls = 0;
      Object.assign(current.openai_tunnel, { installing: true, install_error: "" });
      value = { ok: true, installed: false, installing: true, install_supported: true, install_error: "" };
    } else if (path === "/mcp-settings") {
      if (post) {
        Object.assign(current, { enabled: body.enabled, public_url: body.public_url, revision: "fixture-2" });
        Object.assign(current.openai_tunnel, { enabled: body.openai_tunnel.enabled, tunnel_id: body.openai_tunnel.tunnel_id,
          api_key_configured: Boolean(body.openai_tunnel.api_key) });
      } else if (current.openai_tunnel.installing && ++polls >= 1) {
        const failed = options.failFirst && installs === 1;
        Object.assign(current.openai_tunnel, { installing: false, installed: !failed, install_error: failed ? "installFailed" : "" });
      }
      value = current;
    } else if (path === "/auth/status") value = { ok: true, authenticated: true, enabled: true, password_set: true };
    else if (path === "/workspace") value = { root: "isolated-ui-fixture", live_trading_enabled: false, kill_switch: false };
    else if (path === "/operator/nav") value = { ok: true, data: { primary: [], advanced: [], hidden: [] } };
    else if (path === "/llm/config") value = { ok: true, tiers: [], provider_profiles: [], default_tier: "medium" };
    else if (path === "/llm/tiers") value = { tiers: [] };
    else if (path === "/health") value = { status: "ok" };
    // Intercept every API request, especially writes: never touch a real workspace.
    await route.fulfill({ status: 200, json: value });
  });
  return { writes, errors, installCount: () => installs };
}

test("runtime polling never replaces connection edits or saved revision", () => {
  const draft = initial();
  draft.openai_tunnel.tunnel_id = "tunnel_unsaved";
  draft.openai_tunnel.enabled = false;
  const merged = mergeTunnelRuntime(draft, { ...initial().openai_tunnel, installed: true, tunnel_id: "stale", enabled: true });
  expect(merged.openai_tunnel.tunnel_id).toBe("tunnel_unsaved");
  expect(merged.openai_tunnel.enabled).toBe(false);
  expect(merged.openai_tunnel.installed).toBe(true);
  expect(merged.revision).toBe(draft.revision);
  expect(draft.openai_tunnel.installed).toBe(false);
});

test("trusted MCP UI installs without losing unsaved tunnel ID or key", async ({ page }) => {
  const state = await mock(page);
  await page.goto("/settings#mcp");
  const panel = page.getByRole("region", { name: "MCP", exact: true });
  await expect(panel).toContainText("fully trusted");
  await expect(panel).not.toContainText("External write permissions");
  await expect(panel).not.toContainText("Skill workbench");
  const id = panel.locator('input[placeholder="tunnel_…"]');
  const key = panel.locator('input[type="password"]');
  await id.fill("tunnel_unsaved1234");
  await key.fill("fixture-only-runtime-key");
  await panel.getByRole("button", { name: "Install tunnel-client", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Installing and verifying…" })).toBeDisabled();
  await expect(panel.getByText("tunnel-client installed", { exact: true }).first()).toBeVisible();
  await expect(id).toHaveValue("tunnel_unsaved1234");
  await expect(key).toHaveValue("fixture-only-runtime-key");
  await panel.getByRole("button", { name: "Save MCP settings", exact: true }).click();
  await expect.poll(() => state.writes.filter(row => row.path === "/mcp-settings").length).toBe(1);
  const payload = state.writes.find(row => row.path === "/mcp-settings")!.body;
  expect(Object.keys(payload).sort()).toEqual(["enabled", "openai_tunnel", "public_url", "revision"]);
  expect(payload.openai_tunnel.api_key).toBe("fixture-only-runtime-key");
  expect(state.installCount()).toBe(1);
  expect(state.writes.some(row => row.path.endsWith("/start"))).toBe(false);
  expect(state.errors).toEqual([]);
});

test("failed install can retry and never appears ready prematurely", async ({ page }) => {
  const state = await mock(page, { failFirst: true });
  await page.goto("/settings#mcp");
  const panel = page.getByRole("region", { name: "MCP", exact: true });
  await panel.getByRole("button", { name: "Install tunnel-client", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Installation failed");
  await expect(panel.getByRole("button", { name: "Connect", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "Retry installation", exact: true }).click();
  await expect(panel.getByText("tunnel-client installed", { exact: true }).first()).toBeVisible();
  expect(state.installCount()).toBe(2);
  expect(state.errors).toEqual([]);
});

test("Chinese narrow screen clearly reports missing installer prerequisite", async ({ page }, testInfo) => {
  const state = await mock(page, { supported: false, locale: "zh" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings#mcp");
  const panel = page.getByRole("region", { name: "MCP", exact: true });
  await expect(panel.getByRole("button", { name: "一键安装 tunnel-client", exact: true })).toBeDisabled();
  await expect(panel).toContainText("一键安装需要后端主机上的 Homebrew");
  await expect(panel).not.toContainText("外部写入权限");
  await expect(panel).not.toContainText("Skill 工作台");
  await page.screenshot({ path: testInfo.outputPath("mcp-trusted-mobile.png"), fullPage: true });
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});
