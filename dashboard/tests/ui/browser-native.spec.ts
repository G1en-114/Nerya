import {test, expect, type Page} from '@playwright/test';
import {browserAddress} from '../../lib/browserNavigation';
import {browserViewportPoint,fitBrowserViewport} from '../../lib/browserViewport';

test('viewport mapping preserves fractional coordinates and rejects letterboxing',()=>{
  const viewport={width:390,height:844};
  const rect={left:100,top:20,width:195,height:422};
  expect(browserViewportPoint(197.5,231,rect,viewport)).toEqual({x:195,y:422});
  expect(browserViewportPoint(100.25,20.25,rect,viewport)).toEqual({x:.5,y:.5});
  for(const [x,y] of [[99,30],[295,30],[101,19],[101,442]])expect(browserViewportPoint(x,y,rect,viewport)).toBeNull();
  expect(fitBrowserViewport(viewport,{width:1200,height:422})).toEqual({width:195,height:422});
});

test.setTimeout(60_000);

type Options = {running?: boolean; human?: boolean; engine?: 'chromium'|'chrome'; locale?: string; theme?: string};
async function fixture(page:Page, options:Options={}) {
  const requests:Record<string,any>[] = [], errors:string[] = [];
  let running=options.running??true, human=options.human??false, sensitive=false;
  let engine=options.engine??'chromium', control=0, selected='1', serial=1;
  let viewport={width:1280,height:800}, viewportRevision=0;
  let pendingDialog:Record<string,unknown>|null=null;
  const tabs=[{id:'1',url:running?'https://example.test/review':'about:blank',selected:true,protected:false}];
  const old=page.viewportSize()!;
  await page.setViewportSize({width:1280,height:800});
  await page.setContent('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#f8f9fa;color:#202124;font:18px system-ui}main{margin:70px auto;width:760px;background:white;padding:40px}h1{font-size:30px}input{font:inherit;padding:12px;width:90%;border:1px solid #ccc}button{padding:10px 20px;margin-top:20px}</style><main><h1>Work browser</h1><p>Synthetic acceptance page. No personal data.</p><label>Project name<input value="Nerya browser review"></label><br><button>Save draft</button></main>');
  const image='data:image/png;base64,'+(await page.screenshot()).toString('base64');
  await page.setViewportSize(old);
  await page.addInitScript(({locale,theme})=>localStorage.setItem('nerya.ui_settings.v1',JSON.stringify({language:locale,darkMode:theme})),{locale:options.locale??'en',theme:options.theme??'light'});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname.replace(/^\/api\/proxy/,'');
    const input=route.request().method()==='POST'?route.request().postDataJSON()||{}:{};
    let body:any={ok:true,items:[],count:0,total:0,events:[],approvals:[]};
    if(path==='/browsers/desktop'){
      requests.push(input);
      if(input.operation==='dialog'){
        if('accept' in input)pendingDialog=null;
        await route.fulfill({json:{ok:true,dialog:pendingDialog}});return;
      }
      if(input.operation==='viewport'&&running){viewport=input.viewport;viewportRevision++;}
      if(input.operation==='open'){running=true;human=!!input.human;control++;}
      if(input.operation==='close')running=false;
      if(input.operation==='engine_apply'){engine=input.engine;human=true;control++;}
      if(input.operation==='command'){
        const action=input.command==='trace_control'?input.payload?.control:input.command;
        if(action==='handoff'){human=true;control++;}
        if(action==='resume')human=false;
      }
      if(input.operation==='native'){
        running=true;human=true;control++;
        if(input.destination!=='focus'){
          sensitive=input.destination!=='web_store';
          tabs.find(t=>t.id===selected)!.url=sensitive?`chrome://${input.destination}/`:'https://chromewebstore.google.com/';
        }
      }
      if(input.operation==='human_command'){
        if(!human||input.control_id!==`control_${control}`){await route.fulfill({json:{ok:false,error:'human_control_changed'}});return;}
        const payload=input.payload||{};
        if(input.command==='navigate'){tabs.find(t=>t.id===selected)!.url=payload.url;sensitive=false;}
        if(input.command==='new_tab'){selected=String(++serial);tabs.push({id:selected,url:'about:blank',selected:true,protected:false});}
        if(input.command==='select_tab')selected=payload.tab_id;
        if(input.command==='close_tab'){
          const id=payload.tab_id||selected;tabs.splice(tabs.findIndex(t=>t.id===id),1);
          if(id===selected)selected=tabs.at(-1)?.id||'';
        }
      }
      const resizedImage='data:image/svg+xml;base64,'+Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${viewport.width}" height="${viewport.height}" viewBox="0 0 ${viewport.width} ${viewport.height}"><rect width="100%" height="100%" fill="#f8f9fa"/><rect x="20" y="20" width="${Math.max(200,viewport.width-40)}" height="200" rx="12" fill="white"/><text x="40" y="65" font-family="system-ui" font-size="22">Embedded browser test</text><text x="40" y="102" font-family="system-ui" font-size="14">${viewport.width} × ${viewport.height} · Synthetic page</text><path d="M40 140H${viewport.width-40}" stroke="#ddd"/></svg>`).toString('base64');
      body={ok:true,running,human_control:human,paused:human,control_id:human?`control_${control}`:'',sensitive,
        viewport,viewport_revision:viewportRevision,
        tabs:running?tabs.map(t=>({...t,selected:t.id===selected,protected:sensitive&&t.id===selected})):[],
        ...(running&&!sensitive?{image:viewportRevision?resizedImage:image}:{}),preferences:{automatic:true},config:{id:'work',version:1,engine,extensions:[]},
        agent_access:{enabled:true,occupied:running,executing:false,session_id:'mb_native_fixture'}};
    }else if(path==='/auth/status')body={ok:true,local_access:true,authenticated:true,password_set:true,enabled:true};
    else if(path==='/workspace')body={root:'native-browser-fixture',live_trading_enabled:false,kill_switch:false};
    else if(path==='/agent/sessions')body={sessions:[],has_more:false};
    else if(path==='/operator/nav')body={ok:true,primary:[],advanced:[],data:{primary:[],advanced:[]}};
    else if(path==='/operator/overview')body={status:'ok',data:{attention:[],counts:{},accounts:[],strategies:[]}};
    else if(path==='/accounts/list')body={accounts:[],ts:0};
    else if(path==='/llm/config')body={ok:true,tiers:[],provider_profiles:[],default_tier:'medium',reasoning_levels:['none']};
    else if(path==='/llm/providers'||path==='/llm/catalog')body={providers:[]};
    else if(path==='/llm/tiers')body={tiers:[],count:0};
    else if(path.includes('strategy/list'))body={ok:true,strategies:[]};
    await route.fulfill({json:body});
  });
  await page.goto('/browsers');
  await expect(page.getByTestId('standalone-browser')).toBeVisible();
  if(running){
    await expect.poll(()=>requests.some(r=>r.operation==='viewport')).toBe(true);
    await expect(page.getByTestId('browser-viewport')).toHaveAttribute('aria-busy','false');
    await expect.poll(()=>page.getByTestId('browser-viewport').locator('img').evaluate((img:HTMLImageElement)=>img.complete&&img.naturalWidth>0)).toBe(true);
  }
  return {requests,errors,showDialog:(dialog:Record<string,unknown>)=>{pendingDialog=dialog;}};
}

for(const [input,url] of [
  ['example.com','https://example.com/'],['localhost:18400/settings','http://localhost:18400/settings'],
  ['https://example.test/a?q=hello','https://example.test/a?q=hello'],
  ['browser notes','https://www.google.com/search?q=browser%20notes'],
  ['中文搜索','https://www.google.com/search?q=%E4%B8%AD%E6%96%87%E6%90%9C%E7%B4%A2'],['about:blank','about:blank'],
])test(`omnibox parses ${input}`,()=>expect(browserAddress(input)).toBe(url));
for(const input of ['javascript:alert(1)','file:///etc/passwd','data:text/html,hello','https://user:pass@example.com'])
  test(`omnibox rejects ${input}`,()=>expect(()=>browserAddress(input)).toThrow());

test('first click takes over without raising native window and forwards keyboard input',async({page})=>{
  const state=await fixture(page);
  await expect(page.getByRole('textbox',{name:'Browser address',exact:true})).toBeEnabled();
  await expect(page.getByTestId('browser-input-shield')).toHaveCount(0);
  await page.getByTestId('browser-viewport').click({position:{x:160,y:120}});
  await expect.poll(()=>state.requests.filter(r=>r.operation==='human_command'&&r.command==='click').length).toBe(1);
  const handoff=state.requests.find(r=>r.operation==='command'&&r.payload?.control==='handoff')!;
  expect(handoff.payload.focus).toBe(false);
  expect(state.requests.find(r=>r.command==='click')?.expected_tab_id).toBe('1');
  await page.keyboard.insertText('你好 Nerya');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(()=>state.requests.filter(r=>r.operation==='human_command').map(r=>r.command)).toEqual(['click','type','press','press']);
  expect(state.requests.find(r=>r.command==='type')?.payload.text).toBe('你好 Nerya');
  expect(state.errors).toEqual([]);
});

test('trackpad bursts merge and never scroll the dashboard',async({page})=>{
  const state=await fixture(page);
  const prevented=await page.getByTestId('browser-viewport').evaluate(element=>{
    let allPrevented=true;
    for(let index=0;index<8;index++){
      const event=new WheelEvent('wheel',{deltaY:20,deltaX:5,bubbles:true,cancelable:true});
      element.dispatchEvent(event);allPrevented=allPrevented&&event.defaultPrevented;
    }
    return allPrevented;
  });
  expect(prevented).toBe(true);
  await expect.poll(()=>state.requests.filter(r=>r.operation==='human_command'&&r.command==='scroll').length).toBe(1);
  expect(state.requests.find(r=>r.command==='scroll')?.payload).toEqual({dx:40,dy:160});
  expect(state.errors).toEqual([]);
});

test('closed browser starts from search with no Agent conversation',async({page})=>{
  const state=await fixture(page,{running:false});
  await expect(page.getByTestId('browser-new-tab')).toBeVisible();
  const search=page.getByRole('textbox',{name:'Search or enter an address',exact:true});
  await search.fill('Nerya browser');await search.press('Enter');
  await expect.poll(()=>state.requests.some(r=>r.command==='navigate')).toBe(true);
  expect(state.requests.find(r=>r.operation==='open')?.human).toBe(true);
  expect(state.requests.find(r=>r.command==='navigate')?.payload.url).toBe('https://www.google.com/search?q=Nerya%20browser');
  expect(state.requests.filter(r=>r.operation==='open')).toHaveLength(1);
  await expect(page).toHaveURL(/\/browsers$/);
  await expect(page.getByTestId('browser-operation-details')).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test('persistent tabs support new, switch, close and address shortcut',async({page})=>{
  const state=await fixture(page);
  const strip=page.getByRole('tablist',{name:'Browser tabs',exact:true});
  await page.getByRole('button',{name:'New tab',exact:true}).click();
  await expect(strip.getByRole('tab')).toHaveCount(2);
  await strip.getByRole('tab').first().click();
  await expect(strip.getByRole('tab').first()).toHaveAttribute('aria-selected','true');
  await page.keyboard.press('ControlOrMeta+l');
  await expect(page.getByRole('textbox',{name:'Browser address',exact:true})).toBeFocused();
  await strip.getByRole('button',{name:/Close tab/}).last().click();
  await expect(strip.getByRole('tab')).toHaveCount(1);
  expect(state.errors).toEqual([]);
});

test('extension store stays in the panel and privileged UI never opens a desktop window',async({page})=>{
  const state=await fixture(page);
  await expect(page.getByRole('button',{name:'Open native window',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Manage extensions',exact:true}).click();
  await page.getByRole('button',{name:'Chrome Web Store',exact:true}).click();
  await expect.poll(()=>state.requests.some(r=>r.command==='navigate'&&r.payload?.url==='https://chromewebstore.google.com/')).toBe(true);
  const address=page.getByRole('textbox',{name:'Browser address',exact:true});
  await address.fill('chrome://password-manager/passwords');await address.press('Enter');
  await expect(page.getByTestId('browser-workspace').getByRole('alert')).toContainText('No desktop window will open');
  expect(state.requests.some(r=>r.operation==='native'||r.operation==='engine_apply')).toBe(false);
  expect(state.errors).toEqual([]);
});

test('default fills the available panel and follows window resizing',async({page})=>{
  const state=await fixture(page);
  await expect(page.getByRole('combobox',{name:'Page size',exact:true})).toHaveValue('fill');
  async function assertFill(){
    const stage=await page.getByTestId('browser-viewport-stage').boundingBox();
    await expect.poll(()=>state.requests.filter(r=>r.operation==='viewport').at(-1)?.viewport).toEqual({width:Math.floor(stage!.width),height:Math.floor(stage!.height)});
    await expect.poll(async()=>{
      const inner=await page.getByTestId('browser-viewport').boundingBox();
      return Math.abs(inner!.width-stage!.width)<2&&Math.abs(inner!.height-stage!.height)<2;
    }).toBe(true);
  }
  await assertFill();
  await page.setViewportSize({width:1100,height:760});
  await assertFill();
  expect(state.requests.some(r=>r.operation==='open'||r.operation==='native')).toBe(false);
  expect(state.errors).toEqual([]);
});

test('phone preset scales coordinates and ignores the surrounding margin',async({page},info)=>{
  const state=await fixture(page);
  await page.getByRole('combobox',{name:'Page size',exact:true}).selectOption('phone');
  await expect(page.getByTestId('browser-viewport-size')).toHaveText('390 × 844');
  await expect(page.getByTestId('browser-viewport')).toHaveAttribute('aria-busy','false');
  const view=await page.getByTestId('browser-viewport').boundingBox();
  await page.getByTestId('browser-viewport').evaluate(element=>{
    element.addEventListener('click',event=>{
      const click=event as MouseEvent, rect=element.getBoundingClientRect();
      (element as HTMLElement).dataset.observedPoint=JSON.stringify({x:click.clientX,y:click.clientY,left:rect.left,top:rect.top,width:rect.width,height:rect.height});
    },{once:true});
  });
  await page.getByTestId('browser-viewport').click({position:{x:view!.width/2,y:view!.height/2}});
  await expect.poll(()=>state.requests.filter(r=>r.command==='click').length).toBe(1);
  const click=state.requests.find(r=>r.command==='click')!;
  const pointer=JSON.parse((await page.getByTestId('browser-viewport').getAttribute('data-observed-point'))!);
  expect(click.payload.x).toBeCloseTo((pointer.x-pointer.left)/pointer.width*390,8);
  expect(click.payload.y).toBeCloseTo((pointer.y-pointer.top)/pointer.height*844,8);
  // The OS dispatches integer CSS pixels; a reduced preview spans multiple page pixels.
  expect(Math.abs(click.payload.x-195)).toBeLessThanOrEqual(Math.ceil(390/view!.width)+1);
  expect(Math.abs(click.payload.y-422)).toBeLessThanOrEqual(Math.ceil(844/view!.height)+1);
  expect(click.expected_viewport_revision).toBeGreaterThan(0);
  const stage=await page.getByTestId('browser-viewport-stage').boundingBox();
  await page.mouse.click(stage!.x+4,stage!.y+4);
  expect(state.requests.filter(r=>r.command==='click')).toHaveLength(1);
  await page.screenshot({path:info.outputPath('embedded-phone.png')});
  expect(state.errors).toEqual([]);
});

test('custom dimensions apply and rotate without reopening the browser',async({page},info)=>{
  const state=await fixture(page);
  await page.getByRole('combobox',{name:'Page size',exact:true}).selectOption('custom');
  await page.getByRole('spinbutton',{name:'Width',exact:true}).fill('1200');
  await page.getByRole('spinbutton',{name:'Height',exact:true}).fill('700');
  await page.getByRole('button',{name:'Apply',exact:true}).click();
  await expect(page.getByTestId('browser-viewport-size')).toHaveText('1200 × 700');
  await page.getByRole('button',{name:'Rotate',exact:true}).click();
  await expect(page.getByTestId('browser-viewport-size')).toHaveText('700 × 1200');
  expect(state.requests.some(r=>r.operation==='open'||r.operation==='native')).toBe(false);
  await page.screenshot({path:info.outputPath('embedded-custom.png')});
  expect(state.errors).toEqual([]);
});

test('website prompts stay inside the panel and require an explicit decision',async({page})=>{
  const state=await fixture(page,{human:true});
  state.showDialog({id:'dialog-one',type:'prompt',message:'Synthetic question',default_value:'draft',url:'https://example.test/'});
  const dialog=page.getByRole('dialog',{name:'Website confirmation',exact:true});
  await expect(dialog).toBeVisible();
  expect(state.requests.some(r=>r.operation==='dialog'&&'accept' in r)).toBe(false);
  await dialog.getByRole('textbox',{name:'Response text',exact:true}).fill('operator answer');
  await dialog.getByRole('button',{name:'Confirm',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  const answer=state.requests.find(r=>r.operation==='dialog'&&'accept' in r)!;
  expect(answer).toMatchObject({dialog_id:'dialog-one',control_id:'control_0',accept:true,text:'operator answer'});
  expect(state.requests.some(r=>r.operation==='native')).toBe(false);
  expect(state.errors).toEqual([]);
});

for(const [locale,theme,width] of [['en','light',1440],['zh','dark',1440],['zh','light',390]] as const)
  test(`standalone layout ${locale} ${theme} ${width}`,async({page},info)=>{
    await page.setViewportSize({width,height:900});
    const state=await fixture(page,{running:false,locale,theme});
    await expect(page.getByTestId('browser-new-tab')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    expect(await page.getByTestId('browser-workspace').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    await page.screenshot({path:info.outputPath(`browser-${locale}-${theme}-${width}.png`)});
    expect(state.errors).toEqual([]);
  });
