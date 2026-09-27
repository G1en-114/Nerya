const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(
  fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText, filename);
const { applyExternalHistoryPage: merge } = require('../lib/externalHistory.ts');
const { conversationEntries } = require('../lib/externalConversation.ts');

const call = (id, sequence, turn = 'A', status = 'running') => ({
  message_id: `${id}:assistant`, role: 'assistant', content: id, history_key: [sequence, 100, id],
  turn_id: turn, turn: { external_call: { call_id: id, sequence, turn_id: turn, status, tool: 'read_file',
    source: 'mcp', remote_session_id: 'session', arguments: { path: 'fixture' },
    nodes: [{ call_id: `${id}-mirror`, parent_call_id: id, tool: 'read_file', arguments: { path: 'fixture' } },
      { call_id: `${id}-child`, parent_call_id: `${id}-mirror`, tool: 'child', status }],
    presentation_blocks: [{ type: 'chart', data: [1, 2] }], result: { approval_id: 'approval' } } },
});
const page = (messages, extra = {}) => ({ ok: true, pagination: 'external_calls_v1', session_id: 'session',
  messages, read_at: 10, history_revision: 0, has_more: true, next_before_cursor: 'before',
  next_after_cursor: 'after', has_newer: false, ...extra });
const scope = (mode = 'replace', extra = {}) => ({ sessionId: 'session', requestGeneration: 1, currentGeneration: 1, mode, ...extra });
function applied(current, data, mode) {
  const result = merge(current, data, scope(mode));
  assert.equal(result.status, 'applied'); return result.state;
}

test('prepend preserves A/B/A order and same-call mirrors; operator messages stay distinct', () => {
  const operator = { message_id: 'operator', role: 'user', content: 'inspect only', history_key: [3, 100, 'operator'],
    meta: { external_request: { sequence: 3, state: 'queued' } } };
  let state = applied(null, page([operator, call('c', 4, 'A')]), 'replace');
  state = applied(state, page([call('a', 1, 'A'), call('b', 2, 'B')], { has_more: false, next_before_cursor: null }), 'older');
  assert.deepEqual(state.messages.map(m => m.message_id), ['a:assistant', 'b:assistant', 'operator', 'c:assistant']);
  const entries = conversationEntries(state.messages.filter(m => m.role === 'assistant').map(m => m.turn.external_call),
    [{ id: 'operator', backend_message_id: 'operator', role: 'user', ts: 100, text: 'inspect only', external_request: { sequence: 3 } }]);
  assert.deepEqual(entries.map(e => e.id), ['a', 'a:a-child', 'b', 'b:b-child', 'operator', 'c', 'c:c-child']);
  assert.equal(state.has_more, false); assert.equal(state.next_after_cursor, 'after');
});

test('running updates replace whole call snapshots by call_id, retaining message identity and approvals', () => {
  let state = applied(null, page([call('a', 1)]), 'replace');
  const update = call('a', 1, 'A', 'awaiting_approval');
  update.message_id = 'changed-envelope';
  update.turn.external_call.nodes.push({ call_id: 'nested', tool: 'child', parent_call_id: 'a-child' });
  state = applied(state, page([], { refreshed_messages: [update], read_at: 20, next_before_cursor: 'wrong' }), 'refresh');
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].message_id, 'a:assistant');
  assert.equal(state.messages[0].turn.external_call.nodes.length, 3);
  assert.equal(state.messages[0].turn.external_call.result.approval_id, 'approval');
  assert.deepEqual(state.messages[0].turn.external_call.presentation_blocks, [{ type: 'chart', data: [1, 2] }]);
  assert.equal(state.next_before_cursor, 'before');
  state = applied(state, page([call('a', 1)], { read_at: 11 }), 'older');
  assert.equal(state.messages[0].turn.external_call.status, 'awaiting_approval');
});

test('delayed requests from switched session/workspace and stale resets are ignored', () => {
  const state = applied(null, page([call('a', 1)], { read_at: 20 }), 'replace');
  assert.equal(merge(state, page([]), scope('older', { currentGeneration: 2 })).status, 'ignored');
  assert.equal(merge(state, page([], { session_id: 'foreign' }), scope('older')).status, 'ignored');
  assert.equal(merge(state, page([call('b', 2)], { read_at: 10 }), scope('replace')).status, 'ignored');
  assert.equal(state.messages[0].message_id, 'a:assistant');
});

test('delete revision requires reset; missing call tombstones reject late page resurrection', () => {
  let state = applied(null, page([call('a', 1)]), 'replace');
  assert.equal(merge(state, page([], { history_revision: 1 }), scope('older')).status, 'reset');
  assert.equal(merge(state, { ok: false, session_id: 'session', code: 'session_deleted' }, scope('older')).status, 'reset');
  state = applied(state, page([], { read_at: 20, missing_call_ids: ['a'] }), 'refresh');
  assert.equal(state.messages.length, 0);
  state = applied(state, page([call('a', 1)], { read_at: 19 }), 'older');
  assert.equal(state.messages.length, 0);
  const reset = applied(state, page([], { read_at: 21, history_revision: 1 }), 'replace');
  assert.equal(merge(reset, page([call('a', 1)], { read_at: 22 }), scope('older')).status, 'ignored');
});

test('newer pages retain older edge; refresh does not append unrelated returned tail', () => {
  let state = applied(null, page([call('a', 1)], { next_before_cursor: 'older-edge' }), 'replace');
  state = applied(state, page([call('b', 2)], { read_at: 11, next_before_cursor: 'wrong', next_after_cursor: 'newer-edge' }), 'newer');
  assert.equal(state.next_before_cursor, 'older-edge');
  assert.equal(state.next_after_cursor, 'newer-edge');
  state = applied(state, page([call('z', 99)], { read_at: 12 }), 'refresh');
  assert.deepEqual(state.messages.map(m => m.message_id), ['a:assistant', 'b:assistant']);
});

test('tail refresh updates a loaded operator acknowledgement without changing its identity', () => {
  const operator = { message_id: 'operator', role: 'user', content: 'inspect', history_key: [2, 100, 'operator'],
    meta: { external_request: { sequence: 2, state: 'queued' } } };
  let state = applied(null, page([call('a', 1), operator]), 'replace');
  state = applied(state, page([{ ...operator, meta: { external_request: { sequence: 2, state: 'acknowledged' } } }], { read_at: 20 }), 'refresh');
  assert.equal(state.messages[1].meta.external_request.state, 'acknowledged');
  assert.equal(state.messages[1].message_id, 'operator');
});
