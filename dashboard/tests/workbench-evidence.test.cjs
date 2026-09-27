const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const ts=require('typescript');
for(const ext of ['.ts','.tsx'])require.extensions[ext]=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,f);
require.extensions['.css']=m=>{m.exports={};};
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),{NextIntlClientProvider}=require('next-intl');
const {DeliveryEvidence}=require('../components/chat/DeliveryEvidence.tsx');
const {TaskProvenance}=require('../components/chat/TaskProvenance.tsx');
function html(node){return renderToStaticMarkup(React.createElement(NextIntlClientProvider,{locale:'en',messages:{},timeZone:'UTC'},node));}
test('delivery distinguishes test evidence from prose and exposes scoped artifacts',()=>{
 const result={id:'result',title:'Report',text:'Everything is done',ts:1,turnId:'original',evidence:{artifacts:{created:['reports/research.md'],tests_run:[{command:'pytest tests/test_contract.py',exit_code:1,ok:false}],unverified_risks:[{message:'Integration not checked'}]},verifier:{hard_passed:false,hard_status:'failed'}}};
 const output=html(React.createElement(DeliveryEvidence,{result}));
 assert.match(output,/No successful validation evidence/);assert.match(output,/reports\/research.md/);assert.match(output,/exit 1/);assert.match(output,/Integration not checked/);assert.doesNotMatch(output,/successful validation evidence\. See/);
});
test('strategy links preserve candidate and source task identity',()=>{
 const output=html(React.createElement(TaskProvenance,{thread:{id:'task-1',strategy_id:'strategy-1',strategy_proposal_id:'proposal-1',messages:[]}}));
 assert.match(output,/strategy_id=strategy-1/);assert.match(output,/proposal_id=proposal-1/);assert.match(output,/session_id=task-1/);assert.match(output,/Candidate version/);
});

const { taskEntryTitle } = require('../lib/workbench.ts');
test('legacy session titles resolve from meta before reaching rename controls',()=>{
 assert.equal(taskEntryTitle({meta:{title:'Existing research task'}}),'Existing research task');
 assert.equal(taskEntryTitle({title:'Current title',meta:{title:'Old title'}}),'Current title');
 assert.equal(taskEntryTitle({title:null,meta:{}}),'');
});
