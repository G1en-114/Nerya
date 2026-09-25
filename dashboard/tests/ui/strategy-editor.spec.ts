import { test, expect, type Page } from "@playwright/test";
import { compactWorkflow } from "../../lib/workflowProjection";
import { strategyChatUrl, strategyEditPrompt } from "../../lib/strategyChat";
import type { WorkflowNode, WorkflowView } from "../../lib/workflowTypes";
import { chooseOption } from "./choice-control";

const SID = "timer_editor", PID = "timer-candidate";
function fixture(proposal: string | null = PID): WorkflowView {
  const timer: WorkflowNode = { id: "scheduler:trading", kind: "scheduler", title: "Trading schedule", subtitle: "every 300s", resource: "trading", config: { type: "interval", every_seconds: 300, enabled: false, timezone: "UTC", custom_window: "preserve" }, binding: { file: null, path: ["schedule"] }, editable: true, position: { x: 30, y: 210 } };
  return {
    ok: true, strategy_id: SID, revision: "timer-revision-1", legacy: false, can_edit: true,
    manifest: { strategy_id: SID, title: "Market observation", mode: "paper", schedule: timer.config },
    source: { proposal_id: proposal, state: proposal ? "pending_review" : "active", omitted_files: [] },
    metadata: { version: 1, nodes: {}, edges: [] },
    strategy: { id: "strategy", nodes: [
      { id: `strategy:${SID}`, kind: "strategy", title: "Market observation", subtitle: SID, resource: SID, config: { title: "Market observation" }, binding: { file: null, path: [] }, editable: true, position: { x: 30, y: 30 } },
      timer,
      { id: "script:main.py", kind: "script", title: "main.py", subtitle: "Python", resource: "main.py", config: {}, content: "# @nerya.title Read observations\n# @nerya.description Read data without placing orders.\ndef run(ctx):\n    pass\n", binding: { file: "main.py", path: null }, editable: true, position: { x: 380, y: 210 } },
      { id: "agent:review", kind: "agent", title: "Review observations", subtitle: "Agent", resource: "review", config: {}, content: "CONFIG_SECRET_NOT_FOR_HANDOFF", binding: { file: "agents/review.agent.md", path: null }, editable: true, position: { x: 730, y: 210 } },
    ], edges: [
      { id: "config", source: `strategy:${SID}`, target: "scheduler:trading", relation: "configures", origin: "manifest", label: "configures" },
      { id: "trigger", source: "scheduler:trading", target: "script:main.py", relation: "triggers", origin: "manifest", label: "triggers" },
      { id: "dispatch", source: "script:main.py", target: "agent:review", relation: "dispatch", origin: "static", label: "dispatch" },
    ] },
    evolution: { id: "evolution", nodes: [{ ...timer, id: "scheduler:tuning", binding: { file: null, path: ["tuning", "schedule"] } }], edges: [] },
  };
}
const text = (key: string) => key;
function context(prompt: string) { return JSON.parse(prompt.split("```json\n")[1].split("\n```")[0]); }

test("timer is a connected canvas node, not supporting configuration; canonical positions and graph stay intact", () => {
  const source = fixture(), before = JSON.stringify(source);
  const result = compactWorkflow(source.strategy, text, source.metadata);
  expect(result.graph.nodes.map(n => n.id)).toEqual(["scheduler:trading", "script:main.py", "agent:review"]);
  expect(result.graph.edges.map(e => e.id)).toEqual(["trigger", "dispatch"]);
  expect(result.supporting.flatMap(group => group.members).some(n => n.kind === "scheduler")).toBe(false);
  expect(result.graph.nodes[0].position).toEqual({ x: 30, y: 210 });
  expect(JSON.stringify(source)).toBe(before);
});

test("continuous workflows do not gain fake timers and review graphs remain unchanged", () => {
  const source = fixture();
  source.strategy.nodes = source.strategy.nodes.filter(n => n.kind !== "scheduler");
  source.strategy.edges = source.strategy.edges.filter(e => ![e.source, e.target].includes("scheduler:trading"));
  expect(compactWorkflow(source.strategy, text).graph.nodes.some(n => n.kind === "scheduler")).toBe(false);
  for (const id of ["evolution", `${SID}:${PID}:evolution`]) {
    const graph = { ...source.evolution, id };
    expect(compactWorkflow(graph, text).graph).toBe(graph);
  }
});

test("edit prompt carries exact saved strategy, proposal, revision, node and adjacent resources without copying source", () => {
  const source = fixture();
  const prompt = strategyEditPrompt(source, "Make a small change", "Read the saved strategy first", source.strategy.nodes[2]);
  expect(context(prompt)).toMatchObject({ strategy_id: SID, proposal_id: PID, base_revision: "timer-revision-1", mode: "paper", target: { node_id: "script:main.py", binding: { file: "main.py" } }, related_resources_total: 2 });
  expect(context(prompt).related_resources.map((n: { node_id: string }) => n.node_id)).toEqual(["scheduler:trading", "agent:review"]);
  expect(prompt).not.toContain("CONFIG_SECRET_NOT_FOR_HANDOFF");
  expect(prompt).toMatch(/Make a small change$/);
  expect(context(strategyEditPrompt(source, "Review", "Read first", source.evolution.nodes[0]))).toMatchObject({ workflow: "evolution", target: { node_id: "scheduler:tuning", binding: { path: ["tuning", "schedule"] } } });
});

test("published context is explicit and Unicode IDs round-trip in chat links", () => {
  expect(context(strategyEditPrompt(fixture(null), "Edit", "Read first"))).toMatchObject({ strategy_id: SID, proposal_id: null, source_state: "active" });
  const url = new URL(strategyChatUrl("策略 & 1", "候选/2"), "http://localhost");
  expect(url.searchParams.get("strategy")).toBe("策略 & 1");
  expect(url.searchParams.get("proposal")).toBe("候选/2");
  expect(new URL(strategyChatUrl(SID), "http://localhost").searchParams.has("proposal")).toBe(false);
});

async function mock(page: Page, options: { proposal?: string | null; language?: string; theme?: string; readonly?: boolean } = {}) {
  let current = fixture(options.proposal === undefined ? PID : options.proposal);
  current.can_edit = !options.readonly;
  const errors: string[] = [], writes: Array<{ endpoint: string; body: any }> = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(({ language, theme }) => localStorage.setItem("nerya.ui_settings.v1", JSON.stringify({ language, darkMode: theme })), { language: options.language || "en", theme: options.theme || "dark" });
  // Every API request is intercepted, including mutations and Agent sends.
  await page.route("**/api/**", async route => {
    const endpoint = new URL(route.request().url()).pathname.replace(/^\/api\/proxy/, "");
    if (route.request().method() === "POST" && !["/strategy/list_all", "/strategy/backtests"].includes(endpoint)) writes.push({ endpoint, body: route.request().postDataJSON() });
    let result: unknown = { ok: true, items: [], count: 0, total: 0 };
    if (endpoint === "/strategies/runtime/workflow") result = current;
    else if (endpoint === "/strategies/runtime/workflows") result = { ok: true, workflows: [{ key: SID, strategy_id: SID, proposal_id: current.source.proposal_id, title: "Market observation", mode: "paper", status: "draft", state: "pending_review", markets: [], counts: { scheduler: 1, script: 1, agent: 1 } }] };
    else if (endpoint === "/strategies/runtime/workflow/propose") {
      const body = route.request().postDataJSON();
      for (const change of body.changes || []) {
        const node = current.strategy.nodes.find(n => n.id === change.node_id)!;
        if (change.config) node.config = change.config;
        if (node.kind === "scheduler") current.manifest.schedule = node.config;
      }
      current = { ...current, revision: "timer-revision-2", source: { ...current.source, proposal_id: "timer-saved" } };
      result = { ok: true, strategy_id: SID, proposal_id: "timer-saved", state: "pending_review", workflow: current };
    } else if (endpoint === "/agent/run_turn_internal") result = { ok: true, session_id: route.request().postDataJSON().session_id, turn_id: "isolated-turn", reply_text: "Context received in isolated test.", final_text: "Context received in isolated test.", stopped_reason: "done" };
    else if (endpoint.includes("/agent/session/") || endpoint === "/agent/session") result = { error: "not_found" };
    else if (endpoint.includes("stream/events")) result = { events: [], latest_seq: 0, cursor: 0 };
    else if (endpoint === "/auth/status") result = { ok: true, authenticated: true, local_access: true, password_set: true, enabled: true };
    else if (endpoint === "/runtime/info") result = {ok:true,protocol_version:1,build_id:"test",workspace_id:"test",capabilities:["conversation_commands","session_view","plan_mode","user_interactions"]};
    else if (endpoint === "/agent/sessions/view") {await route.fulfill({status:404,json:{ok:false}});return;}
    else if (endpoint === "/workspace") result = { root: "isolated-strategy-editor", live_trading_enabled: false };
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
    await route.fulfill({ status: 200, json: result });
  });
  const { installCommandFixture } = await import('./command-fixture');
  await installCommandFixture(page,{complete:true,responseText:'Context received in isolated test.',onSend:body=>writes.push({endpoint:'/agent/commands',body})});
  return { errors, writes };
}
async function open(page: Page, proposal: string | null = PID) {
  await page.goto(`/strategies?strategy_id=${SID}${proposal ? `&proposal_id=${proposal}` : ""}`);
  await expect(page.getByTestId("strategy-workflow-panel")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByTestId("workflow-canvas").locator('[data-kind="scheduler"]')).toBeVisible();
}
async function openTimer(page: Page) {
  await page.locator('[data-workflow-node="scheduler:trading"] button[aria-pressed]').click();
  await expect(page.getByTestId("workflow-inspector")).toBeVisible();
}

test("timer editing saves the same schedule as a review proposal without starting it", async ({ page }, info) => {
  const state = await mock(page); await open(page);
  await expect(page.locator('[data-support-member="scheduler:trading"]')).toHaveCount(0);
  await expect(page.locator('[data-edge="trigger"]')).toHaveCount(1);
  await page.getByTestId("strategy-workflow-panel").screenshot({ path: info.outputPath("timer-canvas.png") });
  await openTimer(page);
  await expect(page.getByTestId("workflow-edit-context")).toContainText(SID);
  await expect(page.getByTestId("workflow-edit-context")).toContainText(PID);
  const interval = page.getByTestId("workflow-inspector").locator('input[type="number"]').first();
  await expect(interval).toHaveValue("300"); await interval.fill("900");
  await expect(page.getByTestId("edit-node-chat")).toBeDisabled();
  await expect(page.getByTestId("edit-strategy-chat")).toBeDisabled();
  await page.getByTestId("workflow-editor-dialog").screenshot({ path: info.outputPath("timer-editor.png") });
  await page.getByTestId("workflow-editor-dialog").getByRole("button", { name: "Review changes", exact: true }).click();
  await page.getByRole("dialog").last().getByRole("button", { name: "Save proposal", exact: true }).click();
  await expect(page).toHaveURL(/proposal_id=timer-saved/);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ endpoint: "/strategies/runtime/workflow/propose", body: { strategy_id: SID, proposal_id: PID, base_revision: "timer-revision-1", changes: [{ node_id: "scheduler:trading", config: { type: "interval", every_seconds: 900, enabled: false, custom_window: "preserve" } }] } });
  await page.reload(); await openTimer(page);
  await expect(interval).toHaveValue("900");
  expect(state.errors).toEqual([]);
});

for (const proposal of [PID, null]) {
  test(`Agent edit draft and real send preserve ${proposal ? "candidate" : "published"} strategy identity`, async ({ page }, info) => {
    const state = await mock(page, { proposal }); await open(page, proposal);
    if (proposal) { await openTimer(page); await page.getByTestId("edit-node-chat").click(); }
    else await page.getByTestId("edit-strategy-chat").click();
    await expect(page).toHaveURL(new RegExp(`/chat\\?strategy=${SID}`));
    const composer = page.locator("textarea:visible").first();
    await expect(composer).toHaveValue(/base_revision/);
    const prompt = await composer.inputValue();
    expect(context(prompt)).toMatchObject({ strategy_id: SID, proposal_id: proposal, base_revision: "timer-revision-1", target: { node_id: proposal ? "scheduler:trading" : `strategy:${SID}` } });
    expect(state.writes).toEqual([]);
    await page.screenshot({ path: info.outputPath("strategy-edit-draft.png"), fullPage: true });
    const sent = page.waitForRequest(r => r.url().endsWith("/agent/commands") && r.method() === "POST");
    await composer.press("Enter");
    const command = (await sent).postDataJSON();
    const payload = command.request;
    expect(payload.strategy_id).toBe(SID);
    expect(payload.strategy_proposal_id).toBe(proposal || undefined);
    expect(payload.payload.text).toBe(prompt.trim());
    expect(command.session_id).toBeTruthy();
    await expect(page.getByText("Context received in isolated test.", { exact: true }).first()).toBeVisible();
    expect(state.writes.filter(w => w.endpoint === '/agent/commands')).toHaveLength(1);
    expect(state.errors).toEqual([]);
  });
}

test("a repeated edit on the same chat route replaces the consumed draft without sending", async ({ page }) => {
  const state = await mock(page); await open(page);
  await page.getByTestId("edit-strategy-chat").click();
  const composer = page.locator("textarea:visible").first();
  await expect(composer).toHaveValue(/base_revision/);
  const firstDraft = new URL(page.url()).searchParams.get("draft");
  await expect(page.getByTestId("strategy-workflow-panel")).toBeHidden();
  await page.getByTestId("open-workspace").click();
  await expect(page.getByTestId("strategy-workflow-panel")).toBeVisible();
  await openTimer(page); await page.getByTestId("edit-node-chat").click();
  expect(firstDraft).toBeTruthy();
  await expect.poll(() => new URL(page.url()).searchParams.get("draft")).not.toBe(firstDraft);
  await expect.poll(async () => context(await composer.inputValue()).target.node_id).toBe("scheduler:trading");
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("readonly workflows cannot open an Agent edit handoff", async ({ page }) => {
  const state = await mock(page, { readonly: true }); await open(page);
  await expect(page.getByTestId("edit-strategy-chat")).toBeDisabled();
  await expect(page.getByTestId("edit-strategy")).toBeDisabled();
  await openTimer(page); await expect(page.getByTestId("edit-node-chat")).toBeDisabled();
  expect(state.writes).toEqual([]);
});

for (const theme of ["dark", "light"]) {
  test(`Chinese ${theme} timer cards and editor fit mobile and tablet, returning keyboard focus`, async ({ page }, info) => {
    const state = await mock(page, { language: "zh", theme });
    for (const width of [390, 820]) {
      await page.setViewportSize({ width, height: 900 }); await open(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
      await chooseOption(page.getByRole("combobox", { name: "显示内容", exact: true }), "cards");
      const card = page.getByTestId("workflow-card-gallery").locator('[data-workflow-node="scheduler:trading"]');
      await card.click();
      const dialog = page.getByTestId("workflow-editor-dialog");
      await expect(dialog).toBeVisible();
      const bounds = (await dialog.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
      await dialog.screenshot({ path: info.outputPath(`timer-${theme}-${width}.png`) });
      await page.keyboard.press("Escape"); await expect(card).toBeFocused();
    }
    expect(state.errors).toEqual([]); expect(state.writes).toEqual([]);
  });
}
