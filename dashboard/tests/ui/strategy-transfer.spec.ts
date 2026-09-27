import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseStrategyBundle, type StrategyBundle } from "../../lib/strategyTransfer";
import type { WorkflowView, WorkflowSummary } from "../../lib/workflowTypes";

const bundle: StrategyBundle = { format: "nerya.strategy", version: 1, strategy_id: "original", title: "Portable strategy", files: {
  "strategy.yml": "strategy_id: original\ntitle: Portable strategy\nmode: paper\n",
  "main.py": "def run(ctx):\n    return None\n",
  "notes.md": "# 中文提示词\nPreserve this text.\n",
} };
function view(id: string, title = "Portable strategy", proposal = "import-review"): WorkflowView {
  return { ok: true, strategy_id: id, revision: `revision-${proposal}`, manifest: { strategy_id: id, title, mode: "paper" },
    metadata: { version: 1, nodes: {}, edges: [] }, legacy: false, can_edit: true,
    source: { proposal_id: proposal, state: "pending_review", omitted_files: [] },
    strategy: { id: "strategy", nodes: [
      { id: `strategy:${id}`, kind: "strategy", title, subtitle: id, resource: id, config: { title, description: "Source for transfer testing" }, binding: { file: null, path: [] }, editable: true, position: { x: 30, y: 30 } },
      { id: "script:main.py", kind: "script", title: "main.py", subtitle: "Python", resource: "main.py", content: bundle.files["main.py"], config: {}, binding: { file: "main.py", path: null }, editable: true, position: { x: 360, y: 30 } },
    ], edges: [{ id: "entry", source: `strategy:${id}`, target: "script:main.py", relation: "entrypoint", origin: "manifest", label: "entry" }] },
    evolution: { id: "evolution", nodes: [], edges: [] },
  };
}

async function mock(page: Page, language = "en") {
  let current: WorkflowView | null = null;
  let failImport = false;
  const mutations: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((locale) => {
    localStorage.setItem("nerya.ui_settings.v1", JSON.stringify({ language: locale, darkMode: "dark" }));
  }, language);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const endpoint = url.pathname.replace(/^\/api\/proxy/, "");
    // This existing read endpoint uses POST; all other POSTs remain tracked.
    if (route.request().method() === "POST" && endpoint !== "/strategy/list_all") mutations.push(endpoint);
    let result: unknown = { ok: true, items: [], count: 0, total: 0 };
    if (endpoint === "/strategies/runtime/workflow/import") {
      const input = route.request().postDataJSON();
      if (failImport) { failImport = false; result = { ok: false, error: "strategy_id_conflict: already exists" }; }
      else { current = view(input.strategy_id); result = { ok: true, strategy_id: current.strategy_id, proposal_id: current.source.proposal_id, state: "pending_review", workflow: current }; }
    } else if (endpoint === "/strategies/runtime/workflow/propose") {
      const input = route.request().postDataJSON();
      const title = input.changes?.find((change: { node_id: string }) => change.node_id.startsWith("strategy:"))?.config?.title;
      current = view(input.strategy_id, title, "edit-review");
      result = { ok: true, strategy_id: current.strategy_id, proposal_id: current.source.proposal_id, state: "pending_review", workflow: current };
    } else if (endpoint === "/strategies/runtime/workflow/export") {
      result = { ok: true, filename: `${current?.strategy_id}.nerya.json`, bundle: { ...bundle, strategy_id: current?.strategy_id,
        title: current?.manifest.title, files: { ...bundle.files, "strategy.yml": `strategy_id: ${current?.strategy_id}\ntitle: ${current?.manifest.title}\nmode: paper\n` } } };
    } else if (endpoint === "/strategies/runtime/workflow") result = current;
    else if (endpoint === "/strategies/runtime/workflows") {
      const workflows: WorkflowSummary[] = current ? [{ key: "import-review", strategy_id: current.strategy_id, proposal_id: current.source.proposal_id,
        title: String(current.manifest.title), description: "Imported source", mode: "paper", state: "pending_review", counts: { script: 1 }, markets: [] }] : [];
      result = { ok: true, workflows, total: workflows.length };
    } else if (endpoint === "/auth/status") result = { ok: true, authenticated: true, local_access: true, password_set: true, enabled: true };
    else if (endpoint === "/workspace") result = { root: "fixture", live_trading_enabled: false };
    else if (endpoint === "/health") result = { status: "ok" };
    else if (endpoint === "/setup/readiness") result = { status: "ok", data: { checks: [], blocking: [] } };
    else if (endpoint === "/operator/overview") result = { status: "ok", data: { attention: [], counts: {}, accounts: [], strategies: [] } };
    else if (endpoint === "/operator/nav") result = { ok: true, data: { primary: [], advanced: [] }, primary: [], advanced: [] };
    else if (endpoint === "/accounts/list") result = { accounts: [], ts: 0 };
    else if (endpoint === "/agent/sessions") result = { sessions: [], has_more: false };
    else if (endpoint === "/llm/config") result = { ok: true, default_tier: "medium", tiers: [{ tier: "medium", provider: "openai", model: "fixture", key_ref: "fixture-only" }], provider_profiles: [] };
    else if (endpoint === "/portfolio/summary") result = { accounts: [], totals: {} };
    else if (endpoint === "/portfolio/pnl") result = { equity_usd: 0, realized_usd: 0, total_pnl_usd: 0 };
    else if (endpoint.includes("strategy/list")) result = { ok: true, strategies: [] };
    // Never send test requests, especially mutations, to any real runtime.
    await route.fulfill({ status: 200, json: result });
  });
  return { mutations, errors, failNextImport: () => { failImport = true; } };
}

async function upload(page: Page, value: unknown = bundle) {
  await page.getByTestId("strategy-import-form").locator('input[type="file"]').setInputFiles({
    name: "portable.nerya.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(value)),
  });
}

test("bundle parser preserves Unicode and rejects malformed or oversized source", () => {
  expect(parseStrategyBundle("\uFEFF" + JSON.stringify(bundle)).files).toEqual(bundle.files);
  for (const value of [null, [], {}, { ...bundle, version: 2 }, { ...bundle, files: [] }, { ...bundle, files: { "main.py": "pass" } }]) {
    expect(() => parseStrategyBundle(JSON.stringify(value))).toThrow();
  }
  expect(() => parseStrategyBundle(JSON.stringify({ ...bundle, files: { ...bundle.files, "large.md": "文".repeat(70_000) } }))).toThrow("tooLarge");
});

test("invalid imports and cancellation never create a proposal", async ({ page }) => {
  const fixture = await mock(page);
  await page.goto("/strategies");
  await page.getByTestId("import-strategy").click();
  await upload(page, { ...bundle, version: 2 });
  await expect(page.getByRole("alert")).toContainText("Invalid bundle");
  await expect(page.getByRole("button", { name: "Import as review proposal" })).toBeDisabled();
  await upload(page);
  await page.getByLabel("New strategy ID").fill("../escape");
  await expect(page.getByRole("button", { name: "Import as review proposal" })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(fixture.mutations).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test("import, conflict retry, edit draft and export saved version", async ({ page }, testInfo) => {
  const fixture = await mock(page);
  await page.goto("/strategies");
  await page.getByTestId("import-strategy").click();
  await upload(page);
  await page.getByLabel("New strategy ID").fill("portable_copy");
  await expect(page.getByText("3 files", { exact: false })).toBeVisible();
  await page.getByTestId("workflow-editor-dialog").screenshot({ path: testInfo.outputPath("import-preview.png") });
  fixture.failNextImport();
  await page.getByRole("button", { name: "Import as review proposal" }).click();
  await expect(page.getByRole("alert")).toContainText("already in use");
  await page.getByRole("button", { name: "Import as review proposal" }).click();
  await expect(page).toHaveURL(/strategy_id=portable_copy/);
  await expect(page.getByTestId("edit-strategy")).toBeEnabled();
  await page.getByTestId("edit-strategy").click();
  const inspector = page.getByTestId("workflow-inspector");
  await expect(inspector).toBeVisible();
  await inspector.locator("input").first().fill("Edited portable strategy");
  await expect(page.getByTestId("export-strategy")).toBeDisabled();
  await page.getByTestId("workflow-editor-dialog").getByRole("button", { name: /Save|Review/ }).last().click();
  const confirmation = page.getByRole("dialog").last();
  await confirmation.getByRole("button", { name: /Save|Confirm|Review/ }).last().click();
  await expect(page).toHaveURL(/proposal_id=edit-review/);
  await expect(page.getByTestId("export-strategy")).toBeEnabled();
  const downloaded = page.waitForEvent("download");
  await page.getByTestId("export-strategy").click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe("portable_copy.nerya.json");
  const saved = JSON.parse(readFileSync((await file.path())!, "utf8"));
  expect(saved.title).toBe("Edited portable strategy");
  expect(saved.files["notes.md"]).toBe(bundle.files["notes.md"]);
  await page.screenshot({ path: testInfo.outputPath("edited-strategy.png"), fullPage: true });
  expect(fixture.mutations).toEqual(["/strategies/runtime/workflow/import", "/strategies/runtime/workflow/import", "/strategies/runtime/workflow/propose"]);
  expect(fixture.errors).toEqual([]);
});

test("Chinese mobile import preview remains usable", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mock(page, "zh");
  await page.goto("/strategies");
  await page.getByTestId("import-strategy").click();
  await upload(page);
  const dialog = page.getByTestId("workflow-editor-dialog");
  await expect(dialog.getByRole("button", { name: "导入为待审阅提案" })).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds?.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("import-mobile-zh.png"), fullPage: true });
});
