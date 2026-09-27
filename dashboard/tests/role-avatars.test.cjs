const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText, filename);
const { roles, resolve, path, resolveWorkflowRole } = require('../lib/roleAvatars.ts');
const { RoleAvatar } = require('../components/RoleAvatar.tsx');
const { WorkspaceTabs } = require('../components/chat/WorkspaceTabs.tsx');

test('the 20 role names preserve the asset contract', () => {
  assert.deepEqual(roles, 'lead researcher analyst reviewer risk coder macro quant execution data sentiment onchain portfolio backtest security connector prediction futures equities evolution'.split(' '));
  assert.equal(new Set(roles).size, 20);
  for (const role of roles) {
    assert.equal(resolve(role), role);
    assert.equal(path(role), `assets/agent-avatars/${role}.png`);
  }
});

test('specific bilingual role names win over generic research and analysis', () => {
  for (const [name, role] of [
    ['risk_critic', 'risk'], ['市场研究员', 'researcher'], ['market', 'analyst'], ['coding agent', 'coder'],
    ['macroResearcher', 'macro'], ['宏观分析师', 'macro'], ['quant_researcher', 'quant'], ['因子研究员', 'quant'],
    ['data_analyst', 'data'], ['sentiment analyst', 'sentiment'], ['on-chain researcher', 'onchain'],
    ['portfolio reviewer', 'portfolio'], ['backtesting agent', 'backtest'], ['security_reviewer', 'security'],
    ['connector developer', 'connector'], ['prediction_market', 'prediction'], ['futures analyst', 'futures'],
    ['equities analyst', 'equities'], ['self-evolution', 'evolution'], ['execution trader', 'execution'],
    ['复核员', 'reviewer'], ['主控', 'lead'], ['ＮＥＲＹＡ', 'lead'],
  ]) assert.equal(resolve(name), role, name);
});

test('unknown names use a stable normalized member of the 20 roles', () => {
  for (const name of ['Aurora', 'Orion', '自定义角色甲', '../../unknown<script>', '😀']) {
    assert(roles.includes(resolve(name)));
    assert.equal(resolve(name), resolve(name));
    assert.match(path(name), /^assets\/agent-avatars\/[a-z]+\.png$/);
  }
  assert.equal(resolve(' ORION '), resolve('orion'));
  assert.equal(resolve('unknown_role'), resolve('unknown-role'));
  assert.equal(resolve(''), 'lead');
  assert.equal(resolve(null), 'lead');
});

test('workflow resources, custom labels and replay call IDs preserve the actual role identity', () => {
  assert.equal(resolveWorkflowRole({ resource: 'runtime', title: 'Custom strategy title' }), 'lead');
  assert.equal(resolveWorkflowRole({ resource: 'role/risk_critic', title: 'My reviewer' }), 'risk');
  assert.equal(resolveWorkflowRole({ resource: 'role/Orion', title: 'Custom label' }), resolve('Orion'));
  assert.equal(resolveWorkflowRole({ resource: 'prompt/prompts/Orion.agent.md', title: 'Custom label' }), resolve('Orion'));
  assert.equal(resolveWorkflowRole({ resource: 'call:123', title: 'macro_researcher' }), 'macro');
  assert.equal(resolveWorkflowRole({ resource: 'tuner', title: 'strategy_tuner' }), 'evolution');
});

test('portrait rendering has local src, accessible alt, explicit sizing and decorative mode', () => {
  const html = renderToStaticMarkup(React.createElement(RoleAvatar, { role: 'risk_critic', size: 36, alt: 'Risk reviewer' }));
  assert.match(html, /src="\/branding\/agents\/risk.png"/);
  assert.match(html, /alt="Risk reviewer"/);
  assert.match(html, /width="36" height="36"/);
  assert.match(html, /flex-shrink:0/);
  assert.doesNotMatch(html, /aria-hidden|https?:|dicebear/i);
  const decorative = RoleAvatar({ role: 'coder', alt: '', size: NaN });
  assert.equal(decorative.props['aria-hidden'], true);
  assert.equal(decorative.props.width, 28);
  assert.equal(RoleAvatar({ role: 'Aurora' }).props.alt, 'Aurora');
});

test('member tabs render one decorative portrait without changing keyboard/a11y metadata', () => {
  const html = renderToStaticMarkup(React.createElement(WorkspaceTabs, {
    id: 'members', label: 'Team', value: 'risk', onChange() {},
    tabs: [{ id: 'risk', label: 'Risk reviewer', portrait: React.createElement(RoleAvatar, { role: 'risk', alt: '' }) }],
  }));
  assert.equal((html.match(/<img/g) || []).length, 1);
  assert.match(html, /aria-controls="members-panel-risk"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /Risk reviewer/);
});
