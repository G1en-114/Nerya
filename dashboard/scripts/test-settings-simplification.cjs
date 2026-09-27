const fs = require('node:fs');
const assert = require('node:assert/strict');
const Module = require('node:module');
const ts = require('typescript');
for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, f);
require.extensions['.css'] = m => { m.exports = { default: {} }; };
const load = Module._load;
Module._load = function (id, parent, ...args) {
  if (id === './WorkflowCanvas') return { useWorkflowText: () => (key) => ({
    'copy.components_workflows_WorkflowAgentSettings.022': 'Analysis context',
    'copy.components_workflows_WorkflowAgentSettings.023': 'Analysis context',
    'copy.workflowSettings.fields.agentExecution.max_wall_seconds': 'Run time limit (seconds)',
  }[key] || key) };
  if (id === 'next-intl') return { useLocale: () => 'en' };
  if (id === '../../lib/i18n') return { copy: (_zh, key) => ({
    'copy.components_settings_PrimaryModelSettings.002': 'Fallback model (optional)',
  }[key] || key) };
  return load.call(this, id, parent, ...args);
};
const { WorkflowAgentSettings } = require('../components/workflows/WorkflowAgentSettings.tsx');
const { PrimaryModelSettings } = require('../components/settings/PrimaryModelSettings.tsx');
const { detectBrowserLanguage, loadSettings, patchSettings } = require('../lib/settings.ts');
function elements(node, out = []) {
  if (Array.isArray(node)) node.forEach(n => elements(n, out));
  else if (node && typeof node === 'object' && node.props) { out.push(node); elements(node.props.children, out); }
  return out;
}
const checks = [];
function check(name, fn) { fn(); checks.push(name); }
check('existing expert context and unrelated restrictions survive edits', () => {
  const config = { agent_session: { policy: 'per_strategy_market', include_prior_messages: false, custom_tag: 'keep' }, agent_execution: { max_iterations: 7, denied_tools: ['dangerous'], team: { role_policies: { researcher: { max_skill_calls: 9 } } } }, agent_profile: { role: 'review' } };
  let next;
  const tree = elements(WorkflowAgentSettings({ config, nodes: [], defaults: { max_iterations: 120, max_wall_seconds: 1800 }, disabled: false, onChange: v => { next = v; } }));
  const context = tree.find(n => n.props['aria-label'] === 'Analysis context');
  assert.equal(context.props.value, 'advanced');
  context.props.onValueChange('per_signal');
  assert.deepEqual(next.agent_session, { policy: 'per_signal', include_prior_messages: true, custom_tag: 'keep' });
  assert.deepEqual(next.agent_execution, config.agent_execution);
  assert.equal(config.agent_session.policy, 'per_strategy_market');
  const wall = tree.find(n => n.props['aria-label'] === 'Run time limit (seconds)');
  wall.props.onChange({ target: { value: '' } });
  assert.equal(next.agent_execution.max_wall_seconds, null);
  assert.equal(next.agent_execution.max_iterations, 7);
});
check('fallback cannot be configured without a primary model', () => {
  const tree = elements(PrimaryModelSettings({ routes: [], catalog: { openai: ['m'] }, disabled: false, onChange() {} }));
  assert.equal(tree.find(n => n.props['aria-label'] === 'Fallback model (optional)').props.disabled, true);
});
check('stored obsolete preferences are dropped without losing chart choices', () => {
  let raw = JSON.stringify({ compact: true, marketStream: 'pro', refreshSeconds: 60, kline: { symbol: 'ETHUSDT', count: 192 }, darkMode: false });
  global.window = { localStorage: { getItem: () => raw, setItem: (_k, value) => { raw = value; } }, dispatchEvent() {} };
  const settings = loadSettings();
  assert.equal(settings.darkMode, 'light');
  assert.equal(settings.kline.symbol, 'ETHUSDT');
  assert.equal(settings.compact, undefined);
  assert.equal(settings.marketStream, undefined);
  patchSettings({ language: 'zh' });
  const saved = JSON.parse(raw);
  assert.equal(saved.kline.count, 192);
  assert.equal(saved.refreshSeconds, 60);
  assert.equal(saved.compact, undefined);
});
check('browser language uses the first supported preference', () => {
  const descriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
  Object.defineProperty(global, 'navigator', { configurable: true, value: { languages: ['en-US', 'zh-CN'], language: 'en-US' } });
  assert.equal(detectBrowserLanguage(), 'en');
  Object.defineProperty(global, 'navigator', { configurable: true, value: { languages: ['fr-FR', 'zh-CN'], language: 'fr-FR' } });
  assert.equal(detectBrowserLanguage(), 'zh');
  if (descriptor) Object.defineProperty(global, 'navigator', descriptor); else delete global.navigator;
});
console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
