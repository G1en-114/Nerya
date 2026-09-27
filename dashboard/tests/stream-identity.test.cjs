const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const {liveEventsToBlocks}=require('../lib/chat.ts');
test('stream IDs replace final text once while preserving real repeated tokens',()=>{
 const ev=(id,text,mode='append',stream_id='turn:1:1')=>({kind:'message.delta',event_id:id,seq:1,text,mode,stream_id});
 const first=ev('one','ha'),second=ev('two','ha');
 const rows=liveEventsToBlocks([first,second,first,{kind:'turn.step',seq:3,step:{kind:'thinking',detail:{text:'private reasoning'}}},ev('final','haha!','replace'),ev('next','Next','append','turn:2:1')]);
 assert.deepEqual(rows.filter(e=>e.kind==='text').map(e=>e.block.text),['haha!','Next']);
 assert.equal(rows.filter(e=>e.kind==='thinking').length,1);
});
test('an explicit empty final replaces an abandoned streamed draft',()=>{
 const rows=liveEventsToBlocks([{kind:'message.delta',seq:1,stream_id:'s',mode:'append',text:'draft'},{kind:'message.delta',seq:2,stream_id:'s',mode:'replace',text:''}]);assert.equal(rows[0].block.text,'');
});
