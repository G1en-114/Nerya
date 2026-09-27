import { expect, test, type Page } from "@playwright/test";

/** Isolated UI fixtures. Every API is intercepted; no real credentials or trades. */
async function fixture(page: Page, options: { zh?: boolean; light?: boolean; existing?: boolean } = {}) {
  const state = { failure: "", schemaFailure: false, delay: 0, writes: [] as Record<string, any>[], paths: [] as string[], errors: [] as string[], count: options.existing ? 1 : 0 };
  const profile = { id: "existing-account", label: "Existing account", revision: "revision-1", venue: "hyperliquid", kind: "cex", mode: "shadow", status: "quarantined", base_currency: "USDT", live_trading_enabled: false, initial_balance_usd: 0,
    wallet_id: "", credentials: { private_key: "vault://saved" }, provider_config: { wallet_address: "0xpublic-address" }, permissions: { read_balances: true, place_order: false, cancel_order: false, withdraw: false }, limits: { max_order_notional_usd: 0, max_leverage: 3 } };
  let account: Record<string, any> = { profile, snapshot: null, open_positions: [], protections: [], active_executors: [], open_position_count: 0, protection_count: 0, reserved_usd: 0, bound_strategies: [] };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.addInitScript(opts => localStorage.setItem("nerya.ui_settings.v1", JSON.stringify({ language: opts.zh ? "zh" : "en", darkMode: opts.light ? "light" : "dark", refreshSeconds: 0 })), options);
  await page.route("https://**", route => route.abort());
  await page.route("**/api/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname.replace(/^\/api\/proxy/, "");
    const body = req.method() === "POST" ? req.postDataJSON() || {} : {};
    state.paths.push(path);
    let json: object = { ok: true, data: {}, items: [], accounts: [], providers: [], bindings: [], venues: [], refs: [], statuses: {}, proposals: [] };
    if (path === "/auth/status") json = { ok: true, local_access: true, password_configured: true };
    else if (path === "/setup/readiness") json = { status: "ok", data: { checks: [], blocking: [] } };
    else if (path === "/workspace") json = { root: "isolated-fixture", live_trading_enabled: false, kill_switch: false };
    else if (path === "/operator/nav") json = { data: { primary: [], advanced: [], hidden: [] } };
    else if (path === "/accounts/list") json = { accounts: state.count ? [account] : [], ts: 1 };
    else if (path === "/accounts/get") json = { ok: true, account };
    else if (path === "/exchanges/providers") json = { providers: [
      ["binance", "Binance Spot (ccxt)"], ["okx", "OKX (ccxt)"], ["bybit", "Bybit v5 (ccxt)"], ["hyperliquid", "Hyperliquid (ccxt)"], ["kraken", "Kraken (ccxt)"], ["bitget", "Bitget (ccxt)"],
    ].map(([id, label]) => ({ id, label, kind: "cex", runtime: "python_ccxt", aliases: [], supports: { balances: true }, links: {} })) };
    else if (path === "/wallet/configured") json = { bindings: [{ wallet_id: "wallet-fixture", provider: "okx_os", label: "My configured wallet" }], count: 1 };
    else if (path === "/accounts/intake/schema") {
      const names = body.venue === "hyperliquid" ? ["wallet_address", "private_key"] : body.venue === "okx" ? ["api_key", "api_secret", "api_passphrase"] : ["api_key", "api_secret"];
      json = state.schemaFailure ? { ok: false, error: "fixture" } : { ok: true, credential_fields: names.map(name => ({ name, label: name, required: true, sensitive: name !== "wallet_address", kind: name === "wallet_address" ? "public" : "secret" })) };
    } else if (path === "/accounts/connect") {
      state.writes.push(body);
      if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
      if (state.failure) json = { ok: false, error: state.failure };
      else { account = { ...account, profile: { ...profile, ...body, credentials: {}, revision: "revision-2", live_trading_enabled: false }, snapshot: body.mode === "paper" ? null : { account_id: body.id, ts: 1, health: "ok", source: "shadow", total_usd: 0, cash_by_asset: {} } }; state.count = 1; json = { ok: true, verified: body.mode !== "paper", account }; }
    }
    await route.fulfill({ json });
  });
  return state;
}
const form = (page: Page) => page.getByTestId("account-connection");
const key = (page: Page, name: string) => form(page).locator(`[data-connection-field=${name}]`);
async function open(page: Page, name = /Binance Spot/) {
  await page.goto("/accounts");
  await page.getByRole("button", { name: "Connect a trading account", exact: true }).click();
  await form(page).getByRole("button", { name }).click();
  await form(page).getByRole("button", { name: "Continue", exact: true }).click();
}
async function fill(page: Page) { await key(page, "api_key").fill("fixture-key-only"); await key(page, "api_secret").fill("fixture-secret-only"); }

test("old backend reports the required service update without blaming credentials", async ({ page }) => {
  await fixture(page);
  await page.route("**/api/proxy/accounts/connect", route => route.fulfill({ status: 404, json: { error: "not_found" } }));
  await open(page); await fill(page);
  await form(page).getByRole("button", { name: "Verify and connect", exact: true }).click();
  await expect(form(page).getByRole("alert")).toContainText("Restart Nerya");
  await expect(key(page, "api_secret")).toHaveValue("fixture-secret-only");
  await expect(form(page).getByText("Your account is connected", { exact: true })).toHaveCount(0);
});

test("verified zero balance connects safely and shows a receipt", async ({ page }, info) => {
  const state = await fixture(page);
  await open(page); await fill(page);
  await page.screenshot({ path: info.outputPath("connection-fields-dark.png") });
  await form(page).getByRole("button", { name: "Verify and connect", exact: true }).click();
  await expect(form(page).getByText("Your account is connected", { exact: true })).toBeVisible();
  await expect(form(page).getByText("The connection is valid. A zero balance is not an error.")).toBeVisible();
  await page.screenshot({ path: info.outputPath("connection-success-dark.png") });
  expect(state.writes).toHaveLength(1); expect(state.writes[0].mode).toBe("shadow"); expect(state.writes[0].policy).toBeUndefined();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("fixture-secret-only");
  await form(page).getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByTestId("account-connection-dialog")).toHaveCount(0);
  expect(state.paths.some(path => /\/trading\/(submit|cancel)/.test(path))).toBe(false);
  expect(state.errors).toEqual([]);
});

test("failed validation retains inputs, retries same request, and prevents close while busy", async ({ page }, info) => {
  const state = await fixture(page); state.failure = "auth_error";
  await open(page); await fill(page);
  await form(page).getByRole("button", { name: "Verify and connect", exact: true }).click();
  await expect(form(page).getByRole("alert")).toContainText("platform rejected");
  await expect(key(page, "api_secret")).toHaveValue("fixture-secret-only");
  await page.screenshot({ path: info.outputPath("connection-error-dark.png") });
  state.failure = ""; state.delay = 500;
  await form(page).getByRole("button", { name: "Verify and connect", exact: true }).click();
  await expect(form(page).getByRole("button", { name: "Close", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(form(page)).toBeVisible();
  await expect(form(page).getByText("Your account is connected", { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(2); expect(state.writes[0].request_id).toBe(state.writes[1].request_id);
  expect(state.errors).toEqual([]);
});

test("switching platforms clears secrets and requires the new passphrase", async ({ page }) => {
  const state = await fixture(page);
  await open(page); await fill(page);
  await form(page).getByRole("button", { name: "Change", exact: true }).click();
  await form(page).getByRole("button", { name: /OKX/ }).click();
  await form(page).getByRole("button", { name: "Continue", exact: true }).click();
  await expect(key(page, "api_key")).toHaveValue("");
  await expect(key(page, "api_passphrase")).toBeVisible();
  await form(page).getByRole("button", { name: "Verify and connect", exact: true }).click();
  await expect(form(page).getByRole("alert")).toContainText("required");
  expect(state.writes).toHaveLength(0);
  expect(state.errors).toEqual([]);
});

test("schema failure blocks submit and recovers without fallback credential slots", async ({ page }) => {
  const state = await fixture(page); state.schemaFailure = true;
  await open(page);
  await expect(form(page).getByRole("button", { name: "Verify and connect", exact: true })).toBeDisabled();
  state.schemaFailure = false;
  await form(page).getByRole("button", { name: "Try again", exact: true }).click();
  await expect(key(page, "api_key")).toBeVisible();
  expect(state.writes).toHaveLength(0);
});

test("editing preserves public options, stored credentials and hidden policy", async ({ page }) => {
  const state = await fixture(page, { existing: true });
  await page.goto("/accounts/existing-account");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(key(page, "wallet_address")).toHaveValue("0xpublic-address");
  await expect(key(page, "private_key")).toHaveValue("");
  await form(page).getByRole("button", { name: "Verify and save", exact: true }).click();
  await expect(form(page).getByText("Your account is connected", { exact: true })).toBeVisible();
  expect(state.writes[0].expected_revision).toBe("revision-1"); expect(state.writes[0].credentials).toEqual({});
  expect(state.writes[0].provider_config.wallet_address).toBe("0xpublic-address"); expect(state.writes[0].policy).toBeUndefined();
  expect(state.errors).toEqual([]);
});

test("wallet selection binds the selected wallet, not a colliding exchange", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/accounts"); await page.getByRole("button", { name: "Connect a trading account", exact: true }).click();
  await form(page).getByRole("button", { name: "Wallet", exact: true }).click();
  await form(page).getByRole("button", { name: /My configured wallet/ }).click();
  await form(page).getByRole("button", { name: "Continue", exact: true }).click();
  await form(page).getByRole("button", { name: "Verify and connect", exact: true }).click();
  await expect(form(page).getByText("Your account is connected", { exact: true })).toBeVisible();
  expect(state.writes[0].wallet_id).toBe("wallet-fixture"); expect(state.writes[0].kind).toBe("chain"); expect(state.writes[0].venue).toBe("okx_os");
  expect(state.errors).toEqual([]);
});

test("Chinese mobile light layout has reachable actions and no horizontal overflow", async ({ page }, info) => {
  const state = await fixture(page, { zh: true, light: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/accounts"); await page.getByRole("button", { name: "绑定交易账户", exact: true }).click();
  await expect(form(page).getByRole("button", { name: /Binance Spot/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath("connection-platforms-mobile-zh-light.png") });
  await form(page).getByRole("button", { name: /OKX/ }).click();
  await form(page).getByRole("button", { name: "继续", exact: true }).click();
  await expect(key(page, "api_passphrase")).toBeVisible();
  await page.screenshot({ path: info.outputPath("connection-fields-mobile-zh-light.png") });
  const dialog = page.getByTestId("account-connection-dialog");
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const button = await form(page).getByRole("button", { name: "验证并绑定", exact: true }).boundingBox();
  expect(button && button.y + button.height).toBeLessThan(844);
  expect(state.errors).toEqual([]);
});
