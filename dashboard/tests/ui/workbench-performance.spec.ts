import {test,expect} from "@playwright/test";
import {parityFixture} from "./command-fixture";

for(const count of [300,1000])test("production history "+count,async({page},info)=>{
 const fixture=await parityFixture(page,{historyCount:count});await page.setViewportSize({width:1440,height:1000});
 await page.addInitScript(()=>{
  (window as any).__interactions=[];
  new PerformanceObserver(list=>{for(const entry of list.getEntries())if((entry as any).interactionId)(window as any).__interactions.push({duration:entry.duration,id:(entry as any).interactionId});}).observe({type:"event",buffered:true,durationThreshold:16} as any);
 });
 await page.goto("/chat/parity-session");await expect(page.getByTestId("conversation-find")).toHaveCount(0);await page.getByRole("button",{name:"Find in conversation",exact:true}).click();await expect(page.getByTestId("conversation-find")).toBeVisible();
 await page.getByRole("searchbox",{name:"Find in conversation"}).fill("historical result 101.");await page.getByRole("button",{name:"Next match"}).click();
 const target=page.getByText("Verified historical result 101.",{exact:false}).first();await expect(target).toBeVisible();
 await expect.poll(()=>page.locator('[data-turn-role="assistant"]').count()).toBeLessThan(35);
 const before=await target.evaluate(e=>e.getBoundingClientRect().top);
 const field=page.locator('[data-chat-composer] textarea');await field.click();
 const samples:number[]=[];
 for(let i=0;i<12;i++){
  samples.push(await page.evaluate(async(index)=>{
   const input=document.querySelector<HTMLTextAreaElement>('[data-chat-composer] textarea')!;
   const start=performance.now();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,"Draft "+index);input.dispatchEvent(new Event("input",{bubbles:true}));
   await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);return performance.now()-start;
  },i));
 }
 await field.pressSequentially(" more evidence",{delay:35});
 const after=await target.evaluate(e=>e.getBoundingClientRect().top);
 samples.sort((a,b)=>a-b);
 const interactions=await page.evaluate(()=>(window as any).__interactions as {id:number;duration:number}[]);
 const grouped=new Map<number,number>();for(const item of interactions)grouped.set(item.id,Math.max(grouped.get(item.id)||0,item.duration));
 const worst=grouped.size?Math.max(...grouped.values()):0;
 const metrics={count,p95InputToTwoFramesMs:samples.at(-1),medianMs:samples[6],scrollDrift:Math.abs(after-before),observedInteractionMaxMs:worst,observedInteractionCount:grouped.size,note:"Synthetic input timing and controlled browser Event Timing, not field INP."};
 await info.attach("production-metrics.json",{body:JSON.stringify(metrics),contentType:"application/json"});
 await page.screenshot({path:info.outputPath("history-"+count+".png")});
 expect(metrics.scrollDrift).toBeLessThanOrEqual(4);expect(metrics.p95InputToTwoFramesMs).toBeLessThan(100);expect(worst).toBeLessThanOrEqual(200);
 expect(fixture.errors).toEqual([]);
});
