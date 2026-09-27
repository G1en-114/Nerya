// Run: node --test tests/research-visuals.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const { collectResearchVisuals, instrumentId, matchingResearchNews, researchNews, safeResearchUrl } = require('../lib/researchVisuals.ts');
const { chartColor } = require('../lib/chartColor.ts');
test('chart palette converts modern RGB tokens without losing alpha', () => {
  assert.equal(chartColor('rgb(85 207 153)', '#000'), 'rgb(85, 207, 153)');
  assert.equal(chartColor('rgb(85 207 153 / 25%)', '#000'), 'rgba(85, 207, 153, 0.25)');
  assert.equal(chartColor('rgb(100% 0% 20%)', '#000'), 'rgb(255, 0, 51)');
  assert.equal(chartColor('rgba(1, 2, 3, 0.2)', '#000'), 'rgba(1, 2, 3, 0.2)');
  assert.equal(chartColor('rgb(bad token)', '#000'), '#000');
});
const candle = { kind: 'chart', chart_id: 'fixture-price', chart_kind: 'candlestick', path: 'inline', title: 'BTC · TEST FIXTURE', source: { skill: 'markets', action: 'candles', as_of: '2026-09-20T00:00:00Z' }, instrument: { market: 'BTC/USDT', venue: 'binance' }, series: [{ name: 'OHLC', type: 'candlestick', data: [{ time: 1790000000, open: 100, high: 103, low: 99, close: 102 }] }] };
const study = { ...candle, chart_id: 'fixture-study', chart_kind: 'multi', instrument: undefined, title: 'TEST FIXTURE · flow', series: [{ name: 'Net · USD', type: 'histogram', data: [{ time: 1790000000, value: -2 }] }] };
const context = { version: 1, instruments: [{ market: 'BINANCE:BTC/USDT', venue: 'binance', name: 'Bitcoin', news: [{ title: 'TEST FIXTURE evidence', url: 'https://example.com/fixture', source: 'TEST FIXTURE', published_at: '2026-09-20T01:00:00Z' }] }] };
const result = { ok: true, research_context: context, chart_blocks: [{ ...candle, research_context: context }, { ...study, research_context: context }] };
const thread = blocks => ({ id: 'review', messages: [{ role: 'assistant', ts: 1790000000000, turn: { blocks } }] });
test('tool output, native blocks and reload collapse to one instrument and one study', () => {
  const value = collectResearchVisuals(thread([{ block: { kind: 'tool_result', ok: true, result } }, ...result.chart_blocks.map(block => ({ block }))]));
  assert.equal(value.instruments.length, 1);
  assert.equal(value.instruments[0].name, 'Bitcoin');
  assert.equal(value.instruments[0].news.length, 1);
  assert.equal(value.charts.length, 2);
  assert.deepEqual(value.studies.map(row => row.chart_id), ['fixture-study']);
  assert.deepEqual(value.instruments[0].chartIds, ['fixture-price']);
});
test('script stdout and history tool_trace yield the same content', () => {
  const value = collectResearchVisuals({ messages: [{ role: 'assistant', ts: 1, turn: { tool_trace: [{ ok: true, result: { stdout: 'tool stdout:\n' + JSON.stringify(result) } }] } }] });
  assert.equal(value.instruments.length, 1); assert.equal(value.studies.length, 1);
});
test('native text summary plus complete JSON yields rich charts even after minimal marker envelopes', () => {
  const nativeText = '$ python publish_visuals.py\n---- stdout ----\n' + JSON.stringify(result).slice(-180) + '\n---- stderr ----\n\n' + JSON.stringify({ stdout: JSON.stringify(result).slice(-180), stdout_json: result });
  const minimal = result.chart_blocks.map(({ instrument, research_context, ...block }) => ({ block }));
  for (const records of [[{ block: { kind: 'tool_result', ok: true, result: nativeText } }, ...minimal], [...minimal, { block: { kind: 'tool_result', ok: true, result: nativeText } }]]) {
    const value = collectResearchVisuals(thread(records));
    assert.equal(value.charts.length, 2); assert.equal(value.instruments.length, 1);
    assert.equal(value.studies.length, 1); assert.equal(value.instruments[0].news.length, 1);
    assert.ok(value.charts.find(row => row.chart_id === candle.chart_id).instrument);
  }
});
test('compacted publication notes retain all charts, assets, citations and associations', () => {
  const compacted = { skill_id: 'research', name: 'publish_visuals.py', exit_code: 0, stdout_json: { ok: true, notes: result } };
  for (const payload of [compacted, 'script_run: research/publish_visuals.py\n[compacted_kept]\n' + JSON.stringify(compacted)]) {
    const value = collectResearchVisuals(thread([{ block: { kind: 'tool_result', ok: true, result: payload } }]));
    assert.equal(value.charts.length, 2); assert.equal(value.instruments.length, 1);
    assert.equal(value.studies.length, 1); assert.equal(value.instruments[0].news.length, 1);
    assert.deepEqual(value.instruments[0].chartIds, ['fixture-price']);
  }
});
test('native script JSON survives the bounded stdout tail', () => {
  const value = collectResearchVisuals(thread([{ block: { kind: 'tool_result', ok: true, result: { stdout: JSON.stringify(result).slice(-100), stdout_json: result } } }]));
  assert.equal(value.charts.length, 2); assert.equal(value.instruments.length, 1);
});
test('incomplete streams, failed calls and user prose never invent assets', () => {
  const value = collectResearchVisuals({ messages: [{ role: 'user', ts: 1, text: JSON.stringify(result) }, { role: 'assistant', ts: 2, turn: { blocks: [{ kind: 'tool_result', ok: false, result }, { kind: 'tool_result', ok: true, result: '{"chart_blocks":[' }], tool_trace: [{ ok: false, result }] } }] });
  assert.equal(value.instruments.length, 0); assert.equal(value.charts.length, 0);
});
test('unknown candle studies still have a left workspace, and sessions do not leak', () => {
  assert.equal(collectResearchVisuals(thread([{ block: { ...candle, instrument: undefined, source: { skill: 'analysis' } } }])).studies.length, 1);
  assert.equal(collectResearchVisuals(null).instruments.length, 0);
});
test('venue qualification deduplicates but settlement suffixes stay intact', () => {
  assert.equal(instrumentId('BINANCE:BTC/USDT'), instrumentId('BTC/USDT', 'binance'));
  assert.equal(instrumentId('BYBIT:BTC/USDT:USDT'), instrumentId('BTC/USDT:USDT', 'bybit'));
  assert.notEqual(instrumentId('BTC/USDT', 'binance'), instrumentId('BTC/USDT', 'bybit'));
});
test('news links are safe, dates honest, and unrelated recent stories do not hide an asset match', () => {
  assert.equal(safeResearchUrl('javascript:alert(1)'), '');
  assert.equal(safeResearchUrl('https://user:pass@example.com'), '');
  assert.equal(researchNews([{ title: 'fixture', url: 'https://example.com/one', published_at: 'invalid' }])[0].published_at, '');
  const news = Array.from({ length: 25 }, (_, i) => ({ title: 'Unrelated fixture ' + i, url: 'https://example.com/' + i, published_at: '2026-09-21T00:00:00Z' }));
  news.push({ title: 'Bitcoin TEST FIXTURE', url: 'https://example.com/bitcoin', published_at: '2026-09-20T00:00:00Z' });
  const asset = { market: 'BTC/USDT:USDT', venue: 'bybit', name: 'BTC/USDT:USDT' };
  assert.equal(matchingResearchNews(news, asset).length, 1);
  assert.equal(matchingResearchNews(news, { ...asset, market: 'ETH/USDT' }).length, 0);
});
