const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText, f);
require.extensions['.css'] = m => { m.exports = {}; };
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { NextIntlClientProvider } = require('next-intl');
const { InteractionPanel } = require('../components/chat/InteractionPanel.tsx');
const { settleSnapshotPending } = require('../components/chat/useConversationCommands.ts');
const commands = require('../lib/conversationCommands.ts');
const { setWorkspaceIdentity } = require('../lib/workspaceIdentity.ts');

test('snapshot ACK settlement matches both session and command and never resends', () => {
  const values = new Map();
  const events = [];
  global.window = { dispatchEvent: event => events.push(event.type) };
  global.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
    key: index => [...values.keys()][index],
    get length() { return values.size; },
  };
  const originalFetch = global.fetch;
  global.fetch = () => { throw new Error('ACK settlement must not use the network'); };
  setWorkspaceIdentity('fixture-workspace');
  events.length = 0;
  try {
    for (const [id, sid] of [['ack-queued', 'session-a'], ['ack-guide', 'session-a'], ['ack-unknown', 'session-a'], ['ack-other', 'session-b']]) {
      localStorage.setItem('nerya.chat.pending-command.v2:'+id, JSON.stringify({
        workspace_id: 'fixture-workspace', command_id: id, session_id: sid, command_type: id==='ack-guide'?'guide':'send', request: { payload: { text: id } }, created_at: 1,
      }));
    }
    settleSnapshotPending('session-a', [
      { command_id: 'ack-queued', session_id: 'session-a', state: 'queued' },
      { command_id: 'ack-guide', session_id: 'session-a', state: 'injected', kind: 'guide' },
      { command_id: 'ack-other', session_id: 'session-b', state: 'succeeded' },
      { command_id: 'ack-unknown', session_id: 'session-b', state: 'succeeded' },
    ]);
    assert.deepEqual(commands.pendingCommands().map(item => item.command_id).sort(), ['ack-other', 'ack-unknown']);
    assert.equal(events.length, 2);
    settleSnapshotPending('session-a', [{ command_id: 'ack-queued', session_id: 'session-a' }]);
    assert.equal(events.length, 2);
  } finally {
    for (const item of commands.pendingCommands()) commands.settlePending(item.command_id);
    setWorkspaceIdentity(null);
    delete global.window; delete global.localStorage; global.fetch = originalFetch;
  }
});

test('plan review renders explicit accept, revise, reject and defer actions', () => {
  const output = renderToStaticMarkup(React.createElement(NextIntlClientProvider, { locale: 'en', messages: {}, timeZone: 'UTC' },
    React.createElement(InteractionPanel, { onResolved() {}, items: [{
      interaction_id: 'interaction-plan', session_id: 'session-a', turn_id: 'turn-a', kind: 'plan',
      state: 'pending', revision: 1, payload: { title: 'Review plan', steps: ['Read current source', 'Report evidence'] },
    }] })));
  assert.match(output, /Accept plan and start/);
  assert.match(output, /Revise plan/);
  assert.match(output, /Reject plan/);
  assert.match(output, /Handle later/);
  assert.match(output, /Revision feedback or additional details/);
  assert.match(output, /disabled=""[^>]*>Revise plan/);
});
