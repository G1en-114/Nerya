"use strict";
// Legacy activity receipts, current flat conversation UI. Real local calls only.
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
const run = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const reportPath = path.join(root, 'test-results/mcp-activity-verification.json');
const base = 'http://127.0.0.1:18380';
const receipts = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const results = { session_id: receipts.session_id, checks: {}, pageErrors: [] };
const deadline = setTimeout(() => { console.error('UI acceptance deadline exceeded'); process.exit(2); }, 90000);
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    page.on('pageerror', error => results.pageErrors.push(error.message));
    page.setDefaultTimeout(15000);
    await page.goto(`${base}/chat/${receipts.session_id}`, { waitUntil: 'domcontentloaded' });
    const feed = page.getByTestId('external-timeline');
    await expect(page.getByTestId('external-call')).toHaveCount(receipts.native_call_count);
    await expect(page.getByTestId('external-task')).toHaveCount(0);
    await expect(page.getByTestId('external-current')).toHaveCount(0);
    await expect(page.getByTestId('external-activity').filter({ hasText: '第一次真实角色查询已成功' }).first()).toBeVisible();
    await expect(page.getByTestId('external-progress-results').filter({ hasText: '两次真实只读工具调用均成功' }).last()).toBeVisible();
    await expect(feed.locator('details[open]')).toHaveCount(0);
    await expect(page.locator('textarea')).toBeVisible();
    await expect(page.getByTestId('external-composer-hint')).toBeVisible();
    await expect(page.locator(`a[href="/chat/${receipts.session_id}"]`)).toHaveCount(1);
    const native = page.locator('[data-testid="external-call"][data-tool="role_list"]').first();
    await expect(native).toContainText('role_list');
    await native.getByTestId('external-technical-details').locator('summary').click();
    await expect(native.getByTestId('external-technical-details')).toContainText('native_steps');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('external-call')).toHaveCount(receipts.native_call_count);
    await run(path.join(root, '.venv/bin/python'), [path.join(root, 'scripts/verify_mcp_activity.py'),
      '--workspace', receipts.workspace, '--report', reportPath], { cwd: root, timeout: 60000 });
    const updated = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (updated.session_id !== receipts.session_id || updated.new_session_count !== 0) throw new Error('New session on continuation');
    await expect(page.getByTestId('external-call')).toHaveCount(updated.native_call_count, { timeout: 18000 });
    results.live_refresh = { before: receipts.native_call_count, after: updated.native_call_count,
      new_sessions: updated.new_session_count, without_reload: true };
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(feed).toBeVisible();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error('Mobile overflow');
    await page.goto(`${base}/chat`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('textarea')).toBeVisible();
    await expect(feed).toHaveCount(0);
    results.checks = { flat_conversation: true, public_updates_visible: true, raw_only_collapsed: true,
      actual_native_record: true, one_sidebar_session: true, reload_persistence: true, mobile_visible: true, normal_chat_unchanged: true };
    if (results.pageErrors.length) throw new Error(results.pageErrors.join('\n'));
    fs.writeFileSync(path.join(root, 'test-results/mcp-activity-ui-verification.json'), JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify(results, null, 2));
  } finally { await browser.close(); clearTimeout(deadline); }
})().catch(error => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
