// Isolated offline fixtures only; never used by live screenshots or service data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText, filename);
require.extensions['.css'] = module => { module.exports = {}; };
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { NextIntlClientProvider } = require('next-intl');
// Router-only test host; domain components/results are the real implementations.
const navigation = require.resolve('next/navigation');
require.cache[navigation] = { id: navigation, filename: navigation, loaded: true, exports: {
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, prefetch() {}, back() {}, forward() {} }),
  usePathname: () => '/chat/unit', useSearchParams: () => new URLSearchParams(),
} };
const { externalNodeMessage, projectExternalThread } = require('../lib/externalNative.ts');
const { collectResearchVisuals } = require('../lib/researchVisuals.ts');
const { ExternalCallMessage } = require('../components/chat/ExternalCallMessage.tsx');
const { NativeBlocksTrack, activeProposalsFromTurn } = require('../components/chat/TurnBlocks.tsx');
const { ResearchReplyCards } = require('../components/chat/ResearchReplyCards.tsx');
const { ResearchInstrumentContext, ResearchVisualContext } = require('../components/chat/ResearchVisualContext.tsx');
const messages = require('../messages/en/research-workspace.json');
const trace = extra => ({ source: 'tunnel', remote_session_id: 'session-unit', call_id: 'call-unit', tool: 'nerya_native_run_shell',
  status: 'succeeded', arguments: { command: 'unit only' }, started_at: '2026-09-23T10:00:00Z', nodes: [], ...extra });
const chart = { kind: 'chart', chart_id: 'unit-chart', title: 'UNIT ONLY', chart_kind: 'candlestick', path: 'inline',
  instrument: { market: 'BTC/USDT', venue: 'binance', interval: '1h', name: 'Bitcoin UNIT ONLY' },
  source: { skill: 'research', action: 'unit', as_of: '2026-09-23T10:00:00Z' },
  series: [{ name: 'BTC', type: 'candlestick', data: [{ time: 1790100000, open: 100, high: 102, low: 99, close: 101 }, { time: 1790103600, open: 101, high: 104, low: 100, close: 103 }] }] };
function html(child) {
  return renderToStaticMarkup(React.createElement(NextIntlClientProvider, { locale: 'en', messages, timeZone: 'UTC', onError: () => {} },
    React.createElement(ResearchVisualContext.Provider, { value: () => {} },
      React.createElement(ResearchInstrumentContext.Provider, { value: () => {} }, child))));
}
test('strategy uses the exact normal card, actions, links and glyphs', () => {
  const proposal = { kind: 'strategy_package_proposal', proposal_id: 'proposal-unit', strategy_id: 'strategy-unit', state: 'pending_review',
    summary: 'UNIT ONLY', files: ['strategies/strategy-unit/strategy.yml'], validation: { ok: true, blockers: [] } };
  const call = trace({ tool: 'nerya_native_strategy_generate_proposal', result: { ok: true, content: [{ type: 'json', data: proposal }] } });
  const message = externalNodeMessage(call);
  assert.equal(activeProposalsFromTurn(message.turn)[0].id, proposal.proposal_id);
  const common = html(React.createElement(NativeBlocksTrack, { envelopes: message.turn.blocks, presentation: 'expanded' }));
  const external = html(React.createElement(ExternalCallMessage, { trace: call }));
  assert.match(common, /data-strategy-proposal-hoist/);
  assert.match(external, /Review candidate and validation/);
  assert.doesNotMatch(external, /data-testid="workflow-native-panel"/);
});
test('structured research and ordinary reply produce identical instrument card markup', () => {
  const call = trace({ result: { ok: true, content: [{ type: 'json', data: { chart_blocks: [chart] } }] } });
  const external = externalNodeMessage(call);
  const native = { id: call.call_id, role: 'assistant', ts: external.ts, turn: { blocks: [{ block: chart }] } };
  assert.equal(html(React.createElement(ResearchReplyCards, { message: external })), html(React.createElement(ResearchReplyCards, { message: native })));
  const markup = html(React.createElement(ExternalCallMessage, { trace: call }));
  assert.match(markup, /research-instrument-card/); assert.match(markup, /research-card-price">103/);
  assert.match(markup, /research-reply-cards/); assert.match(markup, /data-nerya-icon="arrowUpRight"/);
  assert.doesNotMatch(markup, /disabled=""/);
});
test('shell output, nested child and bulk marker retain actual chart metadata', () => {
  const call = trace({ result: { content: [{ type: 'shell', data: { stdout: JSON.stringify({ chart_blocks: [chart] }), exit_code: 0 } }] } });
  const projected = externalNodeMessage(call);
  assert.equal(collectResearchVisuals({ messages: [projected] }).charts[0].source.as_of, chart.source.as_of);
  const marker = { ...chart, path: 'bulk', series: [{ name: 'BTC', type: 'candlestick', data_uri: 'nerya://chart/unit-chart#series/BTC' }], bulk_data_uri: 'nerya://chart/unit-chart' };
  const child = { call_id: 'child', parent_call_id: call.call_id, tool: 'run_shell', status: 'succeeded', arguments: {}, result: { text: '@@nerya:chart@@ unit-chart' }, presentation_blocks: [marker] };
  const thread = projectExternalThread({ id: 'session-unit', messages: [{ id: 'message', role: 'assistant', ts: projected.ts, turn: { external_call: trace({ result: {}, nodes: [child] }) } }] });
  const research = collectResearchVisuals(thread);
  assert.equal(research.charts[0].bulk_data_uri, marker.bulk_data_uri);
  assert.equal(research.instruments[0].market, 'BTC/USDT');
});
test('failed/running/request-only outputs never create actionable research or strategy results', () => {
  for (const status of ['running', 'failed', 'awaiting_approval', 'interrupted']) {
    const call = trace({ status, arguments: { chart_blocks: [chart] }, result: { chart_blocks: [chart] }, presentation_blocks: [chart] });
    const message = externalNodeMessage(call);
    assert.equal(collectResearchVisuals({ messages: [message] }).charts.length, 0);
    assert.doesNotMatch(html(React.createElement(ExternalCallMessage, { trace: call })), /research-instrument-card|research-chart-link/);
  }
});
test('no normal thread identity changes or cross-session chart contamination', () => {
  const ordinary = { id: 'normal', messages: [{ id: 'm', role: 'assistant', turn: { reply_text: 'normal' } }] };
  assert.equal(projectExternalThread(ordinary), ordinary);
  const foreign = { id: 'different', messages: [{ id: 'm', role: 'assistant', turn: { external_call: trace({ result: { chart_blocks: [chart] } }) } }] };
  assert.equal(collectResearchVisuals(projectExternalThread(foreign)).charts.length, 0);
});
