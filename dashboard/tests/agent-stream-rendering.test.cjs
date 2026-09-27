const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
for(const ext of ['.ts','.tsx'])require.extensions[ext]=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,f);
require.extensions['.css']=m=>{m.exports={};};
const {liveEventsToBlocks}=require('../lib/chat.ts');
const {mergeStreamEvents}=require('../lib/streamEvents.ts');
const block=env=>env.block||env;
const think=(seq,text,mode='append')=>({kind:'turn.step',seq,stream_id:'thought-1',mode,completed:mode==='replace',step:{kind:'thinking',detail:{text}}});

test('thinking fragments share a row and the completed snapshot replaces them',()=>{
 const rows=liveEventsToBlocks([think(1,'先看'),think(2,'数据'),think(2,'数据'),think(3,'先看数据，再验证。','replace')]);
 assert.equal(rows.length,1);assert.equal(block(rows[0]).text,'先看数据，再验证。');assert.equal(block(rows[0]).completed,true);
});
test('append mode preserves repeated tokens even without stream ids',()=>{
 const rows=liveEventsToBlocks([{kind:'message.delta',seq:0,mode:'append',text:'ha'},{kind:'message.delta',seq:1,mode:'append',text:'ha'}]);
 assert.equal(block(rows[0]).text,'haha');
});
test('unidentified events are never collapsed by kind and separate epochs survive',()=>{
 const a={kind:'message.delta',text:'a'},b={kind:'message.delta',text:'b'};
 assert.equal(mergeStreamEvents([a,b]).length,2);
 assert.equal(mergeStreamEvents([{...a,seq:1,epoch:'old'},{...b,seq:1,epoch:'new'}]).length,2);
});
test('late chart insertion does not redirect the next delta into the wrong block',()=>{
 const rows=liveEventsToBlocks([
  {kind:'tool.start',seq:1,call_id:'fetch',action:'market_data'},
  {kind:'tool.complete',seq:2,call_id:'fetch',ok:true,result:{}},
  {kind:'message.delta',seq:3,stream_id:'answer',mode:'append',text:'Price '},
  {kind:'chart.block',seq:4,call_id:'fetch',chart_block:{chart_id:'chart-1'}},
  {kind:'message.delta',seq:5,stream_id:'answer',mode:'append',text:'rose'},
 ]);
 assert.equal(rows.filter(e=>block(e).kind==='chart').length,1);
 assert.equal(rows.filter(e=>block(e).kind==='text').length,1);
 assert.equal(block(rows.find(e=>block(e).kind==='text')).text,'Price rose');
});
test('tool progress updates the running call without claiming a result',()=>{
 const rows=liveEventsToBlocks([
  {kind:'tool.start',seq:1,call_id:'job',action:'script_run',payload:{skill_id:'backtest'}},
  {kind:'tool.progress',seq:2,call_id:'job',message:'12 / 100 rows',progress:{current:12,total:100}},
  {kind:'tool.output',seq:3,call_id:'job',channel:'stdout',text:'loading\n'},
 ]);
 assert.equal(rows.length,1);assert.equal(block(rows[0]).kind,'tool_use');
 assert.equal(block(rows[0]).progress_message,'12 / 100 rows');assert.equal(block(rows[0]).stdout,'loading\n');
 assert.equal(block(rows[0]).ok,undefined);
});

const {normalizeTranscriptBlocks}=require('../lib/transcriptProjection.ts');
const {executionSteps,executionEntries,partitionTranscript}=require('../lib/executionTimeline.ts');
const {pairOperations,toolPresentation,contentValue}=require('../lib/agentConversation.ts');
const {toolSemantics,plainToolOutput}=require('../lib/toolSemantics.ts');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),{NextIntlClientProvider}=require('next-intl');
const {AssistantBubble}=require('../components/chat/ChatMessage.tsx');
const {StreamedMarkdown}=require('../components/chat/TurnBlocks.tsx');
const messages=Object.assign({},...fs.readdirSync(__dirname+'/../messages/en').filter(f=>f.endsWith('.json')).map(f=>require('../messages/en/'+f)));
const html=element=>renderToStaticMarkup(React.createElement(NextIntlClientProvider,{locale:'en',messages,timeZone:'UTC'},element));
const env=(kind,props={})=>({block:{kind,...props}});

test('native persisted deltas and final snapshots normalize at the original position',()=>{
 const source=[env('thinking_delta',{stream_id:'s',text:'先'}),env('thinking_delta',{stream_id:'s',text:'验证'}),env('text_delta',{stream_id:'s',text:'答案'}),env('thinking',{stream_id:'s',text:'先验证来源'}),env('text',{stream_id:'s',text:'最终答案'})];
 const before=JSON.stringify(source),rows=normalizeTranscriptBlocks(source);
 assert.equal(JSON.stringify(source),before);
 assert.deepEqual(rows.map(e=>[block(e).kind,block(e).text]),[['thinking','先验证来源'],['text','最终答案']]);
 assert.equal(block(rows[0]).presentation_active,false);
});
test('interrupted native streams retain partial Unicode text and never promote user text',()=>{
 const rows=normalizeTranscriptBlocks([{role:'user',block:{kind:'text',text:'SECRET USER INPUT'}},env('thinking_delta',{stream_id:'s',text:'🧠'}),env('text_delta',{stream_id:'s',text:'你好👩🏽‍💻'})]);
 assert.deepEqual(rows.map(e=>block(e).text),['🧠','你好👩🏽‍💻']);
 assert.equal(block(rows[1]).completed,false);
});
test('thinking, tool and intermediate narration stay in chronological order',()=>{
 const source=[env('thinking',{text:'Inspect sources'}),env('tool_use',{call_id:'a',action:'read_file'}),env('tool_result',{call_id:'a',ok:true,result:'source'}),env('text',{text:'Now validate'}),env('thinking',{text:'Cross check'}),env('text',{text:'Final'})];
 const part=partitionTranscript(source,'Final','');
 assert.equal(part.reply,'Final');
 const rows=executionEntries(part.work,executionSteps(source),false);
 assert.deepEqual(rows.map(row=>row.kind),['thinking','tool','text','thinking']);
});
test('out of order tool results and repeated snapshots preserve one call and its input',()=>{
 const events=[{seq:1,ts:0,kind:'tool_result',data:{call_id:'a',ok:true,result:{count:2}}},{seq:2,ts:0,kind:'tool_use',data:{call_id:'a',action:'web_search',payload:{query:'sources'}}},{seq:3,ts:0,kind:'tool_result',data:{call_id:'a',result:{count:3}}}];
 const rows=pairOperations(events);assert.equal(rows.length,1);assert.equal(rows[0].key,'1:a');assert.equal(rows[0].data.payload.query,'sources');assert.equal(rows[0].data.result.count,3);
});
test('separate attempts never merge tool results',()=>{
 const rows=executionSteps([env('tool_use',{call_id:'a',attempt:1}),env('tool_result',{call_id:'a',attempt:1,ok:false}),env('tool_use',{call_id:'a',attempt:2})]);
 assert.equal(rows.length,2);assert.equal(rows[1].result,undefined);
});
test('anonymous calls are not paired with one another or moved past reasoning',()=>{
 const source=[env('thinking',{text:'one'}),env('tool_use',{action:'read_file'}),env('thinking',{text:'two'}),env('tool_use',{action:'market_data'})];
 assert.deepEqual(executionEntries(source,executionSteps(source),true).map(row=>row.kind),['thinking','tool','thinking','tool']);
});
test('MCP structured content is preferred and MCP errors are not green success',()=>{
 assert.deepEqual(contentValue({structuredContent:{count:0},content:[{type:'text',text:'fallback'}]}),{count:0});
 const step=pairOperations([{kind:'tool_result',seq:1,ts:0,data:{call_id:'mcp',action:'mcp_call',ok:true,result:{isError:true,content:[{type:'text',text:'failed'}]}}}])[0];
 assert.equal(toolPresentation(step,'succeeded',false).failed,true);
});
test('waiting approvals and interrupted missing results are not completed',()=>{
 const step=pairOperations([{kind:'tool_use',seq:1,ts:0,data:{call_id:'a',action:'run_shell'}}])[0];
 assert.equal(toolPresentation(step,'awaiting_approval',false).waiting,true);
 const stopped=toolPresentation(step,'interrupted',false);assert.equal(stopped.pending,false);assert.equal(stopped.state,'No response recorded');
});
test('model tool input stays preparing until the actual tool starts',()=>{
 const events=[{kind:'model.tool_input_delta',seq:1,call_id:'read',name:'read_file',partial_json:'{"path":'}];
 let rows=liveEventsToBlocks(events);assert.equal(block(rows[0]).phase,'input_streaming');
 assert.equal(toolPresentation(executionSteps(rows)[0],'running',false).preparing,true);
 rows=liveEventsToBlocks([...events,{kind:'tool.start',seq:2,call_id:'read',action:'read_file',payload:{path:'a.md'}}]);
 assert.equal(rows.length,1);assert.equal(block(rows[0]).phase,'running');
});
test('Nerya tool families use the actual skill, symbol, strategy and MCP name',()=>{
 assert.equal(toolSemantics('script_run',{skill_id:'backtest',script:'run.py'},true).title,'运行回测');
 assert.equal(toolSemantics('market_data',{market:'BINANCE:BTCUSDT'},true).subject,'BINANCE:BTCUSDT');
 assert.equal(toolSemantics('strategy_view',{strategy_id:'s1'},true).title,'查看策略');
 assert.equal(toolSemantics('mcp_call',{namespace:'sources',tool:'lookup'},false).subject,'sources / lookup');
 assert.equal(toolSemantics('Skill',{skill:'research'},true).family,'skill');
});
test('closed successful tool details do not mount the raw output',()=>{
 const output=html(React.createElement(AssistantBubble,{msg:{id:'lazy',role:'assistant',ts:1,loading:true,turn:{blocks:[env('tool_result',{call_id:'x',action:'read_file',ok:true,result:{text:'HUGE_SENTINEL'.repeat(2000)}})]}}}));
 assert.doesNotMatch(output,/HUGE_SENTINEL/);assert.doesNotMatch(output,/agent-debug-json/);
});
test('live Unicode and incomplete fenced markdown are rendered without a second typewriter',()=>{
 const output=html(React.createElement(StreamedMarkdown,{text:'你好👩🏽‍💻\n\n```python\nprint(1)',active:true}));
 assert.match(output,/你好👩🏽‍💻/);assert.match(output,/print\(1\)/);assert.match(output,/<pre/);
});
test('ANSI output is stripped and large output is explicitly bounded',()=>{
 const result=plainToolOutput('\u001b[31merror\u001b[0m');assert.equal(result.text,'error');
 const bounded=plainToolOutput('a'.repeat(40000));assert.equal(bounded.text.length,32000);assert.equal(bounded.truncated,true);
});
test('file targets do not change the actual operation into a trading workflow',()=>{
  const {toolSemantics}=require('../lib/toolSemantics.ts');
  assert.equal(toolSemantics('read_file',{path:'strategies/backtest.py'},false).family,'read');
  assert.equal(toolSemantics('write_file',{path:'browser/strategy.py'},false).family,'edit');
  assert.equal(toolSemantics('script_run',{skill:'backtest',script:'run.py'},false).family,'backtest');
});
test('out-of-order replay pages restore deltas within each sequence domain',()=>{
 const event=(seq,text)=>({kind:'message.delta',seq,event_id:'e'+seq,session_id:'s',turn_id:'t',epoch:'a',stream_id:'answer',mode:'append',text});
 const rows=liveEventsToBlocks([event(2,'世界'),event(1,'你好'),event(2,'世界')]);
 assert.equal(block(rows[0]).text,'你好世界');
 const newer={...event(1,'新轮'),epoch:'b',event_id:'new'};
 assert.equal(mergeStreamEvents([event(2,'世界'),newer],[event(1,'你好')])[1],newer);
});
test('legacy explicit empty replacement clears an abandoned draft',()=>{
 const rows=liveEventsToBlocks([{kind:'message.delta',seq:1,mode:'append',text:'abandoned'},{kind:'message.delta',seq:2,mode:'replace',text:''}]);
 assert.equal(block(rows[0]).text,'');
});
test('error metadata on a structured wrapper survives decoding',()=>{
 const [step]=executionSteps([env('tool_result',{call_id:'x',ok:true,result:{ok:false,data:{message:'Validation failed'}}})]);
 assert.equal(toolPresentation(step,'succeeded',false).failed,true);
});
test('MCP structured content retains image and resource attachments',()=>{
 const {ToolResultContent}=require('../components/chat/ToolResultContent.tsx');
 const output=html(React.createElement(ToolResultContent,{family:'mcp',value:{structuredContent:{summary:'Actual tool summary'},content:[{type:'text',text:'duplicate transport'},{type:'image',mimeType:'image/png',data:'aGVsbG8='},{type:'resource',resource:{uri:'fixture://source',text:'Resource content'}}]}}));
 assert.match(output,/Actual tool summary/);assert.match(output,/<img/);assert.match(output,/Resource content/);assert.doesNotMatch(output,/duplicate transport/);
});
