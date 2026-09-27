import { expect, test, type Page } from "@playwright/test";

/** Every API request is mocked: these tests never change an operator workspace. */
async function fixture(page: Page, options: { model?: boolean; account?: boolean; password?: boolean; language?: "en" | "zh"; light?: boolean; cursor?: string } = {}) {
  const state = {
    model: !!options.model, account: !!options.account, password: !!options.password,
    failSave: "", failRead: "", requests: [] as string[],
    writes: [] as { path: string; body: Record<string, any> }[],
    errors: [] as string[],
  };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.addInitScript(({ language, light, cursor }) => {
    localStorage.setItem("nerya.ui_settings.v1", JSON.stringify({ language: language || "en", darkMode: light ? "light" : "dark", refreshSeconds: 0 }));
    if (cursor) localStorage.setItem("nerya.setup.step.v2", cursor);
  }, options);
  let modelConfig = {
    ok: true, default_tier: "medium", intent_tier: "light", provider_profiles: [],
    tiers: ["light", "medium", "high"].map(tier => ({ tier, provider: options.model ? "openai" : "mock", model: options.model ? "fixture-model" : "", routes: options.model ? [{ provider: "openai", model: "fixture-model", context_window: 1048576 }] : [] })),
  };
  const account = { profile: { id: "paper-fixture", venue: "binance", mode: "paper", kind: "cex", status: "active", base_currency: "USDT", live_trading_enabled: false }, snapshot: null, open_positions: [], open_position_count: 0, active_executors: [], protections: [], reserved_usd: 0 };
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api\/proxy/, "");
    state.requests.push(path);
    const write = request.method() === "POST";
    const body = write ? request.postDataJSON() || {} : {};
    if (write) state.writes.push({ path, body });
    if ((write && state.failSave === path) || (!write && state.failRead === path)) {
      await route.fulfill({ status: 503, json: { ok: false, error: "Fixture save unavailable" } }); return;
    }
    if (write && path === "/llm/config") { modelConfig = { ...modelConfig, ...body, provider_profiles: [] }; state.model = true; }
    if (write && path === "/accounts/connect") { Object.assign(account.profile, { id: body.id }); state.account = true; }
    if (write && path === "/auth/admin/password") state.password = true;
    let json: object = { ok: true, data: {}, items: [], accounts: [], providers: [], bindings: [], venues: [], refs: [], statuses: {} };
    if (path === "/auth/status") json = { ok: true, local_access: true, password_configured: state.password };
    else if (path === "/auth/admin/password") json = { ok: true, token: "isolated-fixture-jwt", expires_at: Math.floor(Date.now() / 1000) + 3600 };
    else if (path === "/setup/readiness") json = { status: state.model && state.account && state.password ? "ok" : "blocked", data: {
      checks: [["LLM provider", state.model], ["Trading account", state.account], ["Admin password", state.password]].map(([name, ready]) => ({ name, status: ready ? "ok" : "blocked", summary: "Configuration fixture" })),
      // These legacy diagnostics must never affect completion.
      blocking: ["strategy", "wallet", "risk"],
    } };
    else if (path === "/llm/config") json = modelConfig;
    else if (path === "/llm/models") json = { models: { openai: ["fixture-model"] } };
    else if (path === "/llm/providers") json = { providers: [{ provider: "openai", ready: true }] };
    else if (path === "/llm/catalog") json = { providers: [{ id: "openai", name: "OpenAI", base_url: "https://api.openai.com/v1", api_mode: "chat_completions" }] };
    else if (path === "/accounts/list") json = { accounts: state.account ? [account] : [], ts: 1 };
    else if (path === "/accounts/connect") json = { ok: true, account };
    else if (path === "/workspace") json = { root: "isolated-fixture", live_trading_enabled: false, kill_switch: false };
    else if (path === "/market/venues") json = { venues: [{ name: "binance", label: "Binance" }] };
    else if (path === "/operator/nav") json = { data: { primary: [], advanced: [], hidden: [] } };
    await route.fulfill({ json });
  });
  return state;
}

const nextButton = (page: Page) => page.getByRole("button", { name: "Save and continue", exact: true });
async function saveModel(page: Page) {
  await expect(nextButton(page)).toBeEnabled();
  const form = page.locator("#nerya-setup-llm");
  await form.locator("input[autocomplete=off]").fill("fixture-model");
  await form.locator("input[autocomplete=off]").press("Enter");
  await expect(form.locator("[data-testid=primary-model-settings] input[type=number]")).toHaveValue("1048576");
  await nextButton(page).click();
  await expect(page.locator("#nerya-setup-account")).toBeVisible();
}

test("fresh install saves all three steps without optional diagnostics or balance tests", async ({ page }, testInfo) => {
  const state = await fixture(page);
  await page.goto("/setup?mode=quick");
  await expect(page.getByRole("navigation", { name: "Setup steps" }).getByRole("button")).toHaveCount(3);
  await expect(page.locator("aside")).toHaveCount(0);
  await expect(nextButton(page)).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("setup-model-desktop-dark.png"), fullPage: true });
  await saveModel(page);
  await page.screenshot({ path: testInfo.outputPath("setup-account-desktop-dark.png"), fullPage: true });
  const account = page.locator("#nerya-setup-account");
  await account.getByLabel(/Account name/).fill("paper-fixture");
  await nextButton(page).click();
  await expect(page.locator("#setup-password")).toBeVisible();
  await page.locator("#setup-password").fill("fixture-password");
  await page.locator("#setup-confirm-password").fill("fixture-password");
  await page.getByRole("button", { name: "Finish and open Nerya" }).click();
  await expect(page).toHaveURL(/\/$/);
  const writes = state.writes.filter(row => ["/llm/config", "/accounts/connect", "/auth/admin/password"].includes(row.path));
  expect(writes.map(row => row.path)).toEqual(["/llm/config", "/accounts/connect", "/auth/admin/password"]);
  expect(writes[1].body.live_trading_enabled).not.toBe(true);
  expect(writes[1].body.mode).toBe("paper");
  expect(state.requests.some(path => /test.balance|test_balance|\/risk|\/wallet\/test|\/search\/engines\/test/.test(path))).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem("nerya.setup.step.v2"))).toBeNull();
  expect(await page.evaluate(() => Object.values(localStorage).some(value => value.includes("fixture-password")))).toBe(false);
  expect(state.errors).toEqual([]);
});

test("model save failure stays on model, retains input, and supports retry", async ({ page }) => {
  const state = await fixture(page);
  state.failSave = "/llm/config";
  await page.goto("/setup");
  await expect(nextButton(page)).toBeEnabled();
  const input = page.locator("#nerya-setup-llm input[autocomplete=off]");
  await input.fill("fixture-model");
  await nextButton(page).click();
  await expect(page.getByRole("alert").filter({ hasText: "Fixture save unavailable" }).first()).toBeVisible();
  await expect(page.locator("#nerya-setup-account")).toHaveCount(0);
  state.failSave = "";
  await nextButton(page).click();
  await expect(page.locator("#nerya-setup-account")).toBeVisible();
});

test("Back preserves account draft and a forged cursor cannot skip missing model", async ({ page }) => {
  await fixture(page, { cursor: "password" });
  await page.goto("/setup?step=password");
  await expect(page.locator("#nerya-setup-llm")).toBeVisible();
  await saveModel(page);
  await page.locator("#nerya-setup-account").getByLabel(/Account name/).fill("retained-draft");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await nextButton(page).click();
  await expect(page.locator("#nerya-setup-account").getByLabel(/Account name/)).toHaveValue("retained-draft");
});

test("existing account and password are reused without rewriting either", async ({ page }) => {
  const state = await fixture(page, { model: true, account: true, password: true });
  await page.goto("/setup?step=account");
  await expect(page.getByText("paper-fixture", { exact: true })).toBeVisible();
  await nextButton(page).click();
  await expect(page.getByText("An administrator password is already configured. Continue to keep it.")).toBeVisible();
  await page.getByRole("button", { name: "Finish and open Nerya" }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(state.writes.filter(row => /accounts\/connect|auth\/admin\/password/.test(row.path))).toEqual([]);
});

test("mismatched passwords stay on the last step without sending secrets", async ({ page }) => {
  const state = await fixture(page, { model: true, account: true });
  await page.goto("/setup");
  await page.locator("#setup-password").fill("fixture-password");
  await page.locator("#setup-confirm-password").fill("different-password");
  await page.getByRole("button", { name: "Finish and open Nerya" }).click();
  await expect(page.locator("#nerya-setup-password [role=alert]")).toBeVisible();
  expect(state.writes).toEqual([]);
  await expect(page.locator("#setup-password")).toHaveValue("fixture-password");
});

test("password status retry neither loses progress nor repeats the password write", async ({ page }) => {
  const state = await fixture(page, { model: true, account: true });
  await page.goto("/setup");
  await page.locator("#setup-password").fill("fixture-password");
  await page.locator("#setup-confirm-password").fill("fixture-password");
  state.failRead = "/setup/readiness";
  await page.getByRole("button", { name: "Finish and open Nerya" }).click();
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeVisible();
  state.failRead = "";
  await retry.click();
  await expect(page).toHaveURL(/\/$/);
  expect(state.writes.filter(row => row.path === "/auth/admin/password")).toHaveLength(1);
  expect(await page.evaluate(() => localStorage.getItem("nerya.setup.step.v2"))).toBeNull();
});

test("saving a password cannot discard an earlier unsaved model draft", async ({ page }) => {
  const state = await fixture(page, { model: true, account: true });
  await page.goto("/setup");
  await expect(page.locator("#setup-password")).toBeVisible();
  const steps = page.getByRole("navigation", { name: "Setup steps" });
  await steps.getByRole("button", { name: "LLM model", exact: true }).click();
  await page.locator("#nerya-setup-llm input[autocomplete=off]").fill("unsaved-model-draft");
  await steps.getByRole("button", { name: "Password", exact: true }).click();
  await page.locator("#setup-password").fill("fixture-password");
  await page.locator("#setup-confirm-password").fill("fixture-password");
  await page.getByRole("button", { name: "Finish and open Nerya" }).click();
  await expect(page.locator("#nerya-setup-llm")).toBeVisible();
  await expect(page.locator("#nerya-setup-llm input[autocomplete=off]")).toHaveValue("unsaved-model-draft");
  expect(state.writes.filter(row => row.path === "/llm/config")).toHaveLength(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator("#nerya-setup-llm")).toBeVisible();
});

test("Chinese mobile light view has three readable steps and no horizontal overflow", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page, { model: true, account: true, language: "zh", light: true });
  await page.goto("/setup");
  await expect(page.locator("#setup-password")).toBeVisible();
  await expect(page.getByRole("button", { name: "完成并进入 Nerya" })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("setup-password-zh-mobile-light.png"), fullPage: true });
  expect(state.errors).toEqual([]);
});
