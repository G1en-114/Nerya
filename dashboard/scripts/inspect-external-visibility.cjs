'use strict';
// Read-only diagnostic against the running local service, not injected fixtures.
const { chromium } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const base = 'http://127.0.0.1:18380';
(async () => {
 const browser = await chromium.launch({headless:true});
 const page = await browser.newPage({viewport:{width:1440,height:950},locale:'zh-CN'});
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 try {
  await page.goto(base+'/chat',{waitUntil:'domcontentloaded'});
  const response = await page.request.get(base+'/api/proxy/agent/sessions?limit=100');
  const data = await response.json();
  const sessions=(data.sessions||[]).filter(s=>['mcp','tunnel'].includes(s.source)||/^ext_(mcp|tunnel)_/.test(s.session_id));
  console.log('SESSIONS',JSON.stringify(sessions.slice(0,12).map(s=>({id:s.session_id,title:s.title,source:s.source,count:s.message_count}))));
  const chosen=[...sessions.filter(s=>!/验收|acceptance|test/i.test(s.title||'')).slice(0,2),...sessions.filter(s=>(s.title||'').includes('补充消息')).slice(0,1)];
  const rows=[];
  for(const s of chosen){
   const transcript=await (await page.request.get(base+'/api/proxy/agent/session/transcript?session_id='+encodeURIComponent(s.session_id)+'&full=1')).json();
   const calls=(transcript.messages||[]).flatMap(m=>m.turn?.external_call?[m.turn.external_call]:[]);
   const row={id:s.session_id,title:s.title,source:s.source,transcriptSource:transcript.source,messageCount:(transcript.messages||[]).length,calls:calls.map(c=>({tool:c.tool,status:c.status,keys:Object.keys(c.result||{}),charts:c.presentation_blocks?.length||0})),views:[]};
   for(const width of [1440,900]){
    await page.setViewportSize({width,height:950});
    await page.goto(base+'/chat/'+s.session_id,{waitUntil:'domcontentloaded'});
    await page.waitForTimeout(2200);
    row.views.push(await page.evaluate(()=>{
     const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0&&getComputedStyle(e).visibility!=='hidden';
     const rect=e=>e?({top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom,height:e.getBoundingClientRect().height}):null;
     const input=document.querySelector('[data-chat-composer] textarea');
     return {width:innerWidth,input:visible(input),inputRect:rect(input),viewportHeight:innerHeight,external:!!document.querySelector('[data-testid="external-session"]'),sourceHidden:!visible(document.querySelector('[data-testid="workspace-source"]')),timeline:visible(document.querySelector('[data-testid="external-timeline"]')),proposals:document.querySelectorAll('[data-proposal-id]').length,instruments:document.querySelectorAll('[data-testid="research-instrument-card"]').length,composerButtons:[...document.querySelectorAll('[data-chat-composer] button')].map(e=>({label:e.getAttribute('aria-label')||e.innerText,visible:visible(e)})),text:document.body.innerText.slice(-750)};
    }));
   }
   rows.push(row);
  }
  const out={rows,errors};
  const dest=path.resolve(__dirname,'../../test-results/external-visibility-before.json');
  fs.writeFileSync(dest,JSON.stringify(out,null,2)+'\n'); console.log(JSON.stringify(out,null,2));
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
