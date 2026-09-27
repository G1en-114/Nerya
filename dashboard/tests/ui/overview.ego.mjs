/** Run with ego-browser in the task's existing space. All /api calls are intercepted.
 * const { installFixture, verifyOverview } = await import("file:///.../overview.ego.mjs");
 * const id = await installFixture(page); await verifyOverview(page, baseUrl, artifactDir);
 * await page.cdp("Page.removeScriptToEvaluateOnNewDocument", {identifier: id});
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

function fixture(initial = {}) {
  const now = Math.floor(Date.now() / 1000);
  const state = window.__overviewTest = { failures: initial.failures || [], errors: [], requests: [], marketCompleted: [], empty: false, missingSnapshot: false, marketDelay: 0 };
  localStorage.setItem("nerya.ui_settings.v1", JSON.stringify({ language: "en", darkMode: "dark", refreshSeconds: 0, timezone: "utc+8" }));
  localStorage.removeItem("nerya.currentAccountId.v1");
  window.addEventListener("error", (event) => state.errors.push(event.message));
  window.addEventListener("unhandledrejection", (event) => state.errors.push(String(event.reason)));
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url || String(input), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return original(input, init);
    const path = url.pathname.replace(/^\/api\/proxy/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    state.requests.push({ path, body });
    if (state.failures.includes(path)) return Response.json({ error: "Fixture unavailable" }, { status: 503 });
    const accounts = [
      { profile: { id: "live-desk", mode: "live", venue: "bybit", status: "active", base_currency: "CNY" }, snapshot: state.missingSnapshot ? null : { account_id: "live-desk", ts: now - 20, health: "ok", total_usd: 84210.5, free_usd: 31000.25 }, open_position_count: 2, reserved_usd: 500, open_positions: [], protections: [], active_executors: [] },
      { profile: { id: "paper-lab", mode: "paper", venue: "mock", status: "active", base_currency: "USDT" }, snapshot: null, open_position_count: 1, reserved_usd: 0, open_positions: [], protections: [], active_executors: [] },
    ];
    const strategies = [
      { id: "trend", title: "BTC momentum · UI fixture", account_id: "live-desk", status: "live", markets: ["BYBIT:BTCUSDT"], realized_pnl_usd: 842.16, open_positions_count: 2 },
      { id: "grid", title: "ETH range · UI fixture", account_id: "paper-lab", status: "paper", markets: ["PAPER:ETHUSDT"], realized_pnl_usd: -126.4, open_positions_count: 1 },
      { id: "draft", title: "SOL breakout · UI fixture", account_id: "paper-lab", status: "draft", markets: ["PAPER:SOLUSDT"], realized_pnl_usd: null, open_positions_count: 0 },
    ];
    let result = { ok: true, data: {}, items: [], events: [], accounts: [], sessions: [], approvals: [], total: 0, has_more: false };
    if (path === "/auth/status") result = { ok: true, authenticated: true, enabled: true, password_set: true };
    else if (path === "/workspace") result = { root: "isolated-ui-fixture", live_trading_enabled: false, kill_switch: false };
    else if (path === "/accounts/list") result = { accounts: state.empty ? [] : accounts, ts: now };
    else if (path === "/portfolio/summary") result = { accounts: [{ id: "paper-lab", mode: "paper", equity_usd: 101250.75, cash_usd: 90100.5, positions: {} }], totals: {} };
    else if (path === "/strategy/list") result = { strategies: state.empty ? [] : strategies };
    else if (path === "/strategy/list_all") result = { strategies: [] };
    else if (path === "/operator/overview") result = { ok: true, status: "ok", data: { attention: state.empty ? [] : [{ id: "approval", title: "Review strategy allocation · UI fixture", summary: "Approval required. No live order is sent in this test.", href: "/inbox", severity: "warn", requires_action: true }], health: {}, counts: {} } };
    else if (path === "/operator/nav") result = { ok: true, data: { primary: [], advanced: [], hidden: [] } };
    else if (path === "/setup/readiness") result = { ok: true, status: "ok", data: { checks: [], blocking: [] } };
    else if (path === "/market/venues") result = { venues: [{ name: "binance", label: "Binance" }, { name: "bybit", label: "Bybit" }] };
    else if (path === "/market/candles") {
      if (state.marketDelay && body.market === "SLOW") await new Promise((resolve) => setTimeout(resolve, state.marketDelay));
      state.marketCompleted.push(body.market);
      result = { candles: state.empty ? [] : Array.from({ length: 48 }, (_, n) => { const open = (body.market === "SLOW" ? 90000 : 62100) + n * 18 + Math.sin(n / 5) * 90; return { ts: now - (48 - n) * 3600, open, high: open + 110, low: open - 70, close: open + 25, volume: 180 + n * 7 }; }), _envelope: { mode: "mock", source: "isolated-ui-fixture" } };
    } else if (path === "/market/news") result = { ok: true, fetched_at: now, items: state.empty ? [] : [
      { title: "Bitcoin market structure and liquidity review · UI fixture", source: "CoinDesk", link: "https://example.com/news/btc", published_at: new Date((now - 900) * 1000).toISOString(), tickers: ["BTC"] },
      { title: "Ethereum network activity and exchange flows · UI fixture", source: "Cointelegraph", link: "https://example.com/news/eth", published_at: new Date((now - 1800) * 1000).toISOString(), tickers: ["ETH"] },
      { title: "Markets await the next macroeconomic release · UI fixture", source: "CoinDesk", link: "https://example.com/news/macro", published_at: new Date((now - 3600) * 1000).toISOString() },
      { title: "Unsafe link must not render", source: "invalid", link: "javascript:alert(1)", published_at: "" },
    ] };
    else if (path === "/trading/recent_trades") result = { trades: state.empty ? [] : [{ order_id: "a", strategy_id: "trend", market: "BTCUSDT", side: "buy", price: 62842.16, ts: new Date(now * 1000).toISOString() }, { order_id: "b", strategy_id: "grid", market: "ETHUSDT", side: "unknown", price: 2640, ts: new Date(now * 1000).toISOString() }] };
    else if (path === "/llm/config") result = { ok: true, tiers: [], provider_profiles: [], default_tier: "medium" };
    else if (path === "/llm/tiers") result = { tiers: [] };
    else if (path === "/workspace/ui") result = { ok: true, manifest: { version: 1, home: { widgets: [] }, pages: [] }, catalog: { widget_kinds: [] } };
    return Response.json(result);
  };
}

export async function installFixture(page, initial = {}) {
  const result = await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(${fixture.toString()})(${JSON.stringify(initial)});` });
  return result.identifier;
}

export async function verifyOverview(page, baseUrl, artifactDir) {
  await mkdir(artifactDir, { recursive: true });
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
  await page.goto(`${baseUrl}/dashboard`);
  await page.waitForFunction(() => document.querySelector("[data-testid=overview-news]")?.textContent.includes("Bitcoin market"));
  console.log(await page.snapshot({ scope: "full_page" }));
  const content = (testId) => page.evaluate((id) => document.querySelector(`[data-testid=${id}]`)?.textContent, testId);
  const click = (label) => page.click(`loc=role:button[name="${label}"]`);
  const scope = 'select[aria-label="Account scope"]';
  const raw = await content("dashboard-overview");
  assert(raw.includes("$84,210.50") && raw.includes("$101,250.75"));
  assert(!raw.includes("¥84,210"), "USD snapshot must not use account base currency");
  assert(raw.includes("Local paper ledger"));
  assert(!raw.includes("Unsafe link must not render"));
  assert((await content("overview-trades")).includes("Unknown"));
  await page.screenshot({ path: `${artifactDir}/overview-desktop-dark.png`, fullPage: true });

  await page.selectOption(scope, "live-desk");
  assert(!(await content("overview-strategies")).includes("ETH range"));
  assert(!(await content("overview-accounts")).includes("paper-lab"));
  assert(!(await content("overview-trades")).includes("ETHUSDT"));
  await click("Other states");
  assert((await content("overview-strategies")).includes("No strategies in this view"));
  await click("Running");
  assert((await content("overview-strategies")).includes("BTC momentum"));
  await page.selectOption(scope, ""); await click("All");
  assert((await content("overview-strategies")).includes("SOL breakout"));

  await page.selectOption('select[aria-label="News source"]', "CoinDesk");
  assert(!(await content("overview-news")).includes("Ethereum network"));
  await page.selectOption('select[aria-label="News source"]', "all");
  const newsLinks = await page.evaluate(() => [...document.querySelectorAll('[data-testid=overview-news] a')].map((a) => ({ href: a.href, target: a.target, rel: a.rel })));
  assert.equal(newsLinks.length, 3);
  assert(newsLinks.every((a) => a.href.startsWith("https://example.com/") && a.target === "_blank" && a.rel.includes("noopener")));
  await click("Refresh news");
  await page.waitForFunction(() => window.__overviewTest.requests.filter((r) => r.path === "/market/news").length >= 2);

  for (const interval of ["1m", "5m", "15m", "4h", "1d", "1h"]) {
    await click(interval);
    await page.waitForFunction((value) => window.__overviewTest.requests.filter((r) => r.path === "/market/candles").at(-1)?.body.interval === value, interval);
  }
  await page.fill('input[aria-label="Market symbol"]', " "); await click("Apply");
  assert((await content("overview-market")).includes("Enter a market symbol without spaces"));
  await page.fill('input[aria-label="Market symbol"]', "ETHUSDT"); await page.press('input[aria-label="Market symbol"]', "Enter");
  await page.waitForFunction(() => window.__overviewTest.requests.filter((r) => r.path === "/market/candles").at(-1)?.body.market === "ETHUSDT");
  await page.selectOption('select[aria-label="Market source"]', "bybit");
  await page.waitForFunction(() => window.__overviewTest.requests.filter((r) => r.path === "/market/candles").at(-1)?.body.venue === "bybit");
  await page.evaluate(() => { window.__overviewTest.marketDelay = 1500; });
  await page.fill('input[aria-label="Market symbol"]', "SLOW"); await click("Apply");
  await page.waitForFunction(() => window.__overviewTest.requests.filter((r) => r.path === "/market/candles").at(-1)?.body.market === "SLOW");
  await page.fill('input[aria-label="Market symbol"]', "ETHUSDT"); await click("Apply");
  await page.waitForFunction(() => document.querySelector('[data-testid=overview-market]')?.textContent.includes("62,973"));
  await page.waitForFunction(() => !document.querySelector('[data-testid=overview-market] [aria-busy=true]'));
  await page.selectOption('select[aria-label="Chart type"]', "line");
  await page.selectOption('select[aria-label="Chart type"]', "area");
  await page.selectOption('select[aria-label="Chart type"]', "candlestick");
  await page.waitForFunction(() => window.__overviewTest.marketCompleted.includes("SLOW"));
  assert((await content("overview-market")).includes("62,973"), "late result must not overwrite the selected symbol");
  await page.click('loc=role:checkbox[name="Show volume"]');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("nerya.ui_settings.v1")).showVolume), false);
  await page.click('loc=role:checkbox[name="Show volume"]');
  await click("Refresh market");

  await page.evaluate(() => { window.__overviewTest.failures = ["/accounts/list", "/workspace", "/market/news"]; });
  await click("Refresh overview");
  await page.waitForFunction(() => document.querySelector('[data-testid=dashboard-overview]')?.textContent.includes("Trading protection unknown") && ![...document.querySelectorAll("button")].some((b) => b.textContent === "Refreshing"));
  assert((await content("dashboard-overview")).includes("$84,210.50"), "preserve prior values on refresh failure");
  assert((await content("overview-news")).includes("Update failed"));
  await page.evaluate(() => { window.__overviewTest.failures = []; });
  await page.click('[data-testid=overview-news] button:text-is("Retry loading")');
  await page.waitForFunction(() => !document.querySelector('[data-testid=overview-news]')?.textContent.includes("Update failed"));
  await click("Refresh overview");
  await page.waitForFunction(() => document.querySelector('[data-testid=dashboard-overview]')?.textContent.includes("Overview refreshed."));

  await page.evaluate(() => { localStorage.setItem("nerya.currentAccountId.v1", "removed-account"); window.dispatchEvent(new Event("nerya:currentAccountId")); });
  assert((await content("dashboard-overview")).includes("missing or inaccessible"));
  await click("Show all accounts");
  assert.equal(await page.evaluate(() => localStorage.getItem("nerya.currentAccountId.v1")), null);
  await page.evaluate(() => { window.__overviewTest.empty = true; });
  await click("Refresh overview");
  await page.waitForFunction(() => document.querySelector('[data-testid=overview-news]')?.textContent.includes("No news available"));
  assert((await content("overview-accounts")).includes("No trading accounts"));
  assert((await content("overview-strategies")).includes("No strategies in this view"));
  await page.evaluate(() => { window.__overviewTest.empty = false; window.__overviewTest.missingSnapshot = true; });
  await click("Refresh overview");
  await page.waitForFunction(() => document.querySelector('[data-testid=overview-accounts]')?.textContent.includes("Check connection"));
  assert(!(await content("dashboard-overview")).includes("$84,210.50"));
  await page.evaluate(() => { window.__overviewTest.missingSnapshot = false; });
  await click("Refresh overview");
  await page.waitForFunction(() => document.querySelector('[data-testid=dashboard-overview]')?.textContent.includes("$84,210.50"));
  await page.selectOption('select[aria-label="Auto refresh"]', "60");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("nerya.ui_settings.v1")).refreshSeconds), 60);
  await page.selectOption('select[aria-label="Auto refresh"]', "0");
  await click("Customize"); await page.waitForSelector('[role="dialog"]');
  console.log((await page.snapshot()).split("dialog").slice(-1).join("dialog"));
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('[role="dialog"]'))), false);
  await page.focus(scope); await page.keyboard.press("Tab");
  assert(await page.evaluate(() => document.activeElement !== document.body));

  const links = await page.evaluate(() => [...document.querySelectorAll('[data-testid=dashboard-overview] a[href]')].map((a) => new URL(a.href).pathname));
  for (const path of ["/chat", "/incidents", "/inbox", "/strategies", "/accounts", "/portfolio", "/orders", "/workflows", "/strategies/trend", "/accounts/live-desk"]) assert(links.includes(path), `Missing action ${path}`);
  assert.deepEqual(await page.evaluate(() => window.__overviewTest.errors), []);
  assert.deepEqual(await page.evaluate(() => window.__overviewTest.requests.filter((r) => /submit|cancel|run_turn|kill_switch\/set/.test(r.path))), []);

  for (const [width, language, darkMode] of [[1440, "zh", "light"], [390, "zh", "light"], [320, "en", "dark"]]) {
    await page.evaluate(({ language, darkMode }) => { const key = "nerya.ui_settings.v1"; localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key)), language, darkMode })); window.dispatchEvent(new Event("storage")); }, { language, darkMode });
    await page.cdp("Emulation.setDeviceMetricsOverride", { width, height: 1080, deviceScaleFactor: 1, mobile: false });
    await page.waitForFunction((language) => document.querySelector("h1")?.textContent === (language === "zh" ? "交易概览" : "Trading overview"), language);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Overflow at ${width}px`);
    await page.screenshot({ path: `${artifactDir}/overview-${width}-${language}-${darkMode}.png`, fullPage: true });
  }
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
  await click("Customize");
  for (const preset of ["Add a dashboard widget", "Create a menu page", "Customize a Skill", "Customize an Agent", "Modify configuration"]) {
    await page.click(`loc=role:button[name*="${preset}"]`);
    assert(await page.evaluate(() => document.querySelector('[role=dialog] textarea').value.length > 20));
  }
  await click("Ask agent");
  await page.waitForURL(`${baseUrl}/chat`);
  assert.deepEqual(await page.evaluate(() => window.__overviewTest.requests.filter((r) => /submit|cancel|run_turn|kill_switch\/set/.test(r.path))), []);
  console.log("PASS: overview controls, filtering, market settings, refresh/retry, missing/empty/stale states, keyboard, safe links, USD semantics, 320/390/1440px, en/zh, light/dark; no trading writes.");
}

export async function verifyInitialFailures(page, baseUrl) {
  await installFixture(page, { failures: ["/accounts/list", "/strategy/list", "/workspace", "/operator/overview", "/market/news"] });
  await page.goto(`${baseUrl}/dashboard`);
  await page.waitForFunction(() => document.querySelector('[data-testid=overview-news]')?.textContent.includes("Data unavailable"));
  const metrics = await page.evaluate(() => [...document.querySelectorAll('[data-testid=dashboard-overview] > dl > div > dd')].map((e) => e.textContent));
  assert.deepEqual(metrics, ["—", "—", "—", "—"]);
  assert(await page.evaluate(() => document.querySelector('[data-testid=dashboard-overview]').textContent.includes("Trading protection unknown")));
  assert(!await page.evaluate(() => document.querySelector('[data-testid=overview-strategies]').textContent.includes("No strategies in this view")));
  await page.evaluate(() => { window.__overviewTest.failures = []; });
  await page.click('loc=role:button[name="Refresh overview"]');
  await page.waitForFunction(() => document.querySelector('[data-testid=dashboard-overview]').textContent.includes("Overview refreshed."));
  assert.deepEqual(await page.evaluate(() => window.__overviewTest.errors), []);
  console.log("PASS: initial failures remain unknown, no false empty state; refresh recovers all panels.");
}
