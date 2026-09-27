const fs = require('node:fs'), ts = require('typescript'), assert = require('node:assert/strict');
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, f);
const { parseScriptDocumentation } = require('../lib/scriptDocumentation.ts');
const { reviewExplanation, timelineReview } = require('../lib/reviewExplanation.ts');
const { cardTitle, cardPurpose } = require('../lib/workflowPresentation.ts');
const lines = (...values) => values.join(String.fromCharCode(10));
const source = lines(
  '# @nerya.version 1', '# @nerya.title Closed candles',
  '# @nerya.description Only process a closed signal.',
  '# @nerya.logic Exclude forming candles, then compare signals.',
  '# @nerya.rationale Avoid repeated decisions.', '# @nerya.scope Signal branch only',
  '# @nerya.change Candle filter | Last candle | Last closed candle | Ignore forming bars',
  '# @nerya.validation Not run',
  '# @nerya.step read | Read closed bars | Filter forming candles',
  '# @nerya.next stop | No closed bars', '# @nerya.step stop | Stop | Explain missing history',
  'def run(ctx): pass',
);
const doc = parseScriptDocumentation(source);
assert.equal(doc.logic, 'Exclude forming candles, then compare signals.');
assert.equal(doc.changes[0].reason, 'Ignore forming bars');
assert.deepEqual(doc.steps[0].next, [{ id: 'stop', condition: 'No closed bars' }]);
assert.equal(doc.warnings, 0);
assert.equal(parseScriptDocumentation(lines('example = """', '# @nerya.title Wrong', '"""', source)).title, 'Closed candles');
assert.equal(parseScriptDocumentation(lines('"""Legacy explanation."""', 'def run(ctx): pass')).description, 'Legacy explanation.');
assert.equal(parseScriptDocumentation(lines('# @nerya.step a | A', '# @nerya.next missing', '# @nerya.step a | Duplicate')).warnings, 2);
assert.equal(parseScriptDocumentation('# @nerya.change missing fields').warnings, 1);
assert.equal(parseScriptDocumentation('# @nerya.unknown X').warnings, 1);
const node = { kind: 'script', content: source, title: 'main.py', resource: 'main.py' };
assert.equal(cardTitle(node, (s) => s), 'Closed candles');
assert.equal(cardPurpose(node, (s) => s), 'Only process a closed signal.');
const output = { summary: 'Use closed bars.', expected_effect: { return: 0, reduced_risk: false }, proposed_changes: [{ file: 'main.py', rationale: 'Avoid noise', after_content: 'RAW_SOURCE', before_summary: 'Last bar', after_summary: 'Closed bar', scope: ['Signal'] }] };
const review = reviewExplanation({ dropped_changes: [{ entry: { file: 'main.py' }, reason: 'guardrail' }] }, JSON.stringify(output));
assert.equal(review.summary, 'Use closed bars.');
assert.equal(review.changes[0].rejected, true);
assert.equal(review.changes[0].before, 'Last bar');
assert.deepEqual(review.expected, [['return', '0'], ['reduced_risk', 'false']]);
assert.ok(!JSON.stringify(review).includes('RAW_SOURCE'));
assert.equal(reviewExplanation({}, { proposed_changes: [] }).changesRecorded, true);
assert.equal(reviewExplanation({}, 'broken JSON').changesRecorded, false);
assert.deepEqual(reviewExplanation({}, { expected_effect: '' }).expected, []);
assert.equal(reviewExplanation({subagent_output: {}}, output).summary, 'Use closed bars.');
const timeline = timelineReview({ summary: 'Fallback', process: { sections: [{ artifacts: [{ kind: 'output', preview: JSON.stringify(output) }] }] } });
assert.equal(reviewExplanation(timeline.record, timeline.output).summary, 'Use closed bars.');
const longTimeline = timelineReview({summary: 'Fallback', process: {sections: [{artifacts: [{kind: 'output', truncated: true, preview: 'invalid json', metadata: {review_explanation: output}}]}]}});
assert.equal(reviewExplanation(longTimeline.record, longTimeline.output).summary, 'Use closed bars.');
console.log('Strategy explanation contracts passed: annotations, legacy fallback, workflow labels, review scope, rejected changes, and raw-source exclusion.');
