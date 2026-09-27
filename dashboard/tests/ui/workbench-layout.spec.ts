import {test,expect} from "@playwright/test";
import {parityFixture} from "./command-fixture";

test('search is optional, compact and does not move the transcript',async({page},info)=>{
 const state=await parityFixture(page,{historyCount:300});await page.setViewportSize({width:1440,height:1000});await page.goto('/chat/parity-session');
 await expect(page.locator('[data-turn-role="assistant"]').first()).toBeAttached();
 await expect(page.getByTestId('workbench-tasks').locator('input')).toHaveCount(0);
 await expect(page.getByTestId('conversation-find')).toHaveCount(0);
 await expect(page.getByTestId('runtime-diagnostics')).toHaveCount(0);
 const box=await page.getByTestId('transcript-scroll').boundingBox();
 const trigger=page.getByRole('button',{name:'Find in conversation',exact:true});await trigger.click();
 await expect(page.getByTestId('conversation-find')).toBeVisible();
 const find=await page.getByTestId('conversation-find').boundingBox();expect(find!.width).toBeLessThanOrEqual(360);
 expect(await page.getByTestId('transcript-scroll').boundingBox()).toEqual(box);
 await page.getByRole('searchbox',{name:'Find in conversation'}).fill('historical result 101');await page.getByRole('button',{name:'Next match'}).click();
 await expect(page.getByText('Verified historical result 101.',{exact:false}).first()).toBeVisible();
 await page.keyboard.press('Escape');await expect(page.getByTestId('conversation-find')).toHaveCount(0);await expect(trigger).toBeFocused();
 await page.keyboard.press('ControlOrMeta+f');await expect(page.getByTestId('conversation-find')).toBeVisible();await page.keyboard.press('Escape');
 await page.screenshot({path:info.outputPath('conversation.png')});expect(state.errors).toEqual([]);
});

test('global search retrieves backend tasks and does not auto-send',async({page})=>{
 const state=await parityFixture(page);await page.route('**/api/proxy/agent/sessions?**',route=>{
  const q=new URL(route.request().url()).searchParams.get('q');return route.fulfill({json:{sessions:q?[{session_id:'server-task',meta:{title:'Research evidence'},match:{message_id:'older-message',snippet:'needle inside historical evidence'}}]:[],has_more:false}});
 });
 await page.goto('/chat');await page.getByRole('button',{name:'Search',exact:true}).click();
 const dialog=page.locator('[data-command-palette]');await dialog.getByRole('combobox').fill('needle');
 await expect(dialog.getByRole('option').filter({hasText:'Research evidence'})).toBeVisible();
 await dialog.getByRole('combobox').press('Enter');await expect(page).toHaveURL(/\/chat\/server-task\?message=older-message/);expect(state.requests).toHaveLength(0);
});

test('chat cache events from another tab do not close menus or discard focus',async({page})=>{
 await parityFixture(page);await page.goto('/chat/parity-session');await page.getByTestId('composer-add').click();await expect(page.getByRole('menuitemradio',{name:'Plan first'})).toBeVisible();
 await page.evaluate(()=>{for(let n=0;n<8;n++)window.dispatchEvent(new StorageEvent('storage',{key:'nerya.chat.threads.v1',storageArea:localStorage,newValue:'[]'}));});
 await expect(page.getByRole('menuitemradio',{name:'Plan first'})).toBeVisible();await expect(page.getByTestId('auth-gate')).toHaveCount(0);
 await page.getByRole('menuitemradio',{name:'Plan first'}).click();await expect(page.locator('[data-composer-work-mode]')).toHaveText('Plan first');
});

for(const width of [320,390,768,1440])test('composer controls fit '+width,async({page},info)=>{
 const state=await parityFixture(page,{language:width===320?'zh':'en',theme:width===390?'light':'dark'});await page.setViewportSize({width,height:900});await page.goto('/chat/parity-session');
 await expect(page.getByTestId('composer-add')).toBeEnabled();await expect(page.getByTestId('auth-gate')).toHaveCount(0);
 const metrics=await page.evaluate(()=>{
 const root=document.querySelector('[data-chat-composer]')!.getBoundingClientRect();const buttons=[...document.querySelectorAll('[data-composer-toolbar] button')].map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,height:r.height};});
 return {overflow:document.documentElement.scrollWidth>innerWidth,root:{left:root.left,right:root.right},buttons,header:document.querySelector('[data-testid="task-topbar"]')!.getBoundingClientRect().height};});
 expect(metrics.overflow).toBe(false);expect(metrics.header).toBeLessThanOrEqual(50);
 for(const b of metrics.buttons){expect(b.left).toBeGreaterThanOrEqual(metrics.root.left);expect(b.right).toBeLessThanOrEqual(metrics.root.right);expect(b.width).toBeGreaterThan(20);}
 await page.screenshot({path:info.outputPath('layout-'+width+'.png')});expect(state.errors).toEqual([]);
});

test('split workspace preserves the readable composer and hides diagnostics by default',async({page},info)=>{
 const state=await parityFixture(page,{historyCount:10});await page.setViewportSize({width:1360,height:900});await page.goto('/chat/parity-session');
 await expect(page.getByTestId('composer-add')).toBeEnabled();await page.getByRole('button',{name:'Open workspace',exact:true}).click();
 await expect(page.getByRole('complementary',{name:'Task workspace'})).toBeVisible();
 await expect(page.getByTestId('workspace-source')).toBeVisible();await expect(page.locator('[data-chat-composer]')).toBeVisible();
 await expect(page.getByTestId('conversation-find')).toHaveCount(0);await expect(page.getByTestId('runtime-diagnostics')).toHaveCount(0);
 const fits=await page.evaluate(()=>{const r=document.querySelector('[data-chat-composer]')!.getBoundingClientRect();return [...document.querySelectorAll('[data-composer-toolbar] button')].every(el=>{const b=el.getBoundingClientRect();return b.left>=r.left&&b.right<=r.right;});});expect(fits).toBe(true);
 await page.getByTestId('task-title-menu').click();await page.getByRole('menuitem',{name:'Runtime diagnostics'}).click();
 await expect(page.getByRole('dialog').getByTestId('runtime-diagnostics')).toContainText('isolated-test-build');await page.keyboard.press('Escape');
 await page.screenshot({path:info.outputPath('split-workspace.png')});expect(state.errors).toEqual([]);
});
