// Read-only browser check against an already running dashboard.
// Runtime APIs are stubbed; the recording is served by the actual dashboard.
const { chromium, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const base = process.env.NERYA_DASHBOARD_URL || 'http://127.0.0.1:3001';
  const artifacts = path.resolve(__dirname, '../../.tmp/safety-ui-check');
  fs.mkdirSync(artifacts, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/proxy/**', route => route.fulfill(
      route.request().url().includes('/auth/status')
        ? { json: { local_access: true } }
        : { status: 503, json: { error: 'Runtime intentionally offline in UI test' } }
    ));
    await page.addInitScript(() => localStorage.setItem('nerya.ui_settings.v1', JSON.stringify({ language: 'en' })));
    await page.goto(`${base}/dashboard`);
    await expect(page.getByTestId('mandate-demo-card')).toContainText('7 cases');
    await page.getByRole('link', { name: 'Open safety controls' }).click();
    await expect(page.getByTestId('safety-demo-page')).toBeVisible();
    await expect(page.getByTestId('safety-case-detail')).toHaveCount(0);
    await page.getByRole('button', { name: 'Historical recording', exact: true }).click();
    await expect(page.getByTestId('safety-case-detail')).toContainText('Paper filled');
    const cases = page.getByRole('button', { name: /0[1-7].*(ALLOW|DENY)/ });
    await expect(cases).toHaveCount(7);
    for (let i = 1; i < 7; i++) {
      await cases.nth(i).click();
      await expect(page.getByTestId('safety-case-detail')).toContainText('Rejected');
    }
    await cases.nth(2).click();
    await expect(page.getByTestId('safety-case-detail')).toContainText('Succeeded');
    await expect(page.getByTestId('safety-case-detail')).toContainText('resolved_cost_exceeds_signed_ceiling');
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download displayed evidence JSON' }).click();
    const download = await downloadEvent;
    await download.saveAs(path.join(artifacts, 'download.json'));
    const exported = JSON.parse(fs.readFileSync(path.join(artifacts, 'download.json'), 'utf8'));
    if (exported.cases.length !== 7 || exported.mode !== 'local-paper-recording' || exported.settings) throw Error('Unexpected export');
    await page.getByRole('heading', { level: 1 }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('heading', { level: 1 }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Horizontal overflow');
    await page.addInitScript(() => localStorage.setItem('nerya.ui_settings.v1', JSON.stringify({ language: 'zh' })));
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('让授权有边界');
    await page.getByRole('button', { name: '历史演示记录', exact: true }).click();
    await expect(page.getByTestId('safety-case-detail')).toContainText('模拟已成交');
    await page.route('**/mandates/demo.json', route => route.fulfill({ status: 404, body: '' }));
    await page.getByRole('button', { name: '刷新记录' }).click();
    await expect(page.getByText('还没有发布演示记录')).toBeVisible();
    await expect(page.getByTestId('safety-case-detail')).toHaveCount(0);
    await page.unroute('**/mandates/demo.json');
    await page.route('**/mandates/demo.json', route => route.fulfill({ json: { schemaVersion: 99 } }));
    await page.getByRole('button', { name: '刷新记录' }).click();
    await expect(page.getByText('记录暂时无法读取')).toBeVisible();
    if (errors.length) throw Error(errors.join('\n'));
    console.log('PASS: dashboard entry, seven cases, chain/runtime distinction, download, EN/ZH, mobile, missing and invalid data.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
