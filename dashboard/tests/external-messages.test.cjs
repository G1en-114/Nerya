// Offline message ordering + shared UserBubble regression, no live fixtures.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), ts = require('typescript');
for (const ext of ['.ts','.tsx']) require.extensions[ext] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,filename);
require.extensions['.css'] = module => { module.exports = {}; };
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { NextIntlClientProvider } = require('next-intl');
const { UserBubble } = require('../components/chat/ChatMessage.tsx');
const { conversationEntries } = require('../lib/externalConversation.ts');
const base = {call_id:'a',source:'mcp',remote_session_id:'unit',tool:'nerya_native_read_file',status:'succeeded',sequence:1,started_at:'2026-09-24T00:00:00Z'};
const user = {id:'local-user',backend_message_id:'saved-user',role:'user',ts:1,text:'User instruction',external_request:{id:'saved-user',sequence:2,state:'queued'}};
test('user messages interleave after tools and before subsequent activity with stable identity',()=>{
 const rows = conversationEntries([base,{...base,call_id:'b',sequence:3,activity:{next:'Read more'}}],[user,user]);
 assert.deepEqual(rows.map(row=>row.kind),['tool','user','message','tool']);
 assert.equal(rows[1].id,'saved-user');
});
test('external acknowledgement is rendered by the ordinary user bubble',()=>{
 for (const state of ['queued','delivered','acknowledged']) {
  const html = renderToStaticMarkup(React.createElement(NextIntlClientProvider,{locale:'en',timeZone:'UTC',messages:{},onError:()=>{}},React.createElement(UserBubble,{msg:{...user,external_request:{...user.external_request,state}}})));
  assert.match(html,/bubble-user/); assert.match(html,/data-turn-id="saved-user"/);
  assert.match(html,new RegExp(`data-state="${state}"`));
  assert.match(html,/User instruction/);
 }
});
test('messages-only external sessions have no fabricated tools or agent replies',()=>{
 const rows = conversationEntries([],[user]); assert.equal(rows.length,1); assert.equal(rows[0].kind,'user');
});
test('script results use the common shell card with structured output collapsed',()=>{
 const { ShellCard } = require('../components/chat/tool-cards/ShellCard.tsx');
 const { isShellTool } = require('../components/chat/tool-cards/predicates.ts');
 const block = {kind:'tool_result',action:'script_run',ok:true,payload:{skill_id:'markets',name:'get_candles.py',args:[]},result:{exit_code:0,stdout:'recorded JSON',stdout_json:{ok:true}}};
 assert.equal(isShellTool(block),true);
 const html = renderToStaticMarkup(React.createElement(NextIntlClientProvider,{locale:'en',timeZone:'UTC',messages:{},onError:()=>{}},React.createElement(ShellCard,{block,variant:'result',defaultOpen:true})));
 assert.match(html,/markets\/get_candles.py/); assert.match(html,/exit 0/);
 assert.match(html,/data-testid="script-structured-output"/); assert.doesNotMatch(html,/<details[^>]*open/);
});
