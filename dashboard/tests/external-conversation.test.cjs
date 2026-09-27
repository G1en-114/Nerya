// Offline unit fixtures, not used by live verification or screenshots.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText, filename);
require.extensions['.css'] = module => { module.exports = {}; };
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { NextIntlClientProvider } = require('next-intl');
const { ExternalSessionTimeline } = require('../components/chat/ExternalSessionTimeline.tsx');
const { conversationEntries, toolOutput, fileRange, fileBody, targetsOf, toolTitle, plainOutput } = require('../lib/externalConversation.ts');
const base = (overrides = {}) => ({ call_id: 'call-a', remote_session_id: 'ext_mcp_unit', source: 'mcp', tool: 'nerya_native_read_file',
  status: 'succeeded', arguments: { path: 'skills/research/SKILL.md', offset: 20, limit: 9 }, sequence: 1, nodes: [], ...overrides });
const fileResult = { ok: true, text: 'duplicate envelope text must not be rendered', content: [
  { type: 'text', text: '# skills/research/SKILL.md (100 lines, 1200 bytes)\n\nalpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota' },
  { type: 'json', data: { path: 'skills/research/SKILL.md', offset: 20, limit: 9, total_lines: 100, bytes: 1200 } },
] };
function html(traces, locale = 'zh') {
  return renderToStaticMarkup(React.createElement(NextIntlClientProvider, { locale, timeZone: 'UTC', messages: {}, onError: () => {} },
    React.createElement(ExternalSessionTimeline, { traces,expandTools:true })));
}
test('activity fields are separate messages before the actual tool, not one summary card', () => {
  const trace = base({ activity: { intent: 'Check implementation', evidence: 'File exists', next: 'Read its body' } });
  const rows = conversationEntries([trace]);
  assert.deepEqual(rows.map(row => row.kind), ['message', 'message', 'message', 'tool']);
  assert.deepEqual(rows.slice(0, 3).map(row => row.text), ['Check implementation', 'File exists', 'Read its body']);
  assert.equal(toolTitle(trace, true), '读取文件');
});
test('deduplicates only an exact native wrapper, retaining every meaningful child operation', () => {
  const trace = base();
  trace.nodes = [{ call_id: 'native-a', parent_call_id: trace.call_id, tool: 'read_file', arguments: trace.arguments, status: 'succeeded' },
    { call_id: 'child-b', parent_call_id: 'native-a', tool: 'read_file', arguments: { path: 'another.md' }, status: 'succeeded' },
    { call_id: 'child-c', parent_call_id: 'native-a', tool: 'run_shell', arguments: { command: 'pwd' }, status: 'succeeded' }];
  const rows = conversationEntries([trace]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].mirroredId, 'native-a');
  assert.deepEqual(rows.map(row => row.node.call_id), ['call-a', 'child-b', 'child-c']);
  assert.deepEqual(rows.map(row => row.depth), [0, 1, 1]);
});
test('running and final updates share identity; interleaved turn IDs never reorder history', () => {
  const first = base({ turn_id: 'A', status: 'running' });
  const final = base({ turn_id: 'A', result: fileResult });
  const middle = base({ call_id: 'call-b', sequence: 2, turn_id: 'B' });
  const last = base({ call_id: 'call-c', sequence: 3, turn_id: 'A' });
  const rows = conversationEntries([first, middle, last, final]);
  assert.deepEqual(rows.map(row => row.id), ['call-a', 'call-b', 'call-c']);
  assert.equal(rows[0].node.status, 'succeeded');
});
test('native read content and returned zero-based ranges display accurate file lines', () => {
  const node = base(), out = toolOutput(fileResult);
  assert.deepEqual(fileRange(node, out), { start: 21, end: 29, total: 100 });
  assert.match(fileBody(node, out), /^alpha\nbeta/);
  assert.doesNotMatch(fileBody(node, out), /duplicate|1200 bytes/);
  assert.deepEqual(targetsOf(node, out.data), ['skills/research/SKILL.md']);
});
test('shell content parts expose stdout, stderr and exit code without duplicated text', () => {
  const out = toolOutput({ text: 'envelope copy', content: [{ type: 'shell', data: { stdout: '\u001b[32mok\u001b[0m\n', stderr: 'warning\n', exit_code: 0, cwd: '/workspace' } }] });
  assert.equal(out.stdout, 'ok\n'); assert.equal(out.stderr, 'warning\n');
  assert.equal(out.data.exit_code, 0); assert.equal(out.text, '');
});
test('internal JSON-text envelopes are decoded and diffs are kept as distinct content', () => {
  assert.equal(toolOutput({ text: JSON.stringify({ stdout: 'live output', exit_code: 2 }) }).data.exit_code, 2);
  const out = toolOutput({ content: [{ type: 'diff', text: '@@\n-old\n+new' }], metadata: { path: 'x.py' } });
  assert.deepEqual(out.diffs, ['@@\n-old\n+new']); assert.equal(out.data.path, 'x.py');
});
test('progress current and each reported result are independent messages, not a fake tool', () => {
  const rows = conversationEntries([base({ tool: 'nerya_progress', arguments: { current: 'Done', status: 'completed', result: ['Read A', 'Read B'] } })]);
  assert.deepEqual(rows.map(row => row.text), ['Done', 'Read A', 'Read B']);
  assert.equal(rows[0].state, 'completed'); assert.ok(rows.every(row => row.kind === 'message'));
});
test('missing activity still displays real file and results; it does not invent narration', () => {
  const rendered = html([base({ result: fileResult })]);
  assert.match(rendered, /skills\/research\/SKILL.md/); assert.match(rendered, /21–29/);
  assert.match(rendered, /alpha/); assert.match(rendered, /文件内容/);
  assert.doesNotMatch(rendered, /external-activity|external-task|external-current/);
  assert.doesNotMatch(rendered, /duplicate envelope/);
  assert.match(rendered, /data-nerya-icon="document"/);
});
test('file previews and shell command/output are visible without opening raw data', () => {
  const rendered = html([base({ result: fileResult }), base({ call_id: 'shell', sequence: 2, tool: 'nerya_native_run_shell', arguments: { command: 'wc -l notes.md' },
    result: { content: [{ type: 'shell', data: { stdout: '42 notes.md\n', stderr: '', exit_code: 0 } }] } })]);
  assert.match(rendered, /wc -l notes.md/); assert.match(rendered, /42 notes.md/); assert.match(rendered, /exit 0/);
  assert.match(rendered, /data-nerya-icon="terminal"/); assert.match(rendered, /<details[^>]+open/);
});
test('meaningful child rows are visible and not nested inside raw details', () => {
  const trace = base({ tool: 'nerya_native_script_run', arguments: { script: 'inspect.py' }, nodes: [
    { call_id: 'nested', parent_call_id: 'call-a', tool: 'read_file', arguments: { path: 'nested.md' }, status: 'failed', result: { error: { message: 'Missing file' } } },
  ] });
  const rendered = html([trace]);
  assert.match(rendered, /data-testid="external-call-step"/); assert.match(rendered, /nested.md/); assert.match(rendered, /Missing file/);
});
test('untrusted returned content remains escaped; no HTML or terminal control is executed', () => {
  const rendered = html([base({ result: { text: '<script>alert(1)</script>' } })]);
  assert.doesNotMatch(rendered, /<script>/); assert.match(rendered, /&lt;script&gt;/);
  assert.equal(plainOutput('\u001b]0;title\u0007hello\u001b[2K'), 'hello');
});
test('external calls never populate the final-answer panel', () => {
  const { finalReplyText, collectChatResults } = require('../lib/chatResults.ts');
  const message = { id: 'm1', role: 'assistant', text: 'nerya_native_read_file', turn: {
    external_call: base(), reply_text: 'External result, not an answer',
  } };
  assert.equal(finalReplyText(message), '');
  assert.deepEqual(collectChatResults({ id: 's1', title: 'External', messages: [message] }), []);
});
test('ordinary assistant answers still populate the final-answer panel', () => {
  const { finalReplyText, collectChatResults } = require('../lib/chatResults.ts');
  const message = { id: 'm1', role: 'assistant', text: '', turn: { reply_text: 'A normal final answer' } };
  assert.equal(finalReplyText(message), 'A normal final answer');
  assert.equal(collectChatResults({ id: 's1', title: 'Normal', messages: [message] }).length, 1);
});
test('failed progress is an actual failed tool event, not a completed work message', () => {
  const rows = conversationEntries([base({ tool: 'nerya_progress', status: 'failed', arguments: { current: 'Done', status: 'completed' }, result: { error: { message: 'Cannot persist' } } })]);
  assert.equal(rows[0].kind, 'tool'); assert.equal(rows[0].node.status, 'failed');
});
