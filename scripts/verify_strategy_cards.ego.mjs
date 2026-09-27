// Run from the project root through ego-browser nodejs; resume an existing
// agent-owned TaskSpace. Real persisted results only; no route mocks or orders.
const fs = await import('node:fs/promises');
const assert = (await import('node:assert/strict')).default;
const root = '/Users/rick/Documents/Project/Nerya/ui-review/strategy-e2e-20260926';
const primary = JSON.parse(await fs.readFile(`${root}/primary-acceptance.json`, 'utf8'));
assert.equal(primary.ok, true, 'Run main-workspace acceptance first');
// This acceptance record resumes the server-returned space id for this task.
// ego-browser runs code in its own Node host; shell env is not forwarded.
const task = await taskSpace(28);
const page = task.page('p1');
const evidence = { baseUrl: primary.base_url, createdAt: new Date().toISOString(), cases: {}, ok: false };
const save = () => fs.writeFile(`${root}/browser-acceptance.json`, JSON.stringify(evidence, null, 2));
for (const [mode, row] of Object.entries(primary.cases)) {
  const selector = `[data-testid="backtest-result-card"][data-backtest-id="${row.proposal_id}:${row.strategy_id}:${row.backtest.backtest_ts}"]`;
  await page.goto(`${primary.base_url}/chat/${row.session_id}`);
  await page.waitForSelector(selector, { state: 'visible', timeout: 30000 });
  const observed = await page.evaluate(({ selector, proposalId }) => {
    const card = document.querySelector(selector);
    return { proposalCount: document.querySelectorAll(`[data-testid="strategy-proposal-card"][data-proposal-id="${proposalId}"]`).length,
      status: card.dataset.status, evaluation: card.dataset.evaluation,
      metrics: Object.fromEntries([...card.querySelectorAll('[data-metric]')].map(e => [e.dataset.metric, e.textContent])),
      text: card.innerText, pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
  }, { selector, proposalId: row.proposal_id });
  assert.equal(observed.proposalCount, 1, 'Latest candidate card must be visible exactly once');
  assert.equal(observed.status, 'completed');
  assert.equal(observed.evaluation, mode === 'script' ? 'trading' : 'observation');
  assert.equal(observed.pageOverflow, false);
  if (mode === 'script') assert.equal(observed.metrics.total_return_pct, row.backtest.metrics_display.total_return_pct);
  else {
    assert.equal(observed.metrics.dispatches, String(row.backtest.replay.dispatches));
    assert(!('total_return_pct' in observed.metrics));
    assert.match(observed.text, /Agent model not executed|未执行 Agent 模型/);
  }
  // Observe before selecting report controls, then verify the real chart API.
  console.log('CARD', mode, observed);
  await page.click(`${selector} [data-testid="open-backtest-report"]`);
  await page.waitForSelector(`${selector} [data-testid="backtest-report"]`, { state: 'visible', timeout: 30000 });
  await page.evaluate(selector => document.querySelector(`${selector} [data-testid="backtest-report"]`).scrollIntoView({ block: 'start' }), selector);
  console.log(await page.snapshot());
  // Observation reports intentionally have no profit/trade tabs: event
  // evidence is shown directly instead of an empty PnL dashboard.
  if (mode === 'script') await page.click(`${selector} [role="tab"] >> nth=1`);
  const reportScope = `${selector} ${mode === 'script' ? '[role="tabpanel"]:not([hidden])' : '[data-testid="backtest-report"]'}`;
  await page.waitForSelector(`${reportScope} table`, { state: 'visible', timeout: 30000 });
  const report = await page.evaluate(({selector, reportScope}) => {
    const panel = document.querySelector(reportScope);
    const button = document.querySelector(`${selector} [data-testid="open-backtest-report"]`);
    return { columns: [...panel.querySelectorAll('th')].map(e=>e.textContent), rows: panel.querySelectorAll('tbody tr').length,
      expanded: button.getAttribute('aria-expanded'), text: panel.innerText.slice(0,1200) };
  }, {selector, reportScope});
  assert(report.rows > 0, 'Report must contain persisted trade/event evidence');
  assert.equal(report.expanded, 'true');
  await page.screenshot({ path: `${root}/main-${mode}-verified.png` });
  // Collapse is a real user click: catch chart canvases covering its controls.
  // Reports can be taller than the viewport; bring the actual control back
  // into view, then use a real pointer click, never invoke the handler in JS.
  await page.evaluate(selector => document.querySelector(`${selector} [data-testid="open-backtest-report"]`).scrollIntoView({ block: 'center' }), selector);
  await page.click(`${selector} [data-testid="open-backtest-report"]`);
  await page.waitForSelector(`${selector} [data-testid="backtest-report"]`, { state: 'detached' });
  await page.reload();
  await page.waitForSelector(selector, { state: 'visible', timeout: 30000 });
  evidence.cases[mode] = { sessionId: row.session_id, proposalId: row.proposal_id, backtestTs: row.backtest.backtest_ts,
    ...observed, report, persistedAfterReload: true, collapseClickable: true, ok: true };
  await save();
  console.log('BROWSER_OK', mode);
}
evidence.ok = true;
await save();
console.log('BROWSER_ACCEPTANCE', evidence.ok);
