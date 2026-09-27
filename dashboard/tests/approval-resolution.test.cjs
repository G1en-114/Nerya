const ts=require('typescript');
require.extensions['.ts']=(module,filename)=>{
  const fs=require('fs');module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,filename);
};
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {resolveMessageApproval}=require('../lib/approvalResolution.ts');
test('restored block-only approval resolves without ephemeral live events',()=>{
  const original={id:'message',role:'assistant',turn:{blocks:[{kind:'approval_request',block:{kind:'approval_request',approval_id:'approved-id',state:'pending'}}]}};
  const next=resolveMessageApproval(original,'approved-id','approved');
  assert.equal(next.turn.blocks[0].block.state,'approved');
  assert.equal(next.live_events[0].kind,'approval.resolved');
  assert.equal(original.turn.blocks[0].block.state,'pending');
  assert.equal(resolveMessageApproval(next,'approved-id','approved'),next);
});
test('unknown approval IDs never close another permission request',()=>{
  const message={id:'message',role:'assistant',live_events:[{kind:'approval.request',approval_id:'first'}]};
  assert.equal(resolveMessageApproval(message,'other','approved'),message);
  assert.equal(resolveMessageApproval(message,'first','pending'),message);
});
