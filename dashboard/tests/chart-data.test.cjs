// Run: node --test tests/chart-data.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const { mergeChartPayload } = require('../lib/useChartData.ts');
const { isFullyInline } = require('../lib/chartBlock.ts');
const points = [{ time: 1790000000, value: 2 }, { time: 1790003600, value: -1 }];
const block = { kind: 'chart', chart_id: 'test-bulk', path: 'bulk', title: 'TEST FIXTURE', chart_kind: 'multi',
  bulk_data_uri: 'nerya://chart/test-bulk', source: { skill: 'research', action: 'study', as_of: '2026-09-20T00:00:00Z' },
  series: [{ name: 'Net flow', type: 'histogram', data_uri: 'nerya://chart/test-bulk#series/Net flow' }] };
test('workspace-backed chart becomes renderable after artifact hydration', () => {
  assert.equal(isFullyInline(block), false);
  const hydrated = mergeChartPayload(block, { chart_id: block.chart_id, series: [{ name: 'Net flow', type: 'histogram', data: points }] });
  assert.equal(isFullyInline(hydrated), true);
  assert.deepEqual(hydrated.series[0].data, points);
  assert.equal(hydrated.bulk_data_uri, undefined);
  assert.equal(hydrated.series[0].data_uri, undefined);
  assert.equal(block.bulk_data_uri, 'nerya://chart/test-bulk');
});
test('a missing or empty required series never reports ready', () => {
  assert.equal(isFullyInline(mergeChartPayload(block, { chart_id: block.chart_id, series: [] })), false);
  assert.equal(isFullyInline(mergeChartPayload(block, { chart_id: block.chart_id, series: [{ name: 'Net flow', type: 'histogram', data: [] }] })), false);
});
test('mixed inline and bulk series preserve the inline observations', () => {
  const mixed = { ...block, series: [...block.series, { name: 'Inflow', type: 'line', data: points }] };
  const hydrated = mergeChartPayload(mixed, { chart_id: block.chart_id, series: [{ name: 'Net flow', type: 'histogram', data: points }] });
  assert.equal(isFullyInline(hydrated), true);
  assert.deepEqual(hydrated.series[1].data, points);
});
