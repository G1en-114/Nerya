const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const ts=require('typescript');
for(const ext of ['.ts','.tsx'])require.extensions[ext]=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,f);
const identity=require('../lib/workspaceIdentity.ts');const chat=require('../lib/chat.ts');
test('history, transcript, active task and model preferences are isolated by runtime workspace',()=>{
 const values=new Map();global.window={dispatchEvent(){},addEventListener(){},removeEventListener(){}};global.localStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 try{
  identity.setWorkspaceIdentity(null);localStorage.setItem('nerya.chat.threads.v1',JSON.stringify([{id:'old',messages:[]} ]));assert.deepEqual(chat.loadThreads(),[]);
  identity.setWorkspaceIdentity('workspace-a');const thread={...chat.newThread('A'),id:'same',messages:[{id:'a',role:'user',text:'private A',ts:1}]};chat.saveThreads([thread]);chat.cacheThreadTranscript(thread);chat.saveActiveId('same');chat.saveRunSettings({...chat.DEFAULT_CHAT_RUN_SETTINGS,model_id:'model-a'});
  identity.setWorkspaceIdentity('workspace-b');assert.deepEqual(chat.loadThreads(),[]);assert.equal(chat.loadCachedThreadTranscript('same'),null);assert.equal(chat.loadActiveId(),null);assert.notEqual(chat.loadRunSettings().model_id,'model-a');chat.rememberDeletedSession('same');
  identity.setWorkspaceIdentity('workspace-a');assert.equal(chat.loadThreads()[0].messages[0].text,'private A');assert.equal(chat.loadCachedThreadTranscript('same').messages[0].text,'private A');assert.equal(chat.loadActiveId(),'same');assert.equal(chat.loadRunSettings().model_id,'model-a');assert.equal(chat.loadDeletedSessionIds().has('same'),false);
 }finally{identity.setWorkspaceIdentity(null);delete global.window;delete global.localStorage;}
});
