import {test,expect,type Page} from '@playwright/test';
import {parityFixture} from './command-fixture';
import type {LiveEvent} from '../../lib/chat';

async function renderFixture(page:Page,language='en',theme='dark') {
  const fixture=await parityFixture(page,{language,theme});
  const events:LiveEvent[]=[];
  await page.route('**/api/proxy/agent/commands/events**',async route=>{
    const url=new URL(route.request().url()),after=Number(url.searchParams.get('after_seq')||0);
    await route.fulfill({json:{ok:true,events:events.filter(e=>e.seq>after),cursor:events.at(-1)?.seq||after,has_more:false}});
  });
  await page.goto('/chat/parity-session');
  const input=page.locator('[data-chat-composer] textarea');await expect(input).toBeEnabled();
  await input.fill(language==='zh'?'检查行情并验证策略，不执行实盘交易。':'Inspect market data and validate the strategy. Do not trade.');
  await page.getByTestId('native-command-send').click();await expect.poll(()=>fixture.commands.size).toBe(1);
  const command=[...fixture.commands.values()][0];
  const emit=(event:Pick<LiveEvent,'kind'>&Partial<LiveEvent>)=>events.push({...event,seq:events.length+1,event_id:'render-'+(events.length+1),turn_id:command.turn_id,session_id:'parity-session'});
  return {...fixture,command,events,emit};
}

test('streaming thinking, real progress and final snapshots keep a single stable timeline',async({page},info)=>{
  const f=await renderFixture(page);
  f.emit({kind:'turn.step',stream_id:'thought',mode:'append',step:{kind:'thinking',detail:{text:'Check the data '}}});
  const thought=page.getByTestId('reasoning-activity');await expect(thought).toHaveCount(1);await expect(thought).toContainText('Check the data');
  await thought.locator('summary').click();
  f.emit({kind:'turn.step',stream_id:'thought',mode:'append',step:{kind:'thinking',detail:{text:'before running the backtest.'}}});
  await expect(thought).toHaveAttribute('open','');await expect(thought).toContainText('before running the backtest');
  f.emit({kind:'turn.step',stream_id:'thought',mode:'replace',completed:true,step:{kind:'thinking',detail:{text:'Check the data before running the backtest.'}}});
  f.emit({kind:'tool.start',call_id:'run',action:'script_run',payload:{skill_id:'backtest',script:'backtest_run.py'}});
  f.emit({kind:'tool.progress',call_id:'run',message:'12 / 100 candles',progress:{current:12,total:100}});
  f.emit({kind:'tool.output',call_id:'run',channel:'stdout',text:'Loading candles…\n'});
  const tool=page.locator('[data-operation-id="1:run"]');await expect(tool).toHaveCount(1);
  await expect(tool.getByRole('progressbar')).toBeVisible();await expect(tool.getByRole('progressbar')).toHaveAttribute('value','12');
  await tool.locator('summary').click();await expect(tool).toContainText('Loading candles');
  f.emit({kind:'tool.complete',call_id:'run',action:'script_run',ok:true,elapsed_ms:1450,result:{exit_code:0,stdout:'Completed fixture backtest\n'}});
  await expect(tool).toHaveAttribute('data-state','settled');await expect(tool).toHaveAttribute('open','');
  f.emit({kind:'message.delta',stream_id:'answer',mode:'append',text:'Verified result 👩🏽‍💻\n\n```python\nprint(1)'});
  await expect(page.locator('[data-turn-section="reply"]')).toContainText('Verified result 👩🏽‍💻');
  const final='Verified result 👩🏽‍💻\n\n```python\nprint(1)\n```';
  f.command.result={turn_id:f.command.turn_id,final_text:final,blocks:[
    {block:{kind:'thinking_delta',stream_id:'thought',text:'Check the data '}},
    {block:{kind:'thinking',stream_id:'thought',text:'Check the data before running the backtest.'}},
    {block:{kind:'tool_use',call_id:'run',action:'script_run',payload:{skill_id:'backtest',script:'backtest_run.py'}}},
    {block:{kind:'tool_result',call_id:'run',ok:true,elapsed_ms:1450,result:{exit_code:0,stdout:'Completed fixture backtest\n'}}},
    {block:{kind:'text',stream_id:'answer',text:final}},
  ]};
  f.setState(f.command.command_id,'succeeded');
  await expect(page.locator('[data-turn-loading="true"]')).toHaveCount(0);
  await expect(thought).toHaveCount(1);await expect(thought).toHaveAttribute('open','');await expect(tool).toHaveAttribute('open','');
  await expect(page.getByTestId('execution-process')).toHaveAttribute('open','');
  await expect(page.locator('[data-turn-section="reply"]')).toHaveCount(1);
  expect(f.errors).toEqual([]);await page.screenshot({path:info.outputPath('streaming-to-final-dark.png'),fullPage:true});
});

test('read grouping preserves manual details and errors remain visible',async({page})=>{
  const f=await renderFixture(page);
  const read=(id:string)=>{f.emit({kind:'tool.start',call_id:id,action:'read_file',payload:{path:id+'.md'}});f.emit({kind:'tool.complete',call_id:id,action:'read_file',ok:true,result:{text:'Content '+id}});};
  read('a');read('b');
  const first=page.locator('[data-operation-id="1:a"]');await expect(first).toBeVisible();await first.locator('summary').click();await expect(first).toContainText('Content a');
  read('c');await expect(page.getByTestId('execution-explore-group')).toHaveAttribute('open','');await expect(first).toHaveAttribute('open','');await expect(first).toContainText('Content a');
  f.emit({kind:'tool.start',call_id:'fail',action:'run_shell',payload:{command:'verify_fixture'}});
  f.emit({kind:'tool.complete',call_id:'fail',ok:true,result:{exit_code:2,stderr:'Fixture validation failed'}});
  const failed=page.locator('[data-operation-id="1:fail"]');await expect(failed).toHaveAttribute('data-state','failed');await expect(failed).toContainText('Fixture validation failed');
  expect(f.errors).toEqual([]);
});

test('Chinese light mobile keeps Nerya tool summaries readable without horizontal overflow',async({page},info)=>{
  await page.setViewportSize({width:390,height:844});
  const f=await renderFixture(page,'zh','light');
  f.emit({kind:'turn.step',stream_id:'s',mode:'append',step:{kind:'thinking',detail:{text:'先检查行情数据和策略参数，确认输出可追溯。'}}});
  f.emit({kind:'tool.start',call_id:'market',action:'market_data',payload:{market:'BINANCE:BTCUSDT',timeframe:'1h'}});
  f.emit({kind:'tool.complete',call_id:'market',action:'market_data',ok:true,result:{symbol:'BTCUSDT',candles:[[1,10,12,9,11,100],[2,11,13,10,12,120]]}});
  const tool=page.locator('[data-operation-id="1:market"]');await expect(tool).toContainText('获取行情');await expect(tool).toContainText('2 条 K 线');
  await tool.locator('summary').click();await expect(page.getByTestId('tool-market-preview')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  expect(f.errors).toEqual([]);await page.screenshot({path:info.outputPath('nerya-tools-zh-light-mobile.png'),fullPage:true});
});

const fileDiff='--- a/strategies/alpha_trend/main.py\n+++ b/strategies/alpha_trend/main.py\n@@ -1,5 +1,8 @@\n-# @nerya.version 1\n+# @nerya.version 2\n # @nerya.title AlphaTrend 趋势策略\n-# Generic momentum baseline\n+# @nerya.description ATR 风险预算与趋势过滤\n+# @nerya.input 本地历史 K 线、持仓与策略参数\n+# @nerya.output 可追溯的交易信号\n def evaluate(ctx):\n-    return baseline(ctx)\n+    # 每个品种独立计算风险，验证后才输出信号\n+    return evaluate_trend(ctx)\n';

test('screenshot regression: legacy file diff and strategy transport become typed evidence',async({page},info)=>{
  await page.setViewportSize({width:1440,height:1000});
  const f=await renderFixture(page,'zh','light');
  f.emit({kind:'turn.step',stream_id:'review',mode:'replace',completed:true,step:{kind:'thinking',detail:{text:'先核对策略配置，再检查脚本变更与风险参数。'}}});
  f.emit({kind:'tool.start',call_id:'skill',action:'Skill',payload:{skill:'strategy_author'}});
  f.emit({kind:'tool.complete',call_id:'skill',action:'Skill',ok:true,result:{summary:'已加载策略编写说明'},elapsed_ms:0});
  f.emit({kind:'tool.start',call_id:'write',action:'write_file',payload:{path:'evolution/proposals/fixture/after/strategies/alpha_trend/main.py'}});
  f.emit({kind:'tool.complete',call_id:'write',action:'write_file',ok:true,result:fileDiff+'\n'+JSON.stringify({path:'strategies/alpha_trend/main.py',lines_after:8,bytes_after:520}),elapsed_ms:2});
  f.emit({kind:'tool.start',call_id:'strategy',action:'strategy_create',payload:{strategy_id:'alpha_trend',description:'This long protocol description must not dominate the tool headline.'.repeat(5)}});
  f.emit({kind:'tool.complete',call_id:'strategy',action:'strategy_create',ok:true,result:'strategy: ready\n[compacted_kept]\n'+JSON.stringify({strategy_id:'alpha_trend',status:'ready',main_path:'strategies/alpha_trend/main.py',strategy_yml_path:'strategies/alpha_trend/strategy.yml',workflow_path:'strategies/alpha_trend/workflow.json',next_steps:['检查脚本后再执行验证，不代表已完成回测。']})});
  const write=page.locator('[data-operation-id="1:write"]');
  await write.locator(':scope > summary').click();
  const diff=write.getByTestId('tool-diff-preview');await expect(diff).toBeVisible();
  await expect(diff.locator('h1,h2,h3,p')).toHaveCount(0);
  await expect(diff.locator('[data-line-kind="added"]')).toHaveCount(6);
  const family=await diff.locator('code').first().evaluate(el=>getComputedStyle(el).fontFamily);expect(family).toMatch(/mono|Menlo/i);
  await expect(write).not.toContainText('"bytes_after"');
  const strategy=page.locator('[data-operation-id="1:strategy"]');await strategy.locator(':scope > summary').click();
  await expect(strategy.getByTestId('tool-structured-result')).toBeVisible();
  await expect(strategy).toContainText('strategy.yml');await expect(strategy).not.toContainText('[compacted_kept]');
  await expect(strategy.locator(':scope > summary')).not.toContainText('protocol description');
  await expect(page.getByTestId('agent-debug-json')).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  expect(f.errors).toEqual([]);await page.screenshot({path:info.outputPath('diff-and-strategy-zh-light.png'),fullPage:true});
  await write.getByTestId('agent-debug').locator('summary').click();
  await expect(write.getByTestId('agent-debug-json')).toContainText('write_file');
});

test('question protocol renders as recorded answers without selecting omitted defaults',async({page},info)=>{
  await page.setViewportSize({width:1280,height:960});
  const f=await renderFixture(page,'zh','light');
  const questions=[{id:'timeframe',question:'回测使用什么 K 线周期？',options:['1 小时（默认）','4 小时']},{id:'risk',question:'每个品种的风险预算？'},{id:'validation',question:'还需要哪些验证？',options:['统计交易次数（默认）']}];
  const text='User response to AlphaTrend 策略参数: '+JSON.stringify({action:'answer',answers:{timeframe:{selected:['4 小时'],text:''},risk:{selected:['账户权益的 2%'],text:''}}})+' Questions: '+JSON.stringify(questions)+' Omitted answers are unknown. Continue using best judgment within existing permissions. This is not approval for trading or other gated actions.';
  f.emit({kind:'message.delta',stream_id:'receipt',mode:'append',text});
  f.emit({kind:'tool.start',call_id:'read',action:'read_file',payload:{path:'strategies/alpha_trend/main.py'}});
  // An intermediate text block exercises the same receipt in assistant-side history.
  f.emit({kind:'message.delta',stream_id:'after',mode:'append',text:'已记录参数，未回答的问题保持未确认。'});
  const receipt=page.getByTestId('interaction-receipt');await expect(receipt).toBeVisible();
  await expect(receipt).toContainText('4 小时');await expect(receipt).toContainText('未回答');
  await expect(receipt).not.toContainText('1 小时（默认）');await expect(receipt).not.toContainText('Omitted answers');
  await expect(receipt).not.toContainText('"selected"');
  expect(f.errors).toEqual([]);await page.screenshot({path:info.outputPath('question-receipt-zh-light.png'),fullPage:true});
});

test('thinking follows its newest line but respects manual scrolling and disclosure',async({page},info)=>{
  await page.setViewportSize({width:1100,height:880});
  const f=await renderFixture(page,'zh','dark');
  const emit=(text:string)=>f.emit({kind:'turn.step',stream_id:'long-thought',mode:'append',step:{kind:'thinking',detail:{text}}});
  emit('第一步检查输入数据。\n'+Array.from({length:35},(_,i)=>`检查第 ${i+1} 项数据与参数，只记录可验证的信息。`).join('\n'));
  const thought=page.getByTestId('reasoning-activity'),preview=page.getByTestId('reasoning-preview');
  await expect(preview).toContainText('第 35 项');
  await expect(preview).toHaveAttribute('data-overflow','false');
  expect(await page.getByTestId('reasoning-status-dot').evaluate(el=>el.getBoundingClientRect().width)).toBeLessThanOrEqual(6);
  emit('\n最新检查：'+ '比较策略参数、数据覆盖范围与测试证据。'.repeat(18));
  await expect(preview).toContainText('最新检查');
  await expect.poll(()=>preview.evaluate(el=>el.scrollLeft>0)).toBe(true);
  await expect(preview).toHaveAttribute('data-overflow','true');
  await thought.locator('summary').click();const body=page.getByTestId('reasoning-body');
  await expect(body).toBeVisible();
  await expect.poll(()=>body.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop<5)).toBe(true);
  await page.setViewportSize({width:1000,height:880});
  await expect.poll(()=>body.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop<5)).toBe(true);
  await body.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'));});
  emit('\n末尾追加的检查记录，不应抢走阅读位置。');
  await expect(body).toContainText('末尾追加');
  expect(await body.evaluate(el=>el.scrollTop)).toBeLessThan(10);
  await body.evaluate(el=>{el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll'));});
  emit('\n用户回到底部后恢复跟随。');await expect(body).toContainText('恢复跟随');
  await expect.poll(()=>body.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop<5)).toBe(true);
  expect(f.errors).toEqual([]);await page.screenshot({path:info.outputPath('thinking-follow-zh-dark.png'),fullPage:true});
});

test('typed native display is used live and mobile diff scrolls inside its viewport',async({page},info)=>{
  await page.setViewportSize({width:390,height:844});const f=await renderFixture(page,'zh','dark');
  f.emit({kind:'tool.start',call_id:'typed-edit',action:'edit_file',payload:{path:'strategies/alpha_trend/main.py'}});
  f.emit({kind:'tool.complete',call_id:'typed-edit',action:'edit_file',ok:true,result:'legacy provider observation',display_result:{content:[{type:'diff',text:fileDiff,metadata:{path:'strategies/alpha_trend/main.py'}},{type:'json',data:{lines_after:8}}]}});
  const tool=page.locator('[data-operation-id="1:typed-edit"]');await tool.locator(':scope > summary').click();
  await expect(tool.getByTestId('tool-diff-preview')).toBeVisible();await expect(tool).not.toContainText('legacy provider observation');
  const removed=tool.locator('[data-line-kind="removed"]').first();
  const added=tool.locator('[data-line-kind="added"]').first();
  const removedColor=await removed.evaluate(el=>getComputedStyle(el).backgroundColor);
  expect(removedColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(removedColor).not.toBe(await added.evaluate(el=>getComputedStyle(el).backgroundColor));
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await tool.getByRole('button',{name:'展开',exact:true}).click();
  await expect(tool.locator('[data-expanded="true"]')).toBeVisible();
  expect(f.errors).toEqual([]);await page.screenshot({path:info.outputPath('typed-diff-zh-dark-mobile.png'),fullPage:true});
});
