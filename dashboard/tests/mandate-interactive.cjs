// Manual local integration check: requires an isolated Python API.
// Never point SAFETY_TEST_API at a production service.
const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const api = process.env.SAFETY_TEST_API;
  if (!api || !/^http:\/\/127\.0\.0\.1:\d+$/.test(api)) throw Error('Set SAFETY_TEST_API to an isolated loopback API');
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('nerya.ui_settings.v1', JSON.stringify({ language: 'en' })));
    await page.route('**/api/proxy/**', route => route.fulfill(route.request().url().includes('/auth/status')
      ? { json: { local_access: true } } : { status: 503, json: { error: 'Unrelated runtime API disabled in test' } }));
    await page.route('**/api/proxy/safety/demo/**', async route => {
      const endpoint = route.request().url().split('/api/proxy')[1];
      const response = await route.fetch({ url: api + endpoint });
      await route.fulfill({ response });
    });
    await page.goto('http://127.0.0.1:3001/dashboard/safety');
    const controls = page.getByTestId('mandate-playground');
    const run = controls.getByRole('button', { name: 'Run safety check', exact: true });
    await expect(run).toBeEnabled({ timeout: 20000 });
    await run.click();
    await expect(controls).toContainText('Run completed', { timeout: 60000 });
    await expect(page.getByTestId('safety-case-detail')).toContainText('Paper filled');
    await expect(page.getByTestId('live-demo-result')).toContainText('paper fill completed');
    const firstJob = await controls.getByTestId('demo-job-id').innerText();
    await page.reload();
    await expect(controls.getByTestId('demo-job-id')).toHaveText(firstJob);
    await expect(page.getByTestId('safety-case-detail')).toContainText('Paper filled');
    await controls.getByLabel('Permitted market', { exact: true }).selectOption('mock:ETH/USDT');
    await run.click();
    await expect(controls).toContainText('Run completed', { timeout: 60000 });
    await expect(page.getByTestId('safety-case-detail')).toContainText('market_not_allowed');
    await expect(page.getByTestId('live-demo-result')).toContainText('Rejected: request stopped');
    if (await controls.getByTestId('demo-job-id').innerText() === firstJob) throw Error('New run reused old job');
    await controls.getByRole('button', { name: 'Revoke, then attempt', exact: true }).click();
    await run.click();
    await expect(controls).toContainText('Run completed', { timeout: 60000 });
    await expect(page.getByTestId('safety-case-detail')).toContainText('mandate_revoked');
    await controls.getByRole('button', { name: 'All 7 cases', exact: true }).click();
    await run.click();
    await expect(controls).toContainText('Run completed', { timeout: 60000 });
    await expect(page.getByRole('button', { name: /0[1-7].*(ALLOW|DENY)/ })).toHaveCount(7);
    await controls.getByRole('button', { name: /^Continuous budget/ }).click();
    await run.click();
    await expect(controls).toContainText('Run completed', { timeout: 60000 });
    const budget = page.getByTestId('budget-evidence');
    await expect(budget.locator('li')).toHaveCount(3);
    await expect(budget.locator('li').nth(0)).toContainText('$119.00');
    await expect(budget.locator('li').nth(1)).toContainText('$18.00');
    await expect(budget.locator('li').nth(2)).toContainText('session_budget_exceeded');
    await expect(budget.locator('li').nth(2)).toContainText('No new order or fill');
    await page.getByRole('button', { name: /03.*Split orders/ }).click();
    await expect(page.getByTestId('safety-case-detail')).toContainText('action_not_anchored');
    await controls.getByRole('button', { name: /^Post-execution reconciliation/ }).click();
    await run.click();
    await expect(controls).toContainText('Run completed', { timeout: 60000 });
    const reconciliation = page.getByTestId('reconciliation-evidence');
    await expect(reconciliation).toContainText('position_fill_drift');
    await expect(reconciliation).toContainText('2 refusals verified');
    await expect(reconciliation).toContainText('Automatic recoveryDisabled');
    await page.reload();
    await expect(reconciliation).toContainText('stop remains active');
    // The displayed evidence download must retain the extended scenarios.
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download displayed evidence JSON', exact: true }).click();
    const download = await downloadPromise;
    const evidence = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    if (evidence.reconciliation.blockedAttempts !== 2 || !evidence.reconciliation.haltPersisted) throw Error('Missing persisted-stop evidence');
    if (!evidence.cases.filter(c => c.status === 'rejected').every(c => c.newOrders === 0 && c.newFills === 0 && c.reason === 'kill_switch_enabled')) throw Error('Stop did not prevent execution');
    await controls.getByRole('button', { name: 'Custom policy', exact: true }).click();
    await controls.getByRole('heading', { level: 2 }).scrollIntoViewIfNeeded();
    const dir = path.resolve(__dirname, '../../.tmp/safety-interactive-ui');
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, 'desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await reconciliation.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(dir, 'mobile.png') });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Mobile horizontal overflow');
    if (errors.length) throw Error(errors.join('\n'));
    await page.addInitScript(() => localStorage.setItem('nerya.ui_settings.v1', JSON.stringify({ language: 'zh' })));
    await page.reload();
    await expect(controls.getByRole('button', { name: /^连续预算/ })).toBeVisible();
    await expect(reconciliation).toContainText('已验证 2 次拒绝');
    console.log('PASS: real backend base cases, cumulative budget, reconciliation stop/retry, evidence download, reload, EN/ZH and mobile layout.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
