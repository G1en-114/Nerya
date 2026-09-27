// Unit fixtures only. No fabricated performance is written to a user session.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText, filename);
const React = require('react');
require.extensions['.css'] = module => { module.exports = new Proxy({}, { get: (_, key) => String(key) }); };
const { renderToStaticMarkup } = require('react-dom/server');
const { NextIntlClientProvider } = require('next-intl');
const { collectBacktestResults, extractBacktestResults } = require('../lib/backtestResults.ts');
const { BacktestReplyCards } = require('../components/chat/BacktestReplyCards.tsx');
const result = { ok: true, strategy_id: 'sdk_fixture', proposal_id: 'prp_fixture', backtest_ts: '20260926_120000', verdict: 'WARN',
  metrics_display: { total_return_pct: '0.0274%', max_drawdown_pct: '0.00%', sharpe_ratio: '0.10', total_trades: '2' } };
const reply = (id, value) => ({ role: 'assistant', id, ts: 1700000000000, loading: true,
  turn: { blocks: [{ block: { kind: 'tool_result', action: 'strategy_backtest', result: value } }] } });
function html(message) {
  return renderToStaticMarkup(React.createElement(NextIntlClientProvider, { locale: 'en', messages: {}, timeZone: 'UTC' },
    React.createElement(BacktestReplyCards, { message })));
}

test('compacted result keeps exact proposal/run identity and percentage units', () => {
  const message = reply('first', 'backtest: metrics=[...]\n[compacted_kept]\n' + JSON.stringify(result));
  const rows = collectBacktestResults({ messages: [message] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'prp_fixture:sdk_fixture:20260926_120000');
  const rendered = html(message);
  assert.match(rendered, /backtest-result-card/);
  assert.match(rendered, /0\.0274%/); assert.doesNotMatch(rendered, /2\.74%/);
  assert.match(rendered, /View equity curve and trades/);
  assert.match(rendered, /aria-expanded="false"/);
});

test('nested stdout and MCP JSON parts survive truncated summaries', () => {
  const stdout = 'partial {broken ...\n' + JSON.stringify(result);
  const rows = extractBacktestResults({ type: 'tool_result', name: 'strategy_backtest', content: [{ type: 'json', data: { stdout_json: { output: stdout } } }] });
  assert.equal(rows.length, 1); assert.equal(rows[0].proposalId, 'prp_fixture');
});

test('artifact locators recover proposal ids instead of loading promoted strategy', () => {
  const rows = extractBacktestResults({ out_dir: 'C:\\workspace\\evolution\\proposals\\prp_local\\after\\strategies\\sdk_fixture\\backtests\\sdk_20260926_120000' });
  assert.equal(rows[0].proposalId, 'prp_local');
  assert.equal(rows[0].ts, 'sdk_20260926_120000');
});

test('each reply contains its own results; duplicate representations are merged', () => {
  const first = reply('first', result);
  first.turn.tool_trace = [{ action: 'strategy_backtest', result }];
  assert.equal(collectBacktestResults({ messages: [first] }).length, 1);
  const second = reply('second', { ...result, backtest_ts: '20260926_130000' });
  assert.equal(collectBacktestResults({ messages: [first, second] }).length, 2);
  assert.doesNotMatch(html(second), /20260926_120000/);
});

test('failures show a single diagnostic, no performance or report button', () => {
  const failure = { result_type: 'backtest_result', ok: false, reason: 'backtest_sdk_unsupported', proposal_id: 'prp_fixture',
    message: 'Historical replay cannot run this live-only surface.' };
  const message = reply('failed', { type: 'tool_result', name: 'strategy_backtest', is_error: true,
    error: { kind: 'execution_error', message: 'generic failure' }, content: [{ type: 'json', data: failure }] });
  const rows = collectBacktestResults({ messages: [message] });
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'blocked');
  const rendered = html(message);
  assert.match(rendered, /Historical replay cannot/);
  assert.doesNotMatch(rendered, /open-backtest-report|Total return|Completed/);
  const partial = extractBacktestResults({ ...result, ok: false, reason: 'no_historical_data' }, 0, 'strategy_backtest');
  assert.equal(partial[0].status, 'blocked'); assert.equal(partial[0].ts, '');
});

test('neither prose, input tool calls nor plain research becomes a completed backtest', () => {
  assert.equal(collectBacktestResults({ messages: [{ role: 'user', text: JSON.stringify(result) }] }).length, 0);
  assert.equal(extractBacktestResults({ kind: 'tool_use', action: 'strategy_backtest', arguments: result }).length, 0);
  assert.equal(collectBacktestResults({ messages: [{ role: 'assistant', id: 'plain', ts: 1, turn: { reply_text: JSON.stringify(result) } }] }).length, 0);
  assert.equal(html(reply('empty', { ok: true, message: 'Research done' })), '');
});

test('cards mount before the final-reply condition and in external calls too', () => {
  const source = fs.readFileSync(path.join(__dirname, '../components/chat/ChatMessage.tsx'), 'utf8');
  assert.ok(source.indexOf('<BacktestReplyCards message={msg} />') < source.indexOf('{reply ? <section'));
  const external = fs.readFileSync(path.join(__dirname, '../components/chat/ExternalCallMessage.tsx'), 'utf8');
  assert.match(external, /<BacktestReplyCards message=\{message\} \/>/);
});

test('saved strategy cards read streaming evidence and survive a later failure', () => {
  const { activeProposalsFromTurn } = require('../components/chat/TurnBlocks.tsx');
  const proposal={action:'strategy_draft_proposal',kind:'strategy_package_proposal',
    proposal_id:'prp_source',strategy_id:'source',state:'draft',files:['main.py'],validation:{ok:true}};
  const blocks=[{block:{kind:'tool_result',ok:true,action:'strategy_draft_proposal',result:proposal}},
    {block:{kind:'tool_result',ok:false,action:'strategy_backtest',error:'historical source unavailable'}}];
  assert.equal(activeProposalsFromTurn({blocks}).length,1);
  assert.equal(activeProposalsFromTurn({blocks}).at(0).id,'prp_source');
  const source=fs.readFileSync(path.join(__dirname,'../components/chat/ChatMessage.tsx'),'utf8');
  assert.match(source,/activeProposalsFromTurn\(\{[\s\S]*?blocks: sourceBlocks/);
  assert.doesNotMatch(source,/const proposals = !msg.loading/);
});

test('observation replay shows activity and never turns a flat account into performance', () => {
  const rendered = html(reply('observer', { ...result, title:'Observed event strategy', evaluation_mode:'observation',
    execution_mode:'agent', performance_evidence:false, provenance:{data_kind:'historical'},
    replay:{decisions:25, dispatches:7, skipped:18, errors:0, agent_execution:'not_run'},
    metrics_display:{total_return_pct:'0.00%', max_drawdown_pct:'0.00%'} }));
  assert.match(rendered, /Observed event strategy|Event &amp; dispatch replay/);
  assert.match(rendered, /data-metric="dispatches">7/);
  assert.match(rendered, /Agent model not executed/);
  assert.match(rendered, /View events and diagnostics/);
  assert.doesNotMatch(rendered, /0\.00%|Total return|Recorded backtest equity/);
});

test('the preview uses recorded values only and missing provenance stays unverified', () => {
  const rendered = html(reply('curve', { ...result, equity_preview:[{time:1,value:100},{time:2,value:102},{time:2,value:101.8}] }));
  assert.match(rendered, /Recorded backtest equity/);
  assert.match(rendered, /101\.8 USD/);
  assert.match(rendered, /Source not recorded/);
  assert.doesNotMatch(rendered, /Historical market data/);
});

test('CSV trade values are readable without losing tiny quantities or order identifiers', () => {
  const { BacktestTables } = require('../components/backtest/BacktestTables.tsx');
  const rendered = renderToStaticMarkup(React.createElement(NextIntlClientProvider, { locale:'zh', messages:{}, timeZone:'UTC' },
    React.createElement(BacktestTables, { tables:[{ id:'trades', columns:['qty','price','intent_id','ts'],
      rows:[['0.00000001','86378.64700099999','00001234','1790377200']] }] })));
  assert.match(rendered, /成交明细/);
  assert.match(rendered, />0\.00000001<\/span>/);
  assert.match(rendered, />86,378\.65<\/span>/);
  assert.match(rendered, /title="86378\.64700099999"/);
  assert.match(rendered, />00001234<\/span>/);
  assert.match(rendered, /2026-09-25 23:00:00/);
});

test('economic FAIL explains the performance gate, not a failed computation', () => {
  const rendered = html(reply('evaluated', { ...result, verdict:'FAIL', flags:['benchmark_capture_below_threshold'] }));
  assert.match(rendered, /Replay completed, but the benchmark-capture gate/);
  assert.match(rendered, /View equity curve and trades/);
});

test('execution counters distinguish attempts, queued intents and settled fills', () => {
  const rendered = html(reply('orders', { ...result, replay: {
    order_attempts: 600, orders_submitted: 600, orders_filled: 205, orders_rejected: 395,
    sdk_errors: 0, forced_closes: 1, order_accounting_ok: true,
    rejection_reasons: { max_open_trades: 395 },
  } }));
  assert.match(rendered, /data-execution-metric="orders_filled">205/);
  assert.match(rendered, /data-execution-metric="orders_rejected">395/);
  assert.match(rendered, /Strategy ok is not a fill/);
  assert.match(rendered, /Liquidations: 1/);
});

test('legacy zero attempts do not fabricate missing fill counters', () => {
  const rendered = html(reply('legacy', { ...result, replay: { order_attempts: 0, status_counts: { ok: 12546 } } }));
  assert.match(rendered, /No order attempts were recorded/);
  assert.match(rendered, /data-execution-metric="orders_filled">—/);
  assert.doesNotMatch(rendered, /data-execution-metric="orders_filled">12546/);
});

test('legacy multi-market benchmark warns without rewriting saved data', () => {
  const { BacktestExecutionEvidence } = require('../components/backtest/BacktestExecutionEvidence.tsx');
  const rendered = renderToStaticMarkup(React.createElement(NextIntlClientProvider, { locale:'zh', messages:{}, timeZone:'UTC' },
    React.createElement(BacktestExecutionEvidence, { replay: { order_attempts:0 }, legacyBenchmark:true })));
  assert.match(rendered, /旧版多品种基准/);
  assert.match(rendered, /勿将此报告的基准、超额收益作为有效评估依据/);
});
