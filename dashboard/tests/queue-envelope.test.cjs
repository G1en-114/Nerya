const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true };
for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions }).outputText, f);
require.extensions['.css'] = m => { m.exports = {}; };
const commands = require('../lib/conversationCommands.ts');
const identity = require('../lib/workspaceIdentity.ts');
const edits = require('../lib/editDrafts.ts');
beforeEach(() => {
  const values = new Map();
  global.sessionStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  global.window = { dispatchEvent() {} };
  identity.setWorkspaceIdentity('queue-fixture');
});
afterEach(() => { identity.setWorkspaceIdentity(null); delete global.window; delete global.sessionStorage; });
const command = () => ({ command_id: 'command-fixture', session_id: 'session-fixture', kind: 'send', state: 'queued', revision: 2,
  input: 'original', attachments: [], context: { work_mode: 'plan' }, editable_settings: { work_mode: 'plan', model_id: 'old-model' } });
const attachment = { id: 'file-1', name: 'proof.txt', kind: 'document', mime_type: 'text/plain', size: 7, artifact_uri: 'nerya://artifact/attachments/uploads/test/proof.txt' };

function fixture(file, exportName, props) {
  let cursor = 0, slots = [];
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useEffect() {},
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
  };
  const filename = path.resolve(__dirname, '../components/chat/' + file + '.tsx');
  const m = new Module(filename, module); m.filename = filename; m.paths = module.paths;
  m.require = name => {
    if (name === 'react') return hooks;
    if (name === 'next-intl') return { useLocale: () => 'en', useMessages: () => ({ chat: {} }), NextIntlClientProvider: 'provider' };
    if (name.endsWith('/workspaceIdentity')) return { ...identity, useWorkspaceIdentity: () => identity.getWorkspaceIdentity() };
    if (name === './useUnsavedChanges') return { useUnsavedChanges() {} };
    if (name === './ChatInput') return { ChatInput: 'composer' };
    if (name === './QueueEnvelopeEditor') return { QueueEnvelopeEditor: 'editor' };
    if (name === './ComposerRunControls') return { ComposerModelMenu: 'model' };
    return Module.createRequire(filename)(name);
  };
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions, reportDiagnostics: true });
  assert.deepEqual(output.diagnostics, []);
  m._compile(output.outputText, filename);
  return { render() { cursor = 0; return m.exports[exportName](props); }, props };
}
function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(item => nodes(item, predicate));
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
const composer = tree => nodes(tree, node => node.type === 'composer')[0].props;
const tick = () => new Promise(resolve => setImmediate(resolve));

test('edit envelope only carries allowed changed settings and saved attachment references', () => {
  const original = command();
  const draft = commands.queueEditDraft(original);
  draft.text = 'edited'; draft.attachments = [{ ...attachment, data_url: 'preview-only', text: 'secret preview' }];
  draft.settings = { ...draft.settings, model_id: 'new-model', work_mode: 'execute', reasoning_effort: 'high', evidence_contract: { injected: true } };
  const payload = commands.queueEditRequest(original, draft);
  assert.equal(payload.model_id, 'new-model'); assert.equal(payload.work_mode, 'execute');
  assert.equal(payload.reasoning_summary, 'auto'); assert.equal(payload.payload.text, 'edited');
  assert.equal(payload.payload.attachments[0].artifact_uri, attachment.artifact_uri);
  for (const key of ['permission_mode', 'evidence_contract', 'source', 'actor_id', 'turn_id']) assert.equal(payload[key], undefined);
  assert.equal(payload.payload.attachments[0].data_url, undefined); assert.equal(payload.payload.attachments[0].text, undefined);
});

test('real editor saves once with original identity and all edited fields; a conflict retains the draft', async () => {
  const original = command(), calls = [];
  const props = { command: original, current: original, onClose() { throw Error('Conflict must not close'); },
    async onSave(...args) { calls.push(args); throw new commands.CommandClientError('command_revision_conflict'); } };
  const view = fixture('QueueEnvelopeEditor', 'QueueEnvelopeEditor', props);
  composer(view.render()).onChange('new text');
  let input = composer(view.render()); input.onSettingsChange({ ...input.settings, model_id: 'new-model' });
  composer(view.render()).onAttachmentsChange([{ ...attachment, data_url: 'preview only' }]);
  composer(view.render()).onSend(); await tick();
  assert.equal(calls.length, 1); assert.equal(calls[0][0].command_id, original.command_id);
  assert.equal(calls[0][0].revision, original.revision); assert.equal(calls[0][1].payload.text, 'new text');
  assert.equal(calls[0][1].model_id, 'new-model');
  const saved = edits.readEditDraft('queue:' + original.command_id);
  assert.equal(saved.text, 'new text'); assert.equal(saved.attachments[0].artifact_uri, attachment.artifact_uri);
  assert.equal(saved.attachments[0].data_url, undefined); assert.equal(saved.settings.model_id, 'new-model');
  props.current = { ...original, state: 'running', revision: 3 };
  assert.equal(composer(view.render()).locked, true);
  const recovered = fixture('QueueEnvelopeEditor', 'QueueEnvelopeEditor', props);
  assert.equal(composer(recovered.render()).value, 'new text');
  assert.equal(composer(recovered.render()).settings.model_id, 'new-model');
});

test('stale draft requires explicit rebase before save and keeps edited model and attachments', async () => {
  const original = command();
  edits.writeEditDraft('queue:' + original.command_id, { ...commands.queueEditDraft(original), revision: 1, text: 'saved edit', attachments: [attachment] });
  let saved, closed = 0;
  const view = fixture('QueueEnvelopeEditor', 'QueueEnvelopeEditor', { command: original, current: original, onClose() { closed++; },
    async onSave(...args) { saved = args; } });
  let tree = view.render(); assert.equal(composer(tree).locked, true);
  nodes(tree, node => node.type === 'button' && node.props.children === 'Keep draft and edit against current version')[0].props.onClick();
  tree = view.render(); assert.equal(composer(tree).locked, false); composer(tree).onSend(); await tick();
  assert.equal(saved[0].revision, 2); assert.equal(saved[1].payload.text, 'saved edit');
  assert.equal(saved[1].payload.attachments.length, 1); assert.equal(closed, 1);
  assert.equal(edits.readEditDraft('queue:' + original.command_id), null);
});

test('controls keep the editor mounted after its command leaves the queue, and never allow decision edit', () => {
  const original = command();
  const engine = { commands: [original], pending: [], connection: 'online', data: { queue: { paused: true } } };
  const view = fixture('ConversationControls', 'ConversationControls', { engine, onContinue() {}, onReuse() {} });
  let tree = view.render();
  nodes(tree, node => node.type === 'button' && node.props.children === 'Edit')[0].props.onClick();
  engine.commands = [{ ...original, state: 'running', revision: 3 }];
  tree = view.render(); assert.equal(nodes(tree, node => node.type === 'editor').length, 1);
  assert.equal(nodes(tree, node => node.type === 'editor')[0].props.current.state, 'running');
  engine.commands = [{ ...original, queue_editable: false }];
  assert.equal(nodes(view.render(), node => node.type === 'button' && node.props.children === 'Edit')[0].props.disabled, true);
});
