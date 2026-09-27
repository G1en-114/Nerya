const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const { buildChatModelOptions, DEFAULT_CHAT_RUN_SETTINGS } = require('../lib/chat.ts');

test('unknown defaults remain inherit/automatic, not a claimed 1M capability', () => {
  assert.equal(DEFAULT_CHAT_RUN_SETTINGS.reasoning_effort, 'inherit');
  assert.equal(DEFAULT_CHAT_RUN_SETTINGS.model_context_window, 0);
  assert.equal(buildChatModelOptions({ models: { providers: { fixture: [{ id: 'unknown' }] } } })[0].model_context_window, undefined);
});

test('catalog legacy length preserves exact decimal token limit', () => {
  const [model] = buildChatModelOptions({ models: { providers: { fixture: [{ id: 'small', context_length: 128000 }] } } });
  assert.equal(model.model_context_window, 128000);
});

test('exact route policy takes precedence and catalog bounds synthetic tier window', () => {
  const options = buildChatModelOptions({
    tiers: { tiers: [{ tier: 'medium', provider: 'fixture', model: 'B', reasoning_effort: 'low', context_window: 1048576 }] },
    config: { tiers: [{ tier: 'medium', reasoning_effort: 'high', routes: [
      { provider: 'fixture', model: 'A', reasoning_effort: 'none', context_window: 1000000 },
      { provider: 'fixture', model: 'B', reasoning_effort: 'extra_high', context_window: 1048576 },
    ] }] },
    models: { providers: { fixture: [{ id: 'B', context_length: 8192 }] } },
  });
  assert.equal(options.length, 2);
  assert.equal(options[0].reasoning_effort, 'off');
  assert.equal(options[0].model_context_window, 1000000);
  assert.equal(options[1].reasoning_effort, 'xhigh');
  assert.equal(options[1].model_context_window, 8192);
});
