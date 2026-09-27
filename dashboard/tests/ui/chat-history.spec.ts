import { test, expect, type Page } from "@playwright/test";

type Message = { message_id: string; role: "user" | "assistant"; content: string; ts: string; meta: Record<string, unknown> };
async function fixture(page: Page, theme = "dark") {
  const records = new Map(["history-a", "history-b"].map((id, i) => [id, {
    session_id: id, source: "user_chat", title: i ? "Second conversation" : "First conversation",
    updated_at: "2026-09-24T10:00:00Z", created_at: "2026-09-24T09:00:00Z",
    messages: [
      { message_id: `${id}:user`, role: "user", content: i ? "Second question" : "Original question", ts: "2026-09-24T09:00:00Z", meta: { attachments: [{ id: "evidence", name: "evidence.txt", mime_type: "text/plain", size: 12, artifact_uri: "nerya://artifact/fixture/evidence.txt" }] } },
      { message_id: `${id}:assistant`, role: "assistant", content: "Existing reply must stay unchanged.", ts: "2026-09-24T09:00:01Z", meta: {} },
    ] as Message[],
  }]));
  const state = { records, writes: [] as { path: string; body: Record<string, string> }[], calls: [] as string[], errors: [] as string[], fail: "", gate: null as Promise<void> | null };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.addInitScript(theme => { localStorage.setItem("nerya.ui_settings.v1", JSON.stringify({ language: "en", darkMode: theme })); }, theme);
  const tiers = ["light", "medium", "high", "intent"].map(tier => ({ tier, provider: "openai", model: "fixture-model", key_ref: "fixture" }));
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace(/^\/api\/proxy/, "");
    state.calls.push(path);
    let body: unknown = { ok: true, items: [], count: 0, total: 0 };
    const record = records.get(url.searchParams.get("session_id") || "");
    if (/^\/agent\/session\/(message\/(edit|delete)|rename|delete)$/.test(path)) {
      const payload = request.postDataJSON() as Record<string, string>;
      state.writes.push({ path, body: payload });
      if (state.gate) await state.gate;
      if (state.fail) { await route.fulfill({ json: { ok: false, code: state.fail, error: state.fail } }); return; }
      const current = records.get(payload.session_id);
      if (!current) body = { ok: false, code: "session_deleted" };
      else if (path.endsWith("/rename")) { current.title = payload.title; body = { ok: true, title: current.title, session_id: current.session_id }; }
      else if (path === "/agent/session/delete") { records.delete(payload.session_id); body = { ok: true, session_id: payload.session_id, deleted: true }; }
      else {
        const message = current.messages.find(row => row.message_id === payload.message_id);
        if (!message) body = { ok: false, code: "message_not_found" };
        else if (message.content !== payload.expected_content) body = { ok: false, code: "message_conflict" };
        else {
          if (path.endsWith("/edit")) { message.content = payload.content; message.meta.edited_at = Date.now() / 1000; }
          else current.messages = current.messages.filter(row => row !== message);
          current.updated_at = new Date().toISOString();
          body = { ok: true, session_id: payload.session_id, message_id: payload.message_id, content: message.content, edited_at: message.meta.edited_at };
        }
      }
    } else if (path === "/auth/status") body = { ok: true, authenticated: true, local_access: true, enabled: true, password_set: true };
    else if (path === "/llm/config") body = { ok: true, default_tier: "medium", intent_tier: "light", tiers, provider_profiles: [], reasoning_levels: [] };
    else if (path === "/llm/tiers") body = { tiers, count: tiers.length };
    else if (path === "/llm/models") body = { providers: { openai: [{ id: "fixture-model" }] } };
    else if (path === "/setup/readiness") body = { status: "ok", data: { checks: [], blocking: [] } };
    else if (path === "/operator/nav") body = { ok: true, data: { primary: [], advanced: [] }, primary: [], advanced: [] };
    else if (path === "/operator/overview") body = { status: "ok", data: { attention: [], counts: {}, accounts: [], strategies: [] } };
    else if (path === "/health") body = { status: "ok" };
    else if (path === "/workspace") body = { root: "fixture", live_trading_enabled: false, kill_switch: false };
    else if (path === "/accounts/list") body = { accounts: [], ts: 0 };
    else if (path === "/portfolio/summary") body = { accounts: [], totals: { cash_usd: 0, equity_usd: 0 } };
    else if (path === "/portfolio/pnl") body = { equity_usd: 0, realized_usd: 0, total_pnl_usd: 0 };
    else if (path === "/agent/sessions") body = { sessions: [...records.values()].map(row => ({ ...row, messages: undefined, meta: { title: row.title }, message_count: row.messages.length })), has_more: false };
    else if (path === "/agent/session") body = record ? { ...record, meta: { title: record.title }, message_count: record.messages.length } : { error: "session not found" };
    else if (path === "/agent/session/transcript") body = record ? { ...record, ok: true, count: record.messages.length } : { ok: false, error: "session_deleted" };
    else if (path === "/agent/stream/events") body = { events: [], latest_seq: 0, cursor: 0, count: 0 };
    else if (path === "/agent/commands") body = { ok:true,commands:[],queue:{paused:false,pause_reason:"",revision:1} };
    else if (path === "/agent/open_turns") body = { open_turns: [] };
    else if (path.includes("approvals")) body = { approvals: [] };
    else if (path.includes("strategy/list")) body = { strategies: [] };
    else if (path === "/skills") body = { skills: [{ id: "research", title: "Research", status: "ready" }] };
    else if (path === "/teams/roles") body = { ok: true, roles: [] };
    else if (path === "/workspace/files") body = { ok: true, entries: [] };
    // Never forward an unexpected read/write to the real runtime.
    await route.fulfill({ json: body });
  });
  return state;
}
const composer = (page: Page) => page.locator("[data-chat-composer] textarea");
const user = (page: Page) => page.locator('[data-turn-role="user"]').first();
const editor = (page: Page) => page.getByTestId("message-editor");
async function open(page: Page) { await page.goto("/chat/history-a"); await expect(user(page)).toContainText("Original question"); }
async function edit(page: Page) { await user(page).getByRole("button", { name: "Edit message", exact: true }).click(); await expect(editor(page).getByRole("textbox")).toBeFocused(); }

test("edit failure retains draft, success persists across refresh without rerunning", async ({ page }) => {
  const state = await fixture(page); await open(page); await edit(page);
  await expect(editor(page).getByRole("button", { name: "Save changes" })).toBeDisabled();
  await expect(user(page)).toContainText("evidence.txt");
  await editor(page).getByRole("textbox").fill("Corrected question");
  state.fail = "history_write_failed";
  await editor(page).getByRole("button", { name: "Save changes" }).click();
  await expect(editor(page).getByRole("alert")).toContainText("not confirmed");
  await expect(editor(page).getByRole("textbox")).toHaveValue("Corrected question");
  expect(state.records.get("history-a")!.messages[0].content).toBe("Original question");
  state.fail = "";
  await editor(page).getByRole("button", { name: "Save changes" }).click();
  await expect(editor(page)).toHaveCount(0); await expect(user(page)).toContainText("Corrected question");
  await page.reload(); await expect(user(page)).toContainText("Corrected question"); await expect(user(page)).toContainText("Edited");
  expect(state.calls.filter(path => /run_turn/.test(path))).toEqual([]); expect(state.errors).toEqual([]);
});

test("editor IME and pending save cannot trigger duplicate requests", async ({ page }) => {
  const state = await fixture(page); await open(page); await edit(page);
  const field = editor(page).getByRole("textbox"); await field.fill("Chinese input 中文");
  await field.dispatchEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true }); expect(state.writes).toHaveLength(0);
  let release!: () => void; state.gate = new Promise(resolve => { release = resolve; });
  try {
    await field.press("Control+Enter"); await expect(editor(page).getByRole("button", { name: "Saving…" })).toBeDisabled();
    await field.dispatchEvent("keydown", { key: "Enter", ctrlKey: true });
    expect(state.writes).toHaveLength(1);
  } finally { release(); }
  await expect(editor(page)).toHaveCount(0); expect(state.errors).toEqual([]);
});

test("cancel editing asks before discarding changes", async ({ page }) => {
  const state = await fixture(page); await open(page); await edit(page);
  await editor(page).getByRole("textbox").fill("Unsaved revision");
  await editor(page).getByRole("button", { name: "Cancel", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Discard message edits?" });
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(editor(page).getByRole("textbox")).toHaveValue("Unsaved revision");
  await editor(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.getByRole("button", { name: "Discard edits", exact: true }).click();
  await expect(editor(page)).toHaveCount(0); await expect(user(page)).toContainText("Original question"); expect(state.writes).toHaveLength(0);
});

test("message deletion keeps target on failure and does not resurrect after refresh", async ({ page }) => {
  const state = await fixture(page); await open(page);
  await user(page).getByRole("button", { name: "Delete message", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete message", exact: true });
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await expect(dialog).toContainText("Original question");
  state.fail = "history_write_failed";
  await dialog.getByRole("button", { name: "Delete", exact: true }).click(); await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(user(page)).toContainText("Original question"); state.fail = "";
  await dialog.getByRole("button", { name: "Delete", exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-turn-role="user"]')).toHaveCount(0);
  await page.reload(); await expect(page.getByTestId("conversation-content").getByText("Existing reply must stay unchanged.", { exact: true })).toBeVisible();
  await expect(page.locator('[data-turn-role="user"]')).toHaveCount(0); expect(state.errors).toEqual([]);
});

test("conversation menu preserves failed deletion and renames without navigation", async ({ page }) => {
  const state = await fixture(page); await open(page);
  const menu = page.getByTestId("conversation-actions-history-a"); await menu.click();
  await page.getByRole("menuitem", { name: "Rename conversation" }).click();
  const rename = page.getByRole("dialog", { name: "Rename conversation" });
  await rename.getByRole("textbox").fill("Updated conversation title"); await rename.getByRole("button", { name: "Save changes" }).click();
  await expect(rename).toHaveCount(0); await expect(page.locator('a[href="/chat/history-a"]').filter({ hasText: "Updated conversation title" })).toBeVisible();
  await menu.click(); await page.getByRole("menuitem", { name: "Delete conversation" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete conversation" }); state.fail = "history_write_failed";
  await dialog.getByRole("button", { name: "Delete", exact: true }).click(); await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/history-a$/); await expect(user(page)).toContainText("Original question");
  state.fail = ""; await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(/\/chat$/); await expect(page.getByTestId("conversation-actions-history-a")).toHaveCount(0); expect(state.errors).toEqual([]);
});

test("drafts remain separate across navigation and reload", async ({ page }) => {
  const state = await fixture(page); await open(page);
  await composer(page).fill("Draft A stays here");
  await page.locator('a[href="/chat/history-b"]').click(); await expect(composer(page)).toHaveValue("");
  await composer(page).fill("Draft B stays there");
  await page.locator('a[href="/chat/history-a"]').click(); await expect(composer(page)).toHaveValue("Draft A stays here");
  await page.reload(); await expect(composer(page)).toHaveValue("Draft A stays here"); expect(state.writes).toHaveLength(0); expect(state.errors).toEqual([]);
});

for (const width of [320, 390]) test(`editor and confirmation fit ${width}px light mode`, async ({ page }, info) => {
  const state = await fixture(page, "light"); await page.setViewportSize({ width, height: 844 }); await open(page); await edit(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`edit-${width}.png`), fullPage: true });
  await editor(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await user(page).getByRole("button", { name: "Delete message", exact: true }).click();
  const box = await page.getByRole("dialog").boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  await page.screenshot({ path: info.outputPath(`confirmation-${width}.png`), fullPage: true }); expect(state.errors).toEqual([]);
});

test("Escape dismissal resets when a new trigger is typed; hints stay in placeholder", async ({ page }) => {
  await fixture(page); await open(page); const field = composer(page);
  await expect(field).toHaveAttribute("placeholder", /@.*\\/);
  await expect(page.locator('[id$="-hints"]')).toHaveCount(0);
  await field.fill("@"); await expect(page.getByTestId("composer-suggestions")).toBeVisible();
  await field.press("Escape"); await expect(page.getByTestId("composer-suggestions")).toHaveCount(0);
  await field.fill(""); await field.fill("@"); await expect(page.getByTestId("composer-suggestions")).toBeVisible();
});
