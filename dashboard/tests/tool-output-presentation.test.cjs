const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),ts=require('typescript');
for(const ext of ['.ts','.tsx'])require.extensions[ext]=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,f);
require.extensions['.css']=m=>{m.exports={};};
const {contentValue}=require('../lib/agentConversation.ts');
const {readJsonPrefix,legacyToolValue,diffLines,interactionReceipt,reasoningPreview}=require('../lib/toolOutputPresentation.ts');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),{NextIntlClientProvider}=require('next-intl');
const {ToolResultContent}=require('../components/chat/ToolResultContent.tsx');
const messages=Object.assign({},...fs.readdirSync(__dirname+'/../messages/en').filter(f=>f.endsWith('.json')).map(f=>require('../messages/en/'+f)));
const html=(value,family='tool')=>renderToStaticMarkup(React.createElement(NextIntlClientProvider,{locale:'en',messages,timeZone:'UTC'},React.createElement(ToolResultContent,{value,family})));
const diff='--- a/main.py\n+++ b/main.py\n@@ -1,2 +1,3 @@\n-# old\n+# @nerya.title New strategy\n+print("new")\n unchanged\n';

test('typed native diff is never flattened into Markdown',()=>{
 const value={content:[{type:'diff',text:diff,metadata:{path:'strategies/main.py'}}]};
 assert.deepEqual(contentValue(value),value);
 const output=html(value,'edit');
 assert.match(output,/data-testid="tool-diff-preview"/);assert.match(output,/@nerya.title/);assert.doesNotMatch(output,/<h[1-6]/);
});
test('legacy string diffs get the same line-numbered renderer',()=>{
 const output=html(diff,'edit');assert.match(output,/tool-diff-preview/);assert.doesNotMatch(output,/<h[1-6]/);
 assert.deepEqual(diffLines(diff).filter(row=>row.kind==='added').map(row=>row.newLine),[1,2]);
 assert.equal(diffLines(diff).at(-1).oldLine,2);assert.equal(diffLines(diff).at(-1).newLine,3);
});
test('legacy diff metadata is separated from source code, not appended as a code line',()=>{
 const value=diff+'\n'+JSON.stringify({path:'strategies/main.py',bytes_after:200,lines_after:3});
 const normalized=legacyToolValue(value);assert.equal(normalized.content[0].type,'diff');assert.equal(normalized.content[1].type,'json');
 const output=html(value,'edit');assert.match(output,/tool-diff-preview/);assert.match(output,/File lines/);assert.doesNotMatch(output,/&quot;bytes_after&quot;/);
});
test('typed display payload survives the live-event projection',()=>{
 const {liveEventsToBlocks}=require('../lib/chat.ts');
 const display={content:[{type:'diff',text:diff}]};
 const [row]=liveEventsToBlocks([{kind:'tool.complete',seq:1,call_id:'edit',action:'edit_file',ok:true,result:'old text',display_result:display}]);
 assert.deepEqual(row.block.display_result,display);assert.equal(row.block.result,'old text');
});
test('compacted JSON and native JSON parts render fields, not transport prose',()=>{
 const value='strategy_create: ready\n[compacted_kept]\n'+JSON.stringify({strategy_id:'alpha_trend',main_path:'strategies/alpha_trend/main.py',next_steps:['Edit staged files']});
 assert.equal(legacyToolValue(value).strategy_id,'alpha_trend');
 const output=html(value,'strategy');assert.match(output,/alpha_trend/);assert.match(output,/main.py/);assert.doesNotMatch(output,/compacted_kept|&quot;strategy_id&quot;|<h3/);
 assert.match(html({content:[{type:'json',data:{summary:'Native result',count:3}}]}),/Native result/);
});
test('JSON parser respects quoted braces and rejects partial/trailing malformed content',()=>{
 const source='{"text":"brace } and \\"quote","nested":[{"v":1}]} remainder';
 const parsed=readJsonPrefix(source);assert.equal(parsed.value.nested[0].v,1);assert.equal(source.slice(parsed.end),' remainder');
 assert.equal(readJsonPrefix('{"a":'),null);
 assert.equal(legacyToolValue('Normal prose with {braces}'),'Normal prose with {braces}');
});
test('question receipt only shows recorded answers and never assumes defaults',()=>{
 const response={action:'answer',answers:{timeframe:{selected:['4 hours'],text:''},risk:{selected:[],text:'Use capped risk'}}};
 const questions=[{id:'timeframe',question:'Which timeframe?',options:['1 hour (default)','4 hours']},{id:'risk',question:'Risk budget?'},{id:'validation',question:'Which validation?'}];
 const text='User response to Strategy preferences: '+JSON.stringify(response)+' Questions: '+JSON.stringify(questions)+' Omitted answers are unknown. Continue using best judgment within existing permissions. This is not approval for trading or other gated actions.';
 const receipt=interactionReceipt(text);assert.equal(receipt.title,'Strategy preferences');
 assert.deepEqual(receipt.rows.map(row=>row.answers),[['4 hours'],['Use capped risk'],[]]);
 assert.equal(interactionReceipt('Please explain User response to ...'),null);
 assert.equal(interactionReceipt('User response to broken: {"answers":'),null);
 assert.equal(interactionReceipt('User response to Example: {"action":"answer"} Please keep this important explanation.'),null);
 assert.equal(interactionReceipt('User response to Example: {"action":"answer"} Questions: [{"id":'),null);
});
test('thinking preview follows the newest nonempty line rather than a frozen prefix',()=>{
 assert.equal(reasoningPreview('first thought\n\n最新检查🙂\n'),'最新检查🙂');
 assert.equal(reasoningPreview('## Check the data'),'Check the data');
});
test('mixed MCP text, image and resource content stays readable without JSON leaking',()=>{
 const output=html({content:[{type:'text',text:'{"summary":"Actual summary","count":2}'},{type:'resource',resource:{uri:'fixture://source',text:'Source code'}}]},'mcp');
 assert.match(output,/Actual summary/);assert.match(output,/Source code/);assert.doesNotMatch(output,/&quot;summary&quot;/);
});

test('typed shell final snapshot replaces live fragments and avoids repeated transport text',()=>{
 const {ToolActivity}=require('../components/chat/ReadableExecution.tsx');
 const {executionSteps}=require('../lib/executionTimeline.ts');
 const step=executionSteps([
  {block:{kind:'tool_use',call_id:'shell',action:'run_shell',payload:{command:'verify'},stdout:'STALE_PARTIAL_OUTPUT'}},
  {block:{kind:'tool_result',call_id:'shell',ok:true,result:'legacy duplicate',display_result:{content:[{type:'shell',data:{stdout:'FINAL_COMPLETE_OUTPUT',stderr:'',exit_code:0}},{type:'text',text:'duplicate text'}]}}},
  ])[0];
 const render=()=>renderToStaticMarkup(React.createElement(NextIntlClientProvider,{locale:'en',messages,timeZone:'UTC'},React.createElement(ToolActivity,{step,state:'succeeded',open:true})));
 assert.match(render(),/FINAL_COMPLETE_OUTPUT/);assert.doesNotMatch(render(),/STALE_PARTIAL_OUTPUT|legacy duplicate|duplicate text/);
 step.data.display_result.content[0].data.stdout='';
 assert.doesNotMatch(render(),/STALE_PARTIAL_OUTPUT|FINAL_COMPLETE_OUTPUT|duplicate text/);
});
