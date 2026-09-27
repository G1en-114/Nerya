/** Isolated UI fixture using the real Python catalog, never a running workspace.
 * Run with ego-browser; import installFixture in the task's existing space.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function fixture(data) {
  const state = window.__catalogFixture = { errors: [], writes: [], failCatalog: false, failRead: false };
  localStorage.setItem("nerya.ui_settings.v1", JSON.stringify({ language: data.locale, darkMode: "dark", refreshSeconds: 0 }));
  window.addEventListener("error", event => state.errors.push(event.message));
  window.addEventListener("unhandledrejection", event => state.errors.push(String(event.reason)));
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url || String(input), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return original(input, init);
    const path = url.pathname.replace(/^\/api\/proxy/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const query = Object.fromEntries(url.searchParams);
    let value = { ok: true, data: {}, items: [], events: [], accounts: [], sessions: [], approvals: [], installed: [], entries: [], total: 0, has_more: false };
    if (path === "/skills/catalog") {
      if (state.failCatalog) return Response.json({ error: "Catalog fixture unavailable" }, { status: 503 });
      const search = (query.query || "").toLowerCase();
      let rows = search || query.parent || query.view === "all" ? data.all.skills : data[query.view || "all"].skills;
      if (query.parent) rows = rows.filter(row => row.catalog_parent === query.parent);
      if (search) rows = rows.filter(row => `${row.id} ${row.description}`.toLowerCase().includes(search));
      const offset = Number(query.offset || 0), limit = Number(query.limit || 100);
      value = { ...data.all, total: rows.length, skills: rows.slice(offset, offset + limit), next_offset: offset + limit < rows.length ? offset + limit : null };
    } else if (path === "/skills/read") {
      if (state.failRead) return Response.json({ error: "Read fixture unavailable" }, { status: 503 });
      value = data.files[query.skill_id] || { ok: false, error: "Not included in UI fixture" };
    } else if (path === "/skills/manage") {
      state.writes.push({ path, body });
      return Response.json({ error: "Proposal fixture rejected; draft must survive" }, { status: 409 });
    } else if (path === "/teams/roles" || path === "/mcp-settings/roles") value = { ok: true, roles: data.roles };
    else if (path === "/teams/role/get") value = { ok: true, role: data.details[body.name] };
    else if (path === "/skills") value = { ok: true, skills: data.all.skills };
    else if (path === "/auth/status") value = { ok: true, authenticated: true, enabled: true, password_set: true };
    else if (path === "/workspace") value = { root: "catalog-ui-fixture", live_trading_enabled: false, kill_switch: false };
    else if (path === "/operator/nav") value = { ok: true, data: { primary: [], advanced: [], hidden: [] } };
    else if (path === "/llm/config") value = { ok: true, tiers: [], provider_profiles: [], default_tier: "medium" };
    else if (path === "/llm/tiers") value = { tiers: [] };
    return Response.json(value);
  };
}

export async function installFixture(page, locale = "en") {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const workspace = await mkdtemp(join(tmpdir(), "nerya-catalog-ui-"));
  const data = JSON.parse(execFileSync(join(root, ".venv/bin/python"), ["-B", "-c", `
import json, os, sys
from pathlib import Path
from types import SimpleNamespace
from nerya.core.paths import WorkspacePaths
from nerya.skills import management
from nerya.subagents.registry import list_roles, describe_role
os.environ['NERYA_USER_SKILLS_ROOT'] = sys.argv[1] + '/user-skills'
config = SimpleNamespace(paths=WorkspacePaths(Path(sys.argv[1])))
data = {view: management.catalog(config, view=view, limit=200) for view in ('core', 'professional', 'all')}
data['roles'] = list_roles(config.paths)
data['details'] = {role['name']: describe_role(config.paths, role['name']) for role in data['roles']}
data['files'] = {name: management.read(config, name, limit=32000) for name in ('research', 'self_modify', 'triggers')}
print(json.dumps(data))
`, workspace], { cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }));
  const result = await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(${fixture.toString()})(${JSON.stringify({ ...data, locale })});` });
  return result.identifier;
}

export async function verifyCatalog(page, artifactDir) {
  await mkdir(artifactDir, { recursive: true });
  const view = 'select:has(option[value="professional"])';
  const count = () => page.evaluate(() => document.querySelectorAll('[data-testid="skill-catalog"] > [data-skill-id]').length);
  const wait = text => page.waitForFunction(value => document.body.innerText.includes(value), text);
  await wait("13 workflows");
  await page.waitForSelector('[data-testid="skill-catalog"] > [data-skill-id]');
  assert.equal(await count(), 13);
  await page.screenshot({ path: join(artifactDir, "skills-common-desktop.png"), fullPage: true });
  await page.click('[aria-controls="methods-evolve"]');
  await page.waitForSelector('[id="methods-evolve"] [data-skill-id="self_modify"]');
  await page.click('loc=role:button[name="self_modify"]');
  await page.waitForFunction(() => document.querySelector("textarea")?.value.includes("# Self Modify"));
  await page.selectOption(view, "professional"); await wait("7 workflows");
  assert.equal(await count(), 7);
  await page.selectOption(view, "all"); await wait("96 entries");
  assert.equal(await count(), 30);
  const first = await page.evaluate(() => document.querySelector('[data-testid="skill-catalog"] > [data-skill-id]')?.getAttribute("data-skill-id"));
  await page.click('loc=role:button[name="Next page"]');
  await page.waitForFunction(previous => document.querySelector('[data-testid="skill-catalog"] > [data-skill-id]')?.getAttribute("data-skill-id") !== previous, first);
  await page.fill('input[placeholder="Search all names, methods and descriptions"]', "self_modify");
  await page.click('loc=role:button[name="Search Skills"]'); await wait("1 entry");
  assert.equal(await count(), 1);
  assert((await page.evaluate(() => document.body.innerText)).includes("Part of evolve"));
  await page.fill('input[placeholder="Search all names, methods and descriptions"]', "");
  await page.click('loc=role:button[name="Search Skills"]'); await wait("96 entries");
  await page.selectOption(view, "core"); await wait("13 workflows");

  await page.evaluate(() => { window.__catalogFixture.failCatalog = true; });
  await page.click('loc=role:button[name="Refresh"]'); await wait("Catalog fixture unavailable");
  assert.equal(await count(), 0, "failed requests must not show stale entries");
  await page.evaluate(() => { window.__catalogFixture.failCatalog = false; });
  await page.click('loc=role:button[name="Refresh"]'); await wait("13 workflows");
  await page.click('loc=role:button[name="research"]');
  await page.waitForFunction(() => document.querySelector("textarea")?.value.includes("# Research"));
  const draft = await page.evaluate(() => document.querySelector("textarea").value + "\nDraft retained by catalog QA.\n");
  await page.fill("textarea", draft);
  assert.equal(await page.evaluate(selector => document.querySelector(selector).matches(":disabled"), view), true);
  await page.click('loc=role:button[name="Installation and advanced tools"]');
  await wait("Back to workflows");
  await page.click('loc=role:button[name="Back to workflows"]');
  assert.equal(await page.evaluate(() => document.querySelector("textarea").value), draft);
  assert.deepEqual(await page.evaluate(() => window.__catalogFixture.writes), []);
  assert.deepEqual(await page.evaluate(() => window.__catalogFixture.errors), []);
  console.log({ catalogChecks: "core, professional, expansion, exact read, pagination, search, error recovery, retained draft", passed: true });
}

export async function verifyAgents(page, artifactDir) {
  await mkdir(artifactDir, { recursive: true });
  const rows = () => page.evaluate(() => document.querySelectorAll('ul[aria-label="Agents"] > li').length);
  await page.waitForFunction(() => document.querySelectorAll('ul[aria-label="Agents"] > li').length === 7);
  assert.equal(await rows(), 7);
  await page.waitForFunction(() => document.querySelector('[data-testid="agent-overview"]')?.textContent.includes("Implement the assigned"));
  await page.screenshot({ path: join(artifactDir, "agents-common-desktop.png"), fullPage: true });
  await page.click('input[type="checkbox"]');
  assert.equal(await rows(), 33);
  await page.click('input[type="checkbox"]');
  assert.equal(await rows(), 7);
  await page.fill('input[placeholder="Search agents or skills"]', "bull_researcher");
  assert.equal(await rows(), 1);
  await page.fill('input[placeholder="Search agents or skills"]', "");
  assert.equal(await rows(), 7);
  assert.deepEqual(await page.evaluate(() => window.__catalogFixture.errors), []);
  assert.deepEqual(await page.evaluate(() => window.__catalogFixture.writes), []);
  console.log({ agentChecks: "7 default roles, 33 exact profiles, legacy search, distinct responsibility", passed: true });
}
