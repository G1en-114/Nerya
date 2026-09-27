"use strict";
// Real local service + actual stdio MCP receipts. No mock API/market/model data.
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
const run = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const reportPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'test-results/mcp-conversation-verification.json');
const receipts = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const base = 'http://127.0.0.1:18380';
const results = { session_id: receipts.session_id, checks: {}, pageErrors: [], screenshots: [] };
const deadline = setTimeout(() => { console.error('UI acceptance deadline exceeded'); process.exit(2); }, 90000);
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  try {
    page.on('pageerror', error => results.pageErrors.push(error.message));
    page.setDefaultTimeout(15000);
    await page.goto(`${base}/chat/${receipts.session_id}`, { waitUntil: 'domcontentloaded' });
    const feed = page.getByTestId('external-timeline');
    await expect(page.getByTestId('external-call')).toHaveCount(receipts.tool_count);
    await expect(page.getByTestId('external-task')).toHaveCount(0);
    const reads = page.locator('[data-testid="external-call"][data-tool="read_file"]');
    const first = reads.first();
    await expect(first).toContainText(receipts.paths[0]);
    await expect(first).toContainText('11–24');
    await expect(first.locator('pre').first()).toContainText('related reads');
    await expect(reads.nth(1).locator('pre').first()).toContainText('improvised bypass');
    await expect(first.locator('[data-nerya-icon="document"]')).toBeVisible();
    const grep = page.locator('[data-testid="external-call"][data-tool="grep"]').first();
    await expect(grep).toContainText('tool');
    await expect(grep).toContainText('main.agent.md');
    await expect(grep.locator('[data-nerya-icon="search"]')).toBeVisible();
    const shell = page.locator('[data-testid="external-call"][data-tool="run_shell"]').first();
    await expect(shell).toContainText('wc -l agents/main.agent.md agents/system.md');
    await expect(shell).toContainText('exit 0');
    await expect(shell.locator('pre').first()).toContainText('30 agents/main.agent.md');
    await expect(shell.locator('pre').first()).toContainText('20 agents/system.md');
    await expect(shell.locator('[data-nerya-icon="terminal"]')).toBeVisible();
    await expect(feed.locator('[data-testid="external-technical-details"][open]')).toHaveCount(0);
    await expect(page.locator('textarea')).toBeVisible();
    await expect(page.getByTestId('external-composer-hint')).toBeVisible();
    results.checks = { shared_native_cards: true, same_native_icons: true, file_range_and_output_visible: true, raw_collapsed: true };
    await page.getByTestId('transcript-scroll').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: path.join(root, 'test-results/mcp-conversation-files.png') });
    await shell.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, 'test-results/mcp-conversation-command.png') });
    results.screenshots.push('agent/test-results/mcp-conversation-files.png', 'agent/test-results/mcp-conversation-command.png');
    // Expand the persisted native file preview, preserving that state during append.
    const more = first.getByRole('button', { name: /显示全部|展开|Show all/i });
    await more.click();
    await expect(first.locator('pre').first()).toContainText('risk decisions');
    const originalId = await first.getAttribute('id');
    await run(path.join(root, '.venv/bin/python'), [path.join(root, 'scripts/verify_mcp_conversation.py'),
      '--workspace', receipts.workspace, '--source', receipts.source, '--report', reportPath, '--append'], { cwd: root, timeout: 60000 });
    const updated = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (updated.session_id !== receipts.session_id || updated.new_sessions !== 0) throw new Error('Unexpected new session');
    await expect(page.getByTestId('external-call')).toHaveCount(updated.tool_count, { timeout: 18000 });
    await expect(first.locator('pre').first()).toContainText('risk decisions');
    if (await first.getAttribute('id') !== originalId) throw new Error('Call identity changed');
    results.live_refresh = { before: receipts.tool_count, after: updated.tool_count, new_sessions: 0, expansion_preserved: true };
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('external-call')).toHaveCount(updated.tool_count);
    results.checks.reload_persistence = true;
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('workspace-split')).toHaveAttribute('data-compact', 'true');
    // Ordinary workspaces can open automatically when result artifacts arrive; use the real close control if needed.
    const source = page.getByTestId('workspace-source');
    if (!await source.isVisible()) {
      const close = page.getByRole('button', { name: /收起工作区|Collapse workspace|Close workspace/ }).first();
      await close.click();
    }
    await expect(feed).toBeVisible();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error('Mobile overflow');
    await first.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, 'test-results/mcp-conversation-mobile.png') });
    results.checks.mobile_visible = true;
    await page.goto(`${base}/chat`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('textarea')).toBeVisible();
    results.checks.normal_chat_unchanged = true;
    if (results.pageErrors.length) throw new Error(results.pageErrors.join('\n'));
    fs.writeFileSync(path.join(root, 'test-results/mcp-conversation-ui-verification.json'), JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify(results, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ url: page.url(), pageErrors: results.pageErrors, visible: (await page.locator('body').innerText()).slice(0, 2400) }));
    await page.screenshot({ path: path.join(root, 'test-results/mcp-conversation-failure.png') }).catch(() => {});
    throw error;
  } finally { await browser.close(); clearTimeout(deadline); }
})().catch(error => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
