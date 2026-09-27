"use strict";
// Opt-in live UI verification; consumes receipts from verify_mcp_session_roundtrip.py.
// No mocked API responses, model calls, account changes, or trading actions.
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { chromium, expect } = require("@playwright/test");
const run = promisify(execFile);
const root = path.resolve(__dirname, "../..");
const reportPath = path.join(root, "test-results/mcp-session-verification.json");
const base = "http://127.0.0.1:18380";
const receipts = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const results = { checks: [], screenshots: [], pageErrors: [] };
const deadline = setTimeout(() => { console.error("UI verification exceeded 60 seconds"); process.exit(2); }, 60000);

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    page.on("pageerror", error => results.pageErrors.push(error.message));
    page.setDefaultTimeout(12000);
    for (const row of receipts.summaries) {
      await page.goto(`${base}/chat/${row.session_id}`, { waitUntil: "domcontentloaded" });
      const label = row.source === "tunnel" ? "Tunnel" : "MCP";
      await expect(page.getByTestId("external-session")).toContainText(label);
      await expect(page.getByTestId("external-call")).toHaveCount(row.calls);
      await expect(page.getByTestId("external-composer-hint")).toBeVisible();
      await expect(page.locator("textarea")).toBeVisible();
      await expect(page.locator(`a[href="/chat/${row.session_id}"] svg[aria-label="${label}"]`)).toBeVisible();
      const sources = await page.getByTestId("external-call").evaluateAll(nodes => nodes.map(n => n.dataset.source));
      if (sources.some(source => source !== row.source)) throw new Error("Mixed source in conversation");
      const card = page.getByTestId("external-call").filter({ hasText: "nerya_native_role_list" }).first();
      await card.getByTestId("external-technical-details").locator("summary").first().click();
      await card.locator("summary").filter({ hasText: /Session and call identifiers|会话与调用标识/ }).click();
      await expect(card).toContainText(row.session_id);
      await card.getByTestId("external-call-step").first().locator("summary").first().click();
      await expect(card.getByTestId("external-call-step").first()).toContainText("role_list");
      const screenshot = path.join(root, "test-results", `mcp-session-${row.source}-${receipts.summaries.indexOf(row)}.png`);
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: screenshot });
      results.screenshots.push(screenshot);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("external-call")).toHaveCount(row.calls);
      results.checks.push({ session_id: row.session_id, source: row.source, calls: row.calls,
        source_icon: true, child_chain: true, reload_persistence: true, readonly: true });
    }
    // Append real calls from a separate stdio process while the viewer stays open.
    const liveId = receipts.sessions.mcp[0];
    await page.goto(`${base}/chat/${liveId}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("external-call")).toHaveCount(receipts.summaries[0].calls);
    await run(path.join(root, ".venv/bin/python"), [path.join(root, "scripts/verify_mcp_session_roundtrip.py"),
      "--workspace", receipts.workspace, "--report", reportPath, "--reuse"], { cwd: root, timeout: 45000 });
    const updated = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const calls = updated.summaries.find(row => row.session_id === liveId).calls;
    await expect(page.getByTestId("external-call")).toHaveCount(calls, { timeout: 12000 });
    results.live_refresh = { before: receipts.summaries[0].calls, after: calls, without_reload: true };
    await page.goto(`${base}/chat`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("textarea")).toBeVisible();
    await expect(page.getByTestId("external-session")).toHaveCount(0);
    results.normal_chat_unchanged = true;
    if (results.pageErrors.length) throw new Error(results.pageErrors.join("\n"));
    fs.writeFileSync(path.join(root, "test-results/mcp-session-ui-verification.json"), JSON.stringify(results, null, 2) + "\n");
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await browser.close();
    clearTimeout(deadline);
  }
})().catch(error => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
