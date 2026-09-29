const ts=require('typescript');
require.extensions['.ts']=(module,filename)=>{
  const fs=require('fs');module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,filename);
};
const fs=require('fs');
const path=require('path');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {nodError, NOD_BURST}=require('../lib/nodIntent.ts');

test('nod error codes map to bilingual guidance that keeps buttons working',()=>{
  assert.match(nodError(new Error('nod_intent_stale'),true),/审批内容已变化/);
  assert.match(nodError(new Error('nod_intent_stale'),false),/content changed/i);
  assert.match(nodError(new Error('nod_not_detected'),true),/点头/);
  assert.match(nodError(new Error('NotAllowedError'),true),/摄像头权限/);
  const fallback=nodError(new Error('something_unrelated'),true);
  assert.match(fallback,/批准按钮/);
  assert.doesNotMatch(nodError(new Error('nod_intent_used'),false),/undefined/);
});

test('frontend nod burst stays within the backend worker frame contract',()=>{
  const worker=fs.readFileSync(path.join(__dirname,'..','..','nerya','vision','nod_worker.py'),'utf8');
  const min=Number(worker.match(/MIN_FRAMES = (\d+)/)[1]);
  const max=Number(worker.match(/MAX_FRAMES = (\d+)/)[1]);
  assert.ok(NOD_BURST.frames>=min,`burst ${NOD_BURST.frames} must reach backend minimum ${min}`);
  assert.ok(NOD_BURST.frames<=max,`burst ${NOD_BURST.frames} must stay under backend maximum ${max}`);
  assert.ok(NOD_BURST.intervalMs>0&&NOD_BURST.width>=160);
});

test('approval card receipts ride on approve callbacks only',()=>{
  const card=fs.readFileSync(path.join(__dirname,'..','components','chat','ApprovalRequestCard.tsx'),'utf8');
  assert.match(card,/lower\.startsWith\("approve:"\) && isFinancialApproval/);
  assert.match(card,/setNodProof\(null\)/);
  assert.match(card,/nodIntentReceipt: nodProof\.receipt/);
});
