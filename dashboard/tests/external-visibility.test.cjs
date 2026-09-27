// Offline component checks only; live page assertions use real receipts separately.
const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), ts=require('typescript');
for(const ext of ['.ts','.tsx']) require.extensions[ext]=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,filename);
require.extensions['.css']=module=>{module.exports={};};
const React=require('react'), {renderToStaticMarkup}=require('react-dom/server');
const {NextIntlClientProvider}=require('next-intl');
const {ChatInput}=require('../components/chat/ChatInput.tsx');
const {DEFAULT_CHAT_RUN_SETTINGS}=require('../lib/chat.ts');
const {projectExternalThread}=require('../lib/externalNative.ts');
function composer(sending=false){return renderToStaticMarkup(React.createElement(NextIntlClientProvider,{locale:'zh',timeZone:'UTC',messages:{chat:{send:'发送',inputPlaceholder:'消息'}},onError:()=>{}},React.createElement(ChatInput,{value:'hello',onChange:()=>{},onSend:()=>{},sending,external:true,settings:DEFAULT_CHAT_RUN_SETTINGS,onSettingsChange:()=>{}})));}
test('external composer contains one textarea and one labelled send button, no model/permissions/attachment controls',()=>{
 const html=composer(); assert.equal((html.match(/<textarea\b/g)||[]).length,1); assert.equal((html.match(/<button\b/g)||[]).length,1);
 assert.match(html,/data-composer-mode="external"/); assert.match(html,/data-testid="external-send"/); assert.match(html,/发送/);
 assert.doesNotMatch(html,/data-composer-models|type="file"|role="combobox"/);
});
test('sending retains the same send button, disabled instead of disappearing',()=>{
 const html=composer(true); assert.equal((html.match(/<button\b/g)||[]).length,1);
 assert.match(html,/aria-busy="true"/); assert.match(html,/disabled=""/); assert.match(html,/data-testid="external-send"/);
});
test('empty and cached external sessions recover provenance without fabricating results',()=>{
 for(const source of ['mcp','tunnel']){
  const thread={id:'ext_'+source+'_'+'a'.repeat(32),messages:[]}; const result=projectExternalThread(thread);
  assert.equal(result.source,source); assert.deepEqual(result.messages,[]);
 }
 const ordinary={id:'normal',messages:[]}; assert.equal(projectExternalThread(ordinary),ordinary);
});
