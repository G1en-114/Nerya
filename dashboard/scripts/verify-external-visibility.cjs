'use strict';
// Real stored MCP results. Only the legacy UI preference is seeded; no mocked APIs/data.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'), base='http://127.0.0.1:18380';
const receipt=JSON.parse(fs.readFileSync(path.join(root,'test-results/mcp-followup-verification.json'),'utf8'));
const results={session_id:receipt.session_id,checks:[],pageErrors:[],modelCalls:[],screenshots:[]};
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const width of [1440,900,390]){
   const context=await browser.newContext({viewport:{width,height:950},locale:'zh-CN',reducedMotion:'reduce'});
   await context.addInitScript(sid=>sessionStorage.setItem('nerya.chat.task-dock.v2',JSON.stringify({[sid]:{open:true,expanded:true,selected:'files',tabs:['files'],dismissed:[]}})),receipt.session_id);
   const page=await context.newPage(); page.setDefaultTimeout(20000);
   page.on('pageerror',e=>results.pageErrors.push(e.message));
   page.on('request',r=>{if(r.url().includes('/agent/run_turn'))results.modelCalls.push(r.url());});
   const composer=page.locator('[data-composer-mode="external"]'), feed=page.getByTestId('external-timeline');
   const checkComposer=async()=>{
    await expect(composer).toBeVisible(); await expect(composer.locator('button')).toHaveCount(1);
    await expect(composer.getByTestId('external-send')).toHaveText('发送');
    await expect(composer.locator('[data-composer-models],input[type="file"]')).toHaveCount(0);
    const ok=await composer.evaluate(el=>{const r=el.getBoundingClientRect();return r.height>0&&r.top>=0&&r.bottom<=innerHeight+1;});
    if(!ok)throw new Error('Composer is outside the viewport at '+width);
   };
   try{
    await page.goto(base+'/chat/'+receipt.session_id,{waitUntil:'domcontentloaded'});
    // Crucially: no closeDock() or similar workaround before these assertions.
    await expect(feed).toBeVisible(); await checkComposer();
    const proposal=feed.locator('[data-proposal-id="'+receipt.proposal_id+'"]');
    const asset=feed.getByTestId('research-instrument-card').first();
    await expect(proposal).toHaveCount(1); await expect(proposal).toBeVisible(); await expect(asset).toBeVisible();
    await expect(proposal.getByTestId('strategy-workflow-panel')).toHaveAttribute('aria-busy','false');
    if(width===900){await proposal.scrollIntoViewIfNeeded(); const p='test-results/external-visible-strategy.png';await page.screenshot({path:path.join(root,p)});results.screenshots.push('agent/'+p);}
    await composer.locator('textarea').fill('未发送的布局验证草稿');
    await asset.click(); await expect(page.getByTestId('research-instrument-panel')).toBeVisible();
    await expect(page.getByTestId('research-instrument-panel').getByTestId('financial-chart')).toBeVisible();
    await checkComposer(); await expect(composer.locator('textarea')).toHaveValue('未发送的布局验证草稿');
    if(width===1440){const buttons=page.getByTestId('task-dock-header').getByRole('button');await buttons.nth(await buttons.count()-2).click();}
    await expect(page.getByTestId('return-to-external-conversation')).toBeVisible(); await checkComposer();
    if(width===900){const p='test-results/external-visible-instrument.png';await page.screenshot({path:path.join(root,p)});results.screenshots.push('agent/'+p);}
    await page.getByTestId('return-to-external-conversation').click(); await expect(feed).toBeVisible(); await checkComposer();
    await page.reload({waitUntil:'domcontentloaded'}); await expect(feed).toBeVisible(); await checkComposer();
    if(width===390){await page.setViewportSize({width,height:568}); await checkComposer(); const p='test-results/external-visible-mobile.png';await page.screenshot({path:path.join(root,p)});results.screenshots.push('agent/'+p);}
    results.checks.push({width,legacy_fullscreen_recovers:true,cards_visible_without_workaround:true,composer_only_send:true,composer_stays_with_instrument:true,draft_preserved:true,reload_visible:true});
   }catch(e){await page.screenshot({path:path.join(root,'test-results/external-visibility-failure.png')}).catch(()=>{});throw e;}finally{await context.close();}
  }
  if(results.pageErrors.length||results.modelCalls.length)throw new Error(JSON.stringify(results));
  fs.writeFileSync(path.join(root,'test-results/external-visibility-verification.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
