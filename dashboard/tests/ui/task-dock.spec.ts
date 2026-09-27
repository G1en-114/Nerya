import { test, expect, type Page } from '@playwright/test';

const SESSION='task-dock-review';
const report='## Browser review\n\nThe report is ready to review. The working browser and network results stay in the side panel.\n\n### Checked\n\nPage content, the response status, and the saved report.\n\nThis is a synthetic UI acceptance task, not a production account.';
const browserPayload=(n:number)=>({skill_id:'browser',name:'browser_session.py',args:['--json',JSON.stringify({operation:'batch',session_id:'mb_dock_fixture',request_id:`dock-action-${n}`})]});
const browserBlocks=(n:number)=>[{block:{kind:'tool_use',action:'script_run',call_id:`browser-${n}`,payload:browserPayload(n)}},{block:{kind:'tool_result',action:'script_run',call_id:`browser-${n}`,ok:true,result:{ok:true}}}];

async function fixture(page:Page,{browser=true,answer=true,members=false,strategy=false,locale='en',theme='dark'}={}){
  const errors:string[]=[],requests:Record<string,any>[]=[];
  let running=false,seq=0,human=false;
  let finish:(()=>void)|undefined;
  const oldViewport=page.viewportSize()!;
  await page.setViewportSize({width:1280,height:800});
  await page.setContent('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#f5f6f8;color:#273343;font:18px system-ui}main{max-width:820px;margin:42px auto;padding:30px;background:white}small{color:#566172}h1{font-size:28px}label{display:block;margin:22px 0}input{padding:12px;font:inherit;border:1px solid #aeb6c3;width:90%}button{font:inherit;padding:10px 20px}p{line-height:1.6}</style><main><small>LOCAL ACCEPTANCE PAGE · SYNTHETIC DATA</small><h1>Research report</h1><p>Review the source register and save the checked report.</p><label>Report name<input value="Evidence review"></label><button>Save report</button><p>Saved. The response is available in Network.</p></main>');
  const actionBox=(await page.getByRole('button',{name:'Save report',exact:true}).boundingBox())!;
  const image='data:image/png;base64,'+(await page.screenshot()).toString('base64');
  await page.setViewportSize(oldViewport);
  await page.addInitScript(({locale,theme})=>{if(top===window)localStorage.setItem('nerya.ui_settings.v1',JSON.stringify({language:locale,darkMode:theme}));},{locale,theme});
  page.on('pageerror',e=>errors.push(e.message));
  const stamp=new Date().toISOString();
  const meta=(id:string)=>({session_id:id,...(strategy&&id===SESSION?{strategy_id:'sidebar-fixture'}:{}),title:id===SESSION?'Review the report in the work browser':'A separate conversation',created_at:stamp,updated_at:stamp,message_count:answer?2:1});
  const agent={id:'reviewer',name:'Reviewer',session_id:SESSION,group_id:'research',title:'Verify the report',state:'completed',attempt:1,updated_at:Date.now()/1000,output:{summary:'The source register is ready.'},context:{parent_session_id:SESSION,scope:'subagent',inherited_messages:2,saved_messages:4}};
  const networkRow={id:'net_fixture',seq:1,url:'https://research.test/api/save',method:'POST',type:'fetch',status:200,state:'finished',duration_ms:42,bytes:58};
  await page.route('**/api/**',async route=>{
    const u=new URL(route.request().url()),path=u.pathname.replace(/^\/api\/proxy/,'');
    const input=route.request().method()==='POST'?route.request().postDataJSON()||{}:{};
    const id=u.searchParams.get('session_id')||SESSION;
    let body:any={ok:true,items:[],count:0,total:0,events:[],approvals:[]};
    if(path==='/strategy/backtests')body={ok:true,strategy_id:'sidebar-fixture',backtests:[{ts:'2026-09-20',days:30},{ts:'2026-09-19',days:30}]};
    else if(path==='/strategy/backtests/chart')body={ok:true,strategy_id:'sidebar-fixture',ts:input.ts,chart:{schema_version:'1',meta:{},panels:[],tables:[],summary_cards:[{label:'total_return_pct',value:4.2}]}};
    else if(path==='/strategies/runtime/workflow')body={ok:true,strategy_id:'sidebar-fixture',revision:'fixture',strategy:{id:'strategy',nodes:[],edges:[]},evolution:{id:'evolution',nodes:[],edges:[]},manifest:{title:'Synthetic sidebar strategy',mode:'paper'},metadata:{version:1,nodes:{},edges:[]},source:{proposal_id:null,state:'active',omitted_files:[]},can_edit:false,legacy:false};
    else if(path==='/browsers/desktop'){
      requests.push(input);
      if(input.operation==='command'){human=input.command==='handoff'?true:input.command==='resume'?false:human;}
      const tabs=[{id:'1',url:'https://research.test/report',selected:true,protected:false}];
      const visual={action:'click',boxes:[actionBox],cursor:{x:actionBox.x+actionBox.width/2,y:actionBox.y+actionBox.height/2},url:tabs[0].url,ts:Date.now()/1000};
      if(input.operation==='network')body={ok:true,listening:true,requests:input.after?[]:[networkRow],cursor:1,generation:'fixture',retained:1};
      else if(input.operation==='network_detail')body={ok:true,request:{...networkRow,request_headers:{'content-type':'application/json'},response_headers:{'content-type':'application/json'},...(input.include_body?{body:'{"saved":true,"count":1}',body_state:'available'}:{})}};
      else if(input.operation==='trace')body={ok:true,status:running?'running':'completed',events:input.after?[]:[{seq:1,kind:'step',index:0,action:'click',phase:'completed',target:'Save report',frame_id:1}],cursor:1,controllable:true,session_id:'mb_dock_fixture',profile_id:'work',visual,frame_state:'available',frame:{image,frame_id:1,url:tabs[0].url,tabs,visual,ts:Date.now()/1000}};
      else body={ok:true,running:true,paused:human,human_control:human,control_id:human?'control_fixture':'',sensitive:false,tabs,image,agent_access:{enabled:true,occupied:true,executing:running,session_id:'mb_dock_fixture'},preferences:{automatic:true},config:{extensions:[]}};
    }else if(path==='/agent/sessions')body={sessions:[meta(SESSION),meta('task-dock-other')],has_more:false};
    else if(path==='/agent/session')body={...meta(id),id,messages:[]};
    else if(path==='/agent/session/transcript')body={ok:true,...meta(id),messages:[{message_id:'user-one',role:'user',content:meta(id).title,ts:stamp},...(answer&&id===SESSION?[{message_id:'answer-one',role:'assistant',content:report,ts:stamp,turn:{turn_id:'turn-one',reply_text:report,blocks:browser?browserBlocks(0):[]}}]:[])]};
    else if(path==='/agent/stream/events')body={events:running&&Number(u.searchParams.get('after_seq')||0)<seq?[{seq,event_id:`event-${seq}`,kind:'tool.start',skill:'script_run',action:'script_run',call_id:`browser-${seq}`,tool_call_id:`browser-${seq}`,skill_id:'native',session_id:SESSION,payload:browserPayload(seq)}]:[],cursor:seq,latest_seq:seq};
    else if(path==='/agent/run_turn_internal'){running=true;seq++;await new Promise<void>(r=>{finish=r;});running=false;body={turn_id:'live-turn',reply_text:report,blocks:browserBlocks(seq)};}
    else if(path==='/teams/agents')body={ok:true,agents:members&&id===SESSION?[agent]:[]};
    else if(path==='/teams/agents/get')body={ok:true,agent,events:[{seq:1,kind:'instruction',ts:1,data:{attempt:1,text:'Verify the source register'}},{seq:2,kind:'text',ts:2,data:{attempt:1,text:'I am checking the source dates.'}},{seq:3,kind:'completed',ts:3,data:{attempt:1,output:agent.output}}],messages:[{id:'mail-review',sender:'operator',recipient:'reviewer',content:'Please include the original dates.',status:'delivered',ts:2.5}],has_more:false};
    else if(path==='/auth/status')body={ok:true,authenticated:true,password_set:true,enabled:true};
    else if(path==='/operator/nav')body={ok:true,primary:[],advanced:[],data:{primary:[],advanced:[]}};
    else if(path==='/operator/overview')body={status:'ok',data:{attention:[],counts:{},accounts:[],strategies:[]}};
    else if(path==='/workspace/files')body={ok:true,entries:[{name:'notes.md',path:'notes.md',kind:'file',size:20,mtime_ms:0},{name:'report.md',path:'report.md',kind:'file',size:20,mtime_ms:0}]};
    else if(path==='/workspace/file')body={ok:true,path:u.searchParams.get('path'),content:'# File '+u.searchParams.get('path')+'\n\nStandalone document preview.'};
    else if(path==='/workspace')body={root:'task-dock-synthetic',live_trading_enabled:false,kill_switch:false};
    else if(path==='/llm/config')body={ok:true,tiers:[],provider_profiles:[],default_tier:'medium',reasoning_levels:['none','low','medium','high']};
    else if(path==='/llm/providers'||path==='/llm/catalog')body={providers:[]};
    else if(path==='/llm/tiers')body={tiers:[],count:0};
    else if(path==='/market/venues')body={venues:[]};
    else if(path==='/accounts/list')body={accounts:[],ts:0};
    else if(path.includes('strategy/list'))body={ok:true,strategies:[]};
    await route.fulfill({json:body});
  });
  await page.goto(`/chat/${SESSION}`);
  return {errors,requests,setAgentState:(state:string)=>{agent.state=state;},started:()=>running,advance:()=>{seq++;},finish:()=>finish?.()};
}
const tabs=(page:Page)=>page.getByTestId('task-dock-header').getByRole('tablist');
const close=(page:Page)=>page.getByTestId('task-dock-header').getByRole('button',{name:/Hide workspace|收起工作区/}).click();

for(const theme of ['dark','light'])test(`one content-driven panel, preserved source and keyboard navigation (${theme})`,async({page})=>{
  await page.setViewportSize({width:1440,height:1000});const state=await fixture(page,{members:true,theme});
  const nav=tabs(page);
  await expect(nav.getByRole('tab')).toHaveCount(4);
  await expect(page.getByTestId('task-topbar').getByRole('tablist')).toHaveCount(0);
  await expect(page.getByTestId('toggle-browser-panel')).toHaveCount(0);
  await expect(nav.getByRole('tab',{name:'Browser',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByTestId('workspace-source')).toBeVisible();
  await expect(page.getByTestId('browser-input-shield')).toBeVisible();
  await page.screenshot({path:`test-results/task-dock-${theme}.png`});
  await nav.getByRole('tab',{name:'Browser',exact:true}).focus();await page.keyboard.press('ArrowRight');
  await expect(nav.getByRole('tab',{name:/^(Result|结果) 1 ·/})).toBeFocused();
  await expect(page.getByTestId('canvas-results').first()).toBeVisible();
  await expect(page.getByRole('tab',{name:'Files',exact:true})).toHaveCount(0);
  await page.keyboard.press('End');
  await expect(nav.getByRole('tab',{name:/Agents/})).toHaveAttribute('aria-selected','true');
  await expect(page.getByTestId('agent-work-panel')).toBeVisible();await expect(page.getByTestId('workspace-source')).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.locator('#task-workspace')).not.toBeVisible();
  await expect(page.getByTestId('open-workspace')).toBeFocused();
  await page.screenshot({path:`test-results/task-dock-collapsed-${theme}.png`});
  await page.getByTestId('open-workspace').click();await expect(nav.getByRole('tab',{name:/Agents/})).toHaveAttribute('aria-selected','true');
  await page.getByTestId('task-dock-header').getByRole('button',{name:'Expand workspace',exact:true}).click();
  await expect(page.getByTestId('workspace-source')).not.toBeVisible();
  await expect(nav.getByRole('tab',{name:/Agents/})).toHaveAttribute('aria-selected','true');
  await page.getByTestId('task-dock-header').getByRole('button',{name:'Restore side panel',exact:true}).click();
  await expect(page.getByTestId('workspace-source')).toBeVisible();
  expect(state.errors).toEqual([]);
});

test('empty task has no empty panel tabs, manual browser remains discoverable',async({page})=>{
  const state=await fixture(page,{browser:false,answer:false});
  await expect(page.getByTestId('task-topbar')).toBeVisible();
  await expect(page.locator('#task-workspace')).not.toBeVisible();await expect(page.getByTestId('open-workspace')).toBeVisible();
  await page.getByTestId('open-workspace').click();await expect(page.getByTestId('workspace-launcher')).toBeVisible();
  await page.getByTestId('task-title-menu').click();await page.getByRole('menuitem',{name:'Open browser',exact:true}).click();
  await expect(tabs(page).getByRole('tab')).toHaveCount(1);await expect(tabs(page).getByRole('tab',{name:'Browser',exact:true})).toBeVisible();
  expect(state.errors).toEqual([]);
});

test('a result-only conversation has a named result tab',async({page})=>{
  const state=await fixture(page,{browser:false});
  await expect(tabs(page).getByRole('tab')).toHaveCount(1);
  await expect(tabs(page).getByRole('tab',{name:/^(Result|结果) 1 ·/})).toBeVisible();
  await expect(page.getByTestId('browser-workspace')).toHaveCount(0);
  await expect(page.getByTestId('agent-work-panel')).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test('new browser calls do not steal selection or reopen a manually hidden panel',async({page})=>{
  await page.setViewportSize({width:1440,height:1000});const state=await fixture(page);
  await tabs(page).getByRole('tab',{name:/^(Result|结果) 1 ·/}).click();
  const composer=page.locator('[data-chat-composer="docked"] textarea');await composer.fill('Continue reviewing the website');await composer.press('Enter');
  await expect.poll(state.started).toBe(true);
  try{
    await expect(page.getByLabel('Browser operation',{exact:true}).locator('option')).toHaveCount(2);
    expect(state.requests.some(r=>r.operation==='trace'&&r.call_id==='browser-1')).toBe(false);
    await expect(tabs(page).getByRole('tab',{name:/^(Result|结果) 1 ·/})).toHaveAttribute('aria-selected','true');
    await close(page);state.advance();
    await expect(page.getByLabel('Browser operation',{exact:true}).locator('option')).toHaveCount(3);
    await expect(page.locator('#task-workspace')).not.toBeVisible();
    state.finish();await expect.poll(state.started).toBe(false);
    await page.reload();await expect(page.getByTestId('open-workspace')).toBeVisible();
    await expect(page.locator('#task-workspace')).not.toBeVisible();
    await page.getByTestId('open-workspace').click();await expect(tabs(page).getByRole('tab',{name:/^(Result|结果) 1 ·/})).toHaveAttribute('aria-selected','true');
    expect(state.errors).toEqual([]);
  }finally{state.finish();}
});

test('switching keeps network state and pauses hidden observation without stopping the browser',async({page})=>{
  await page.setViewportSize({width:1440,height:1000});const state=await fixture(page);
  const browser=page.getByTestId('browser-workspace');await browser.getByRole('button',{name:'More browser tools'}).click();await page.getByRole('menuitem',{name:'Network',exact:true}).click();
  const network=page.getByTestId('browser-network');await network.getByLabel('Filter requests').fill('api/save');
  await network.getByRole('listitem').click();await network.getByRole('button',{name:'Response',exact:true}).click();await expect(network.locator('pre')).toContainText('"saved":true');
  await tabs(page).getByRole('tab',{name:/^(Result|结果) 1 ·/}).click();await page.waitForTimeout(300);
  const readCount=state.requests.filter(r=>r.operation==='network').length;await page.waitForTimeout(1700);
  expect(state.requests.filter(r=>r.operation==='network')).toHaveLength(readCount);
  await tabs(page).getByRole('tab',{name:'Browser',exact:true}).click();
  await expect(network.getByLabel('Filter requests')).toHaveValue('api/save');await expect(network.locator('pre')).toContainText('"saved":true');
  await page.screenshot({path:'test-results/task-dock-network.png'});
  expect(state.requests.some(r=>['close','agent_revoke','open'].includes(r.operation))).toBe(false);
  expect(state.errors).toEqual([]);
});

test('narrow Chinese workspace fits and collapses back to the retained conversation draft',async({page})=>{
  await page.setViewportSize({width:390,height:844});const state=await fixture(page,{members:true,locale:'zh'});
  await expect(tabs(page).getByRole('tab')).toHaveCount(4);
  expect(await page.locator('#task-workspace').evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
  await page.screenshot({path:'test-results/task-dock-mobile.png'});
  await close(page);const composer=page.locator('[data-chat-composer="docked"] textarea');await composer.fill('保留这段草稿');
  await page.getByTestId('open-workspace').click();await tabs(page).getByRole('tab',{name:/^(Result|结果) 1 ·/}).click();await close(page);
  await expect(composer).toHaveValue('保留这段草稿');expect(state.errors).toEqual([]);
});

test('layout preference is scoped to the conversation',async({page})=>{
  await page.setViewportSize({width:1440,height:1000});await fixture(page);
  await close(page);await page.goto('/chat/task-dock-other');
  await expect(page.getByTestId('task-topbar')).toContainText('A separate conversation');await expect(page.locator('#task-workspace')).not.toBeVisible();
  await page.goto(`/chat/${SESSION}`);await expect(page.getByTestId('open-workspace')).toBeVisible();await expect(page.locator('#task-workspace')).not.toBeVisible();
});


test('add and close tabs, restore the launcher, and retain the draft', async ({ page }) => {
  const state = await fixture(page, { browser: false, answer: false });
  const composer = page.locator('[data-chat-composer="docked"] textarea');
  await composer.fill('Unsent sidebar regression draft');
  await page.getByTestId('open-workspace').click();
  await page.getByTestId('workspace-launcher').getByRole('button', { name: 'Terminal', exact: false }).click();
  await expect(page.getByTestId('workspace-terminal')).toBeVisible();
  await page.getByRole('button', { name: 'New tab', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Browser', exact: true }).click();
  await expect(tabs(page).getByRole('tab')).toHaveCount(2);
  await page.getByRole('button', { name: 'Close tab: Browser', exact: true }).click();
  await expect(page.getByTestId('workspace-terminal')).toBeVisible();
  await page.getByRole('button', { name: 'Close tab: Terminal', exact: true }).click();
  await expect(page.getByTestId('workspace-launcher')).toBeVisible();
  await close(page);
  await expect(composer).toHaveValue('Unsent sidebar regression draft');
  expect(state.errors).toEqual([]);
});


test('strategy context opens details and independent backtest tabs', async ({ page }) => {
  const state = await fixture(page, { strategy: true, browser: false, answer: false });
  const nav = tabs(page);
  await expect(nav.getByRole('tab', { name: 'Strategy', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('strategy-workflow-panel')).toContainText('Synthetic sidebar strategy');
  await expect(nav.getByRole('tab')).toHaveCount(3);
  await nav.getByRole('tab', { name: 'Backtest · 2026-09-20', exact: true }).click();
  await expect(page.getByTestId('backtest-report')).toContainText('4.2%');
  await page.getByRole('button', { name: 'Close tab: Backtest · 2026-09-20', exact: true }).click();
  await expect(nav.getByRole('tab')).toHaveCount(2);
  await page.getByRole('button', { name: 'New tab', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Backtest · 2026-09-20', exact: true }).click();
  await expect(nav.getByRole('tab')).toHaveCount(3);
  await expect(page.getByTestId('backtest-report')).toBeVisible();
  expect(state.errors).toEqual([]);
});


test('results open directly and child processes collapse like the main conversation', async ({ page }) => {
  const state = await fixture(page, { browser: false, members: true });
  await tabs(page).getByRole('tab', { name: /^(Result|结果) 1 ·/ }).click();
  await expect(page.getByTestId('canvas-overview')).toHaveCount(0);
  await expect(page.locator('#canvas-content-tab-overview')).toHaveCount(0);
  await expect(page.locator('[role=tabpanel]:visible').getByTestId('canvas-result-body')).toContainText('The report is ready to review.');
  const conversation = page.locator('#chat-workspace-panel-conversation');
  const sent = conversation.locator('[data-turn-role="user"]').first();
  const received = conversation.locator('[data-turn-role="assistant"]').first();
  await sent.hover();
  await expect(sent.getByRole('button', { name: 'Edit message', exact: true })).toBeVisible();
  await expect(sent.getByRole('button', { name: 'Delete message', exact: true })).toBeVisible();
  await expect(received.getByRole('button', { name: /Edit message|Delete message/ })).toHaveCount(0);
  await tabs(page).getByRole('tab', { name: 'Agents', exact: true }).click();
  const child = page.getByTestId('agent-conversation');
  const process = child.locator('[data-turn-section="trace"] > details');
  await expect(process).not.toHaveAttribute('open');
  await process.locator('summary').first().click();
  await expect(child.getByTestId('agent-conversation-stream')).toContainText('I am checking the source dates.');
  await expect(child.locator('[data-turn-role="user"]').filter({hasText:'Please include the original dates.'})).toBeVisible();
  await expect(child.locator('[data-turn-role="assistant"]').filter({hasText:'The source register is ready.'})).toBeVisible();
  await expect(child.getByRole('button', { name: /Edit message|Delete message/ })).toHaveCount(0);
  await process.locator('summary').first().click();
  await expect(process).not.toHaveAttribute('open');
  await page.screenshot({path:'test-results/sidebar-agent-conversation.png'});
  expect(state.errors).toEqual([]);
});


test('files open independent tabs and reopening a file does not duplicate it', async ({page}) => {
  const state=await fixture(page,{browser:false,answer:false});
  await page.getByTestId('open-workspace').click();
  await page.getByTestId('workspace-launcher').getByRole('button',{name:'Files',exact:false}).click();
  await page.getByTestId('workspace-files').getByRole('button',{name:'notes.md',exact:true}).click();
  await expect(tabs(page).getByRole('tab',{name:'notes.md',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.locator('[role=tabpanel]:visible').getByTestId('workspace-resource')).toContainText('Standalone document preview.');
  await tabs(page).getByRole('tab',{name:'Files',exact:true}).click();
  await page.getByTestId('workspace-files').getByRole('button',{name:'report.md',exact:true}).click();
  await expect(tabs(page).getByRole('tab')).toHaveCount(3);
  await tabs(page).getByRole('tab',{name:'Files',exact:true}).click();
  await page.getByTestId('workspace-files').getByRole('button',{name:'notes.md',exact:true}).click();
  await expect(tabs(page).getByRole('tab')).toHaveCount(3);
  await expect(page.getByRole('tab',{name:'Canvas',exact:true})).toHaveCount(0);
  expect(state.errors).toEqual([]);
});


test('child process is expanded while running and folds on completion', async ({page}) => {
  const state=await fixture(page,{browser:false,members:true});
  state.setAgentState('running');
  await tabs(page).getByRole('tab',{name:'Agents',exact:true}).click();
  const child=page.getByTestId('agent-conversation');
  const process=child.locator('[data-turn-section="trace"] > details');
  await expect(process).toHaveAttribute('open','');
  await expect(child.getByTestId('agent-conversation-stream')).toContainText('I am checking the source dates.');
  await page.screenshot({path:'test-results/agent-process-running.png'});
  state.setAgentState('completed');
  await expect(process).not.toHaveAttribute('open');
  await expect(child.locator('[data-turn-section="reply"]').filter({hasText:'The source register is ready.'})).toBeVisible();
  await process.locator('summary').first().click();
  await expect(process).toHaveAttribute('open','');
  await page.screenshot({path:'test-results/agent-process-expanded.png'});
  expect(state.errors).toEqual([]);
});
