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

function withCache(run) {
 const values = new Map();
 global.window = {dispatchEvent(){}, addEventListener(){}, removeEventListener(){}};
 global.localStorage = {getItem:k=>values.get(k)??null, setItem:(k,v)=>values.set(k,String(v)), removeItem:k=>values.delete(k)};
 identity.setWorkspaceIdentity('cache-test');
 try { run(values); }
 finally { identity.setWorkspaceIdentity(null); delete global.window; delete global.localStorage; }
}
const historyKey = () => identity.workspaceStorageKey('nerya.chat.threads.v1:workspace:', 'cache-test');
const transcriptKey = id => identity.workspaceStorageKey('nerya.chat.transcript.v2:', 'cache-test', id);
const validThread = () => ({...chat.newThread('Keep this conversation'), id:'keep',
 messages:[{id:'message', role:'user', text:'Retain my message', ts:1}]});

test('malformed history rows do not hide good conversations or erase the raw cache', () => withCache(values => {
 const good = validThread();
 const broken = {id:'recover', title:'Load from backend', message_count:12, messages:null,
  transcript_loaded:true, transcript_cached_at:10, strategy_id:'strategy-original'};
 const raw = JSON.stringify([null, 42, [], {}, {id:' '}, broken, good]);
 values.set(historyKey(), raw);
 const rows = chat.loadThreads();
 assert.deepEqual(rows.map(row=>row.id), ['recover','keep']);
 assert.deepEqual(rows[1].messages, good.messages);
 assert.equal(rows[0].strategy_id, 'strategy-original');
 assert.equal(rows[0].message_count, 12);
 assert.deepEqual(rows[0].messages, []);
 assert.equal(rows[0].transcript_loaded, false);
 assert.equal(rows[0].imported, true);
 assert.equal(rows[0].transcript_cached_at, undefined);
 assert.equal(values.get(historyKey()), raw);
}));

test('missing, null and non-array responses never overwrite a good transcript', () => withCache(values => {
 const good = validThread();
 chat.cacheThreadTranscript(good);
 const before = values.get(transcriptKey(good.id));
 for (const messages of [undefined, null, {}, 'not an array', 42]) {
  const result = chat.cacheThreadTranscript({...good, messages});
  assert.deepEqual(result.messages, []);
  assert.equal(result.transcript_loaded, false);
  assert.equal(result.imported, true);
  assert.equal(values.get(transcriptKey(good.id)), before);
  assert.deepEqual(chat.loadCachedThreadTranscript(good.id).messages, good.messages);
 }
}));

test('invalid message rows trigger backend hydration without losing valid neighboring messages', () => withCache(values => {
 const good = validThread();
 const partial = {...good, messages:[null, ...good.messages, {id:'bad', role:'user', ts:2, text:{}}, false]};
 values.set(historyKey(), JSON.stringify([partial]));
 const [row] = chat.loadThreads();
 assert.deepEqual(row.messages, good.messages);
 assert.equal(row.transcript_loaded, false);
 assert.equal(row.imported, true);
 const raw = JSON.stringify({thread:partial, cached_at:1});
 values.set(transcriptKey(good.id), raw);
 assert.equal(chat.loadCachedThreadTranscript(good.id), null);
 assert.equal(values.get(transcriptKey(good.id)), raw);
}));

test('saving a mixed history does not silently fail the entire write', () => withCache(() => {
 const good = validThread();
 chat.saveThreads([null, good, {id:'recover', title:{wrong:true}, created_ts:'bad', messages:{wrong:true}}]);
 const rows = chat.loadThreads();
 assert.deepEqual(rows.map(row=>row.id), ['keep','recover']);
 assert.deepEqual(rows[0].messages, good.messages);
 assert.equal(typeof rows[1].title, 'string');
 assert.equal(rows[1].created_ts, 0);
 assert.equal(rows[1].transcript_loaded, false);
}));

test('non-browser transcript calls retain messages rather than replacing them with an empty array', () => {
 const good = validThread();
 assert.deepEqual(chat.cacheThreadTranscript(good).messages, good.messages);
});

test('cache recovery respects deletion tombstones and other workspaces', () => withCache(values => {
 const otherKey = identity.workspaceStorageKey('nerya.chat.threads.v1:workspace:', 'other');
 values.set(otherKey, 'untouched');
 chat.rememberDeletedSession('gone');
 values.set(historyKey(), JSON.stringify([{id:'gone', messages:null}, validThread()]));
 assert.deepEqual(chat.loadThreads().map(row=>row.id), ['keep']);
 assert.equal(chat.loadCachedThreadTranscript('gone'), null);
 assert.equal(values.get(otherKey), 'untouched');
}));

test('bad JSON is non-destructive and optional storage failures do not crash history reads', () => withCache(values => {
 values.set(historyKey(), '{broken');
 assert.deepEqual(chat.loadThreads(), []);
 assert.equal(values.get(historyKey()), '{broken');
 localStorage.getItem = () => { throw new Error('storage unavailable'); };
 assert.deepEqual(chat.loadThreads(), []);
 assert.equal(chat.loadCachedThreadTranscript('keep'), null);
}));

test('chat error recovery is localized and exposes no destructive cache action', () => {
 const React = require('react');
 const {renderToStaticMarkup} = require('react-dom/server');
 const {NextIntlClientProvider} = require('next-intl');
 const ChatError = require('../app/chat/error.tsx').default;
 for (const locale of ['en','zh']) {
  const messages = require(`../messages/${locale}/core.json`);
  const html = renderToStaticMarkup(React.createElement(NextIntlClientProvider,
   {locale, messages, timeZone:'UTC'}, React.createElement(ChatError, {error:new Error(''), reset(){}})));
  assert.ok(html.includes(messages.chatError.retry));
  assert.ok(html.includes(messages.chatError.reload));
  assert.ok(html.includes(messages.chatError.unexpected));
 }
 const source = fs.readFileSync(require('node:path').join(__dirname,'../app/chat/error.tsx'),'utf8');
 assert.doesNotMatch(source, /localStorage|removeItem|nukeThreads/);
});
