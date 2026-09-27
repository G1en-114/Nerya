import { test, expect, type Page } from "@playwright/test";
import { composerFileQuery, composerTrigger, filterComposerOptions, replaceComposerTrigger } from "../../lib/composerInput";
import type { ChatAttachment } from "../../lib/chat";
import { installCommandFixture } from "./command-fixture";

const skills = [
  { id: "research", title: "Research", description: "Gather cited evidence and prepare analysis", status: "ready" },
  { id: "coding", title: "Coding", description: "Inspect and edit workspace code", status: "ready" },
  { id: "off", title: "Disabled skill", status: "disabled" },
];
const tiers = ["light", "medium", "high", "intent"].map(tier => ({ tier, provider: "openai", model: "fixture-model", key_ref: "fixture" }));
const input = (page: Page) => page.locator("[data-chat-composer] textarea");
const panel = (page: Page) => page.getByTestId("composer-suggestions");
const chip = (page: Page, id: string) => page.locator(`[data-chat-composer] [data-context-id="${id}"]`);

async function fixture(page: Page, options: { failReadOnce?: boolean; language?: string; theme?: string } = {}) {
  const state = { requests: [] as string[], errors: [] as string[], uploads: [] as ChatAttachment[][],
    turns: [] as { payload: { text: string; attachments: ChatAttachment[] } }[], failReads: options.failReadOnce ? 1 : 0 };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.addInitScript(({ language, theme }) => {
    localStorage.setItem("nerya.ui_settings.v1", JSON.stringify({ language, darkMode: theme }));
  }, { language: options.language ?? "en", theme: options.theme ?? "dark" });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/proxy/, "");
    state.requests.push(`${request.method()} ${path}${url.search}`);
    let body: unknown = { ok: true, items: [], count: 0, total: 0 };
    if (path === "/llm/config") body = { ok: true, default_tier: "medium", intent_tier: "light", tiers, provider_profiles: [], reasoning_levels: ["none", "low", "medium", "high"] };
    else if (path === "/llm/tiers") body = { tiers, count: tiers.length };
    else if (path === "/llm/providers") body = { providers: [{ provider: "openai", ready: true, adapter_present: true, has_key_ref: true }], count: 1 };
    else if (path === "/llm/models") body = { providers: { openai: [{ id: "fixture-model" }] } };
    else if (path === "/llm/catalog") body = { providers: [], reasoning_levels: [] };
    else if (path === "/llm/oauth/providers") body = { providers: [], statuses: {} };
    else if (path === "/auth/status") body = { ok: true, authenticated: true, local_access: true, enabled: true, password_set: true };
    else if (path === "/setup/readiness") body = { status: "ok", data: { checks: [], blocking: [] } };
    else if (path === "/operator/overview") body = { status: "ok", data: { attention: [], counts: {}, accounts: [], strategies: [] } };
    else if (path === "/operator/nav") body = { ok: true, data: { primary: [], advanced: [] }, primary: [], advanced: [] };
    else if (path === "/health") body = { status: "ok" };
    else if (path === "/workspace") body = { root: "fixture", live_trading_enabled: false, kill_switch: false };
    else if (path === "/accounts/list") body = { accounts: [], ts: 0 };
    else if (path === "/portfolio/summary") body = { accounts: [], totals: { cash_usd: 0, equity_usd: 0 } };
    else if (path === "/portfolio/pnl") body = { equity_usd: 0, realized_usd: 0, total_pnl_usd: 0 };
    else if (path === "/agent/stream/events") body = { events: [], latest_seq: 0, cursor: 0, count: 0 };
    else if (path === "/agent/sessions") body = { sessions: [{ session_id: "ref-history", meta: { title: "Evidence review" }, source: "dashboard", message_count: 2 }], has_more: false };
    else if (path === "/agent/session") body = { error: "fixture session not persisted" };
    else if (path === "/agent/session/transcript") body = { ok: true, session_id: "ref-history", messages: [{ role: "user", content: "Verify source evidence" }, { role: "assistant", content: "Prior session evidence" }], count: 2 };
    else if (path === "/skills") body = { skills };
    else if (path === "/skills/detail") body = { ok: true, skill: { ...skills.find(skill => skill.id === url.searchParams.get("skill_id")), instructions: "Use primary evidence; cite the source. No trading authorization." } };
    else if (path === "/teams/roles") body = { ok: true, roles: [{ name: "reviewer", prompt_path: "agents/reviewer.md", description: "Review evidence" }] };
    else if (path === "/teams/role/get") body = { ok: true, role: { name: "reviewer", prompt: "Review the supplied evidence and report uncertainty.", allowed_skills: ["research"] } };
    else if (path === "/skills/call") body = request.postDataJSON().action === "get_subagent"
      ? { name: "reviewer", body: "Review the supplied evidence and report uncertainty." }
      : { subagents: [{ name: "reviewer", path: "agents/reviewer.md" }] };
    else if (path === "/strategy/list_all") body = { strategies: [{ id: "alpha", title: "Alpha research strategy", status: "draft", markets: [] }] };
    else if (path === "/strategy/get") body = { strategy: { id: "alpha", title: "Alpha research strategy", status: "draft" }, main_prompt: "Read-only strategy review" };
    else if (path === "/strategy/list") body = { strategies: [] };
    else if (path === "/workspace/files") body = { ok: true, path: url.searchParams.get("path"), entries: url.searchParams.get("path") === "memory"
      ? [{ name: "决策 记录.md", path: "memory/决策 记录.md", kind: "file", size: 80 }]
      : [{ name: "notes.md", path: "notes.md", kind: "file", size: 60 }, { name: "memory", path: "memory", kind: "dir" }, { name: "binary.png", path: "binary.png", kind: "file", size: 100 }] };
    else if (path === "/workspace/file") {
      if (state.failReads > 0) { state.failReads--; await route.fulfill({ status: 503, json: { ok: false } }); return; }
      body = url.searchParams.get("path") === "binary.png" ? { ok: true, binary: true } : { ok: true, content: "Verified workspace evidence: selected context reached the model.", truncated: false };
    } else if (path === "/agent/attachments/upload") {
      const files = request.postDataJSON().attachments as ChatAttachment[];
      state.uploads.push(files);
      body = { ok: true, attachments: files.map(({ data_url: _data, text: _text, reference: _ref, ...file }) => ({ ...file, uploaded: true, artifact_uri: `artifact://fixture/${file.id}` })) };
    } else if (path === "/agent/run_turn_internal") {
      state.turns.push(request.postDataJSON());
      body = { status: "ok", turn_id: "fixture-turn", decision: { action: "respond", text: "Composer fixture reply" }, actions: [], artifacts: [] };
    }
    // No fixture request may fall through to the real runtime.
    await route.fulfill({ status: 200, json: body });
  });
  await installCommandFixture(page,{ complete:true,onSend:body=>state.turns.push(body) });
  return state;
}

async function start(page: Page, path = "/chat") {
  await page.goto(path);
  await expect(input(page)).toBeVisible();
}

test("trigger grammar: aliases, IME-adjacent Chinese, email, paths and code", () => {
  for (const text of ["\\research", "/research", "use @notes", "参考@notes", "参考@notes.md"]) expect(composerTrigger(text, text.length)).not.toBeNull();
  for (const text of ["user@example.com", "C:\\Users\\rick", "https://example.com", "`@notes", "```ts\n@notes"]) expect(composerTrigger(text, text.length)).toBeNull();
  expect(composerTrigger("@notes", 1, 6)).toBeNull();
  expect(composerFileQuery("../secrets/", ".")).toEqual({ path: ".", query: "../secrets/" });
});

test("caret completion preserves suffix and ranks closest real source", () => {
  const text = "Prefix /research suffix";
  const trigger = composerTrigger(text, 11)!;
  expect(replaceComposerTrigger(text, trigger, "Use research", "research").text).toBe("Prefix Use research suffix");
  const bare = "@keep this text";
  expect(replaceComposerTrigger(bare, composerTrigger(bare, 1)!, "", "notes.md").text).toBe("keep this text");
  const list = [{ key: "1", kind: "skill" as const, id: "meta-research", label: "Other", detail: "" }, { key: "2", kind: "skill" as const, id: "research", label: "Research", detail: "" }];
  expect(filterComposerOptions(list, "research")[0].id).toBe("research");
});

for (const mark of ["\\", "/"]) test(`${mark} opens real skills; Enter selects without sending`, async ({ page }, info) => {
  const state = await fixture(page); await start(page);
  await input(page).fill(mark + "research");
  await expect(panel(page).getByRole("option")).toHaveCount(1);
  await expect(input(page)).toBeFocused();
  await page.screenshot({ path: info.outputPath("command-picker.png") });
  await input(page).press("Enter");
  await expect(chip(page, "research")).toBeVisible();
  await expect(input(page)).toHaveValue("Use the research skill for this task: ");
  expect(state.turns).toHaveLength(0);
  expect(JSON.parse(state.uploads[0][0].text!).content).toContain("Use primary evidence");
  expect(state.errors).toEqual([]);
});

test("arrow wrap, Tab selection, Escape dismissal and empty Enter", async ({ page }) => {
  const state = await fixture(page); await start(page);
  await input(page).fill("\\");
  await expect(panel(page).getByRole("option")).toHaveCount(3);
  await input(page).press("ArrowUp");
  await expect(panel(page).getByRole("option", { selected: true })).toHaveAttribute("data-reference-id", "reviewer");
  await input(page).press("Tab");
  await expect(chip(page, "reviewer")).toBeVisible();
  await input(page).fill("@notes"); await expect(panel(page)).toBeVisible();
  await input(page).press("Escape"); await expect(panel(page)).toHaveCount(0);
  await input(page).press("ArrowLeft");
  await input(page).fill("@zzzzzzzz"); await expect(panel(page).getByText("No matching sources")).toBeVisible();
  await input(page).press("Enter"); await expect(input(page)).toHaveValue("@zzzzzzzz");
  expect(state.turns).toHaveLength(0);
  expect(state.errors).toEqual([]);
});

test("IME composition and ordinary text never select or send accidentally", async ({ page }) => {
  const state = await fixture(page); await start(page);
  await input(page).fill("@notes"); await expect(panel(page)).toBeVisible();
  await input(page).dispatchEvent("compositionstart");
  await input(page).dispatchEvent("keydown", { key: "Enter", isComposing: true, keyCode: 229 });
  expect(state.uploads).toHaveLength(0); expect(state.turns).toHaveLength(0);
  await input(page).dispatchEvent("compositionend");
  await input(page).fill("user@example.com"); await expect(panel(page)).toHaveCount(0);
  await input(page).press("Shift+Enter"); await expect(input(page)).toHaveValue("user@example.com\n");
  expect(state.turns).toHaveLength(0);
});

test("folders, spaced Unicode names, deduplication and removable context", async ({ page }) => {
  const state = await fixture(page); await start(page);
  await input(page).fill("@");
  await panel(page).locator('[data-reference-id="memory"]').click();
  await expect(panel(page).getByRole("button", { name: "Parent folder" })).toBeVisible();
  await panel(page).locator('[data-reference-id="memory/决策 记录.md"]').click();
  await expect(chip(page, "memory/决策 记录.md")).toBeVisible();
  await input(page).fill("@memory/");
  await panel(page).locator('[data-reference-id="memory/决策 记录.md"]').click();
  await expect(chip(page, "memory/决策 记录.md")).toHaveCount(1);
  expect(state.uploads).toHaveLength(1);
  await chip(page, "memory/决策 记录.md").getByTestId("reference-snapshot-trigger").click();
  await expect(page.getByRole("dialog")).toContainText("Immutable evidence at selection time.");
  await page.getByRole("button",{name:"Close snapshot"}).click();
  await chip(page, "memory/决策 记录.md").getByRole("button",{name:"Remove context: 决策 记录.md"}).click();
  await expect(chip(page, "memory/决策 记录.md")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  expect(state.errors).toEqual([]);
});

test("home handoff sends the exact referenced artifact once, not just its name", async ({ page }) => {
  const state = await fixture(page); await start(page, "/");
  await input(page).fill("@notes");
  await panel(page).getByRole("option").click();
  await expect(chip(page, "notes.md")).toBeVisible();
  await input(page).fill("Analyze the selected context."); await input(page).press("Enter");
  await expect.poll(() => state.turns.length).toBe(1);
  const attachment = state.turns[0].payload.attachments[0];
  expect(attachment.artifact_uri).toBe(`artifact://fixture/${state.uploads[0][0].id}`);
  expect(attachment.text).toBeUndefined(); expect(attachment.data_url).toBeUndefined();
  expect(JSON.parse(state.uploads[0][0].text!).content).toContain("Verified workspace evidence");
  expect(state.turns[0].payload.text).toBe("Analyze the selected context.");
  expect(state.errors).toEqual([]);
});

test("failed reference preserves draft, blocks send and supports retry", async ({ page }) => {
  const state = await fixture(page, { failReadOnce: true }); await start(page);
  await input(page).fill("Keep this draft @notes"); await panel(page).getByRole("option").click();
  await expect(page.locator("[data-chat-composer]").getByRole("alert")).toBeVisible();
  await expect(input(page)).toHaveValue("Keep this draft ");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.locator("[data-chat-composer]").getByRole("button", { name: "Retry", exact: true }).click();
  await expect(chip(page, "notes.md")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  expect(state.uploads).toHaveLength(1); expect(state.turns).toHaveLength(0);
});

test("+ opens a real menu, restores focus and routes to the same picker", async ({ page }, info) => {
  const state = await fixture(page); await start(page);
  await input(page).fill("Keep my draft");
  await page.getByTestId("composer-add").click();
  await expect(page.getByRole("menuitem")).toHaveCount(4);
  await page.screenshot({ path: info.outputPath("add-menu.png") });
  await page.getByRole("menuitem", { name: "Reference context" }).click();
  await expect(panel(page)).toBeVisible(); await expect(input(page)).toBeFocused();
  await expect(input(page)).toHaveValue("Keep my draft @");
  await input(page).press("Escape");
  await page.getByTestId("composer-add").click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Upload images" }).click();
  await (await chooser).setFiles({ name: "image.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6t14AAAAASUVORK5CYII=", "base64") });
  await expect(page.locator("[data-chat-composer]").getByText("image.png", { exact: true })).toBeVisible();
  expect(state.uploads).toHaveLength(1); expect(state.turns).toHaveLength(0);
  expect(state.errors).toEqual([]);
});

test("drop and paste share the actual upload path without replacing text", async ({ page }) => {
  const state = await fixture(page); await start(page);
  await input(page).fill("Keep text");
  await page.locator("[data-chat-composer]").evaluate(element => {
    const transfer = new DataTransfer(); transfer.items.add(new File(["Drop evidence"], "drop.txt", { type: "text/plain" }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.locator("[data-chat-composer]").getByText("drop.txt", { exact: true })).toBeVisible();
  await input(page).evaluate(element => {
    const transfer = new DataTransfer(); transfer.items.add(new File(["Paste evidence"], "paste.txt", { type: "text/plain" }));
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  });
  await expect(page.locator("[data-chat-composer]").getByText("paste.txt", { exact: true })).toBeVisible();
  await expect(input(page)).toHaveValue("Keep text");
  expect(state.uploads).toHaveLength(2); expect(state.turns).toHaveLength(0);
});

test("binary source reports the limitation without uploading an empty context", async ({ page }) => {
  const state = await fixture(page); await start(page);
  await input(page).fill("Keep my question @binary");
  await panel(page).getByRole("option").click();
  await expect(page.locator("[data-chat-composer]").getByRole("alert")).toContainText("cannot be referenced as text");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  expect(state.uploads).toHaveLength(0);
  await page.locator("[data-chat-composer]").getByRole("button", { name: "Close", exact: true }).click();
  await expect(input(page)).toHaveValue("Keep my question ");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  expect(state.turns).toHaveLength(0);
});

test("strategy and conversation selections attach their actual bounded source content", async ({ page }) => {
  const state = await fixture(page); await start(page);
  await input(page).fill("@alpha"); await panel(page).locator('[data-reference-kind="strategy"]').click();
  await expect(chip(page, "alpha")).toBeVisible();
  expect(JSON.parse(state.uploads[0][0].text!).content).toContain("Read-only strategy review");
  await input(page).fill("@Evidence review");
  // Queries are tokens; use a shorter fragment for a spaced title.
  await input(page).fill("@Evidence"); await panel(page).locator('[data-reference-kind="session"]').click();
  await expect(chip(page, "ref-history")).toBeVisible();
  const snapshot = JSON.parse(state.uploads[1][0].text!);
  expect(snapshot.content).toContain("Prior session evidence");
  expect(snapshot.reference.truncated).toBe(true);
  expect(state.turns).toHaveLength(0); expect(state.errors).toEqual([]);
});

test("cancelling pending context prevents a late response from reattaching it", async ({ page }) => {
  const state = await fixture(page); await start(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/workspace/file?**", async route => {
    await gate;
    await route.fulfill({ json: { ok: true, content: "Late source response" } }).catch(() => undefined);
  });
  await input(page).fill("Keep draft @notes"); await panel(page).getByRole("option").click();
  await expect(page.locator("[data-chat-composer]").getByRole("status")).toContainText("Adding context");
  await page.locator("[data-chat-composer]").getByRole("button", { name: "Cancel", exact: true }).click();
  release();
  await expect(input(page)).toHaveValue("Keep draft ");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await input(page).fill("@coding"); await panel(page).getByRole("option").click();
  await expect(chip(page, "coding")).toBeVisible();
  await expect(chip(page, "notes.md")).toHaveCount(0);
  expect(state.uploads).toHaveLength(1); expect(state.turns).toHaveLength(0);
});

for (const width of [320, 390, 1440]) test(`reference picker fits ${width}px without moving composer`, async ({ page }, info) => {
  const state = await fixture(page, { language: "zh", theme: width === 390 ? "light" : "dark" });
  await page.setViewportSize({ width, height: 900 }); await start(page);
  const before = await page.locator("[data-chat-composer]").boundingBox();
  await input(page).fill("@"); await expect(panel(page).getByRole("option").first()).toBeVisible();
  const after = await page.locator("[data-chat-composer]").boundingBox();
  expect(Math.abs(before!.y - after!.y)).toBeLessThan(2);
  const box = await panel(page).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(901);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`context-${width}.png`), fullPage: true });
  expect(state.errors).toEqual([]);
});
