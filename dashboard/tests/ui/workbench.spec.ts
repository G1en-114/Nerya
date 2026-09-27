import {test,expect} from "@playwright/test";
import {parityFixture} from "./command-fixture";
import {taskStatus,statusLabel} from "../../lib/workbench";
import {newThread} from "../../lib/chat";

test("completion is grounded in runtime, never final prose",()=>{
 const t={...newThread("test"),messages:[{id:"m1",role:"assistant" as const,ts:1,turn:{final_text:"All done"}}]};
 expect(taskStatus(t).execution).toBe("idle");
 expect(statusLabel({...taskStatus(t),completion:"external_reported"},false)).toContain("external Agent");
});

test("old runtime is explicit and prevents submission",async({page})=>{
 const fixture=await parityFixture(page);
 await page.route("**/api/proxy/runtime/info",route=>route.fulfill({status:404,json:{error:"not found"}}));
 await page.goto("/chat/parity-session");
 await expect(page.getByTestId("runtime-notice")).toContainText("does not support");
 await expect(page.locator("textarea").first()).toBeDisabled();
 await expect(page.getByTestId("native-command-send")).toBeDisabled();
 expect(fixture.requests).toHaveLength(0);
});

test("finished command, collapsed queue and work mode",async({page})=>{
 const fixture=await parityFixture(page,{complete:true});
 await page.goto("/chat/parity-session");
 await expect(page.getByTestId("runtime-notice")).toHaveCount(0);
 await page.getByTestId("composer-add").click();await page.getByRole("menuitemradio",{name:"Plan first",exact:true}).click();
 await page.locator("textarea").first().fill("Plan a research task");
 await page.getByTestId("native-command-send").click();
 await expect(page.getByTestId("task-header-status")).toContainText("Turn finished");
 expect(fixture.requests[0].request.work_mode).toBe("plan");
 expect(fixture.errors).toEqual([]);
});

test("goal mode in plus menu survives reload and reaches the request",async({page},info)=>{
 const fixture=await parityFixture(page,{complete:true,language:"zh"});
 await page.setViewportSize({width:320,height:900});await page.goto("/chat/parity-session");
 const add=page.getByTestId("composer-add");
 await add.click();await expect(page.getByRole("menuitemradio",{name:"Goal 模式"})).toBeInViewport();
 await page.screenshot({path:info.outputPath("plus-menu-320.png")});
 await page.getByRole("menuitemradio",{name:"Goal 模式"}).click();
 await expect(add).toHaveAttribute("data-work-mode","goal");
 await page.reload();await expect(add).toHaveAttribute("data-work-mode","goal");
 expect(await page.getByTestId("composer-dock").evaluate(element=>getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
 const fits=await page.evaluate(()=>{const root=document.querySelector('[data-chat-composer]')!.getBoundingClientRect();const button=document.querySelector('[data-testid="composer-add"]')!.getBoundingClientRect();return button.right<=root.right&&document.documentElement.scrollWidth<=innerWidth;});
 expect(fits).toBe(true);
 await page.screenshot({path:info.outputPath("goal-mode-320.png")});
 await page.locator("[data-chat-composer] textarea").fill("核对报告结果");
 await page.getByTestId("native-command-send").click();
 await expect.poll(()=>fixture.requests.length).toBe(1);
 expect(fixture.requests[0].request.work_mode).toBe("goal");
});

test("durable user question shows choice and retains failed answer",async({page})=>{
 await parityFixture(page);
 const question={interaction_id:"interaction-test",session_id:"parity-session",turn_id:"turn-test",revision:1,state:"pending",kind:"question",payload:{title:"Choose a market",choices:["BTC","ETH"]}};
 await page.route("**/api/proxy/agent/sessions/view?**",route=>route.fulfill({json:{ok:true,session_id:"parity-session",revision:"v1",status:{execution:"awaiting_input",waiting_for:"user",external:false,needs_attention:true},pending_interactions:[question],queue:{count:0,paused:true},approvals:[],agents:[],result_refs:[],available_actions:{send:false,stop:false,guide:false}}}));
 await page.route("**/api/proxy/agent/interactions/respond",route=>route.fulfill({status:409,json:{ok:false,error:"interaction_turn_not_ready"}}));
 await page.goto("/chat/parity-session");
 await expect(page.getByTestId("user-interaction")).toBeVisible();
  await page.getByLabel("BTC",{exact:true}).check();
 await page.getByLabel("Additional details").fill("Use the hourly data");
 await page.getByRole("button",{name:"Answer and continue"}).click();
 await expect(page.getByTestId("user-interaction").getByRole("alert")).toContainText("answer is retained");
 await page.reload();
 await expect(page.getByLabel("Additional details")).toHaveValue("Use the hourly data");
 await expect(page.getByLabel("BTC",{exact:true})).toBeChecked();
});

test("home dispatch waits for runtime handshake and sends once",async({page})=>{
 const fixture=await parityFixture(page,{complete:true});await page.goto("/");
 await expect(page.getByTestId("runtime-notice")).toHaveCount(0);
 await page.locator("textarea").fill("Keep this task on the same path");
 await page.getByTestId("native-command-send").click();
 await expect.poll(()=>fixture.requests.length).toBe(1);
 await expect(page.getByText("Verified fixture response.",{exact:true})).toBeVisible();
 expect(fixture.errors).toEqual([]);
});

test("two windows preserve independent drafts and restore a closed writer",async({page,context})=>{
 await parityFixture(page);await page.goto("/chat/parity-session");
 await expect(page.getByTestId("runtime-notice")).toHaveCount(0);
 await page.locator("textarea").fill("Window one draft");
 await expect.poll(()=>page.evaluate(()=>new Promise<number>((resolve,reject)=>{const r=indexedDB.open("nerya-workbench-drafts");r.onsuccess=()=>{const q=r.result.transaction("drafts").objectStore("drafts").count();q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);};}))).toBeGreaterThan(0);
 const second=await context.newPage();await parityFixture(second);await second.goto("/chat/parity-session");
 await expect(second.getByRole("button",{name:"Restore: Window one draft"})).toBeVisible();
 await second.locator("textarea").fill("Window two draft");await second.reload();
 await expect(second.locator("textarea")).toHaveValue("Window two draft");
 await expect(page.locator("textarea")).toHaveValue("Window one draft");
 await page.close();await second.getByRole("button",{name:"Restore: Window one draft"}).click();
 await expect(second.locator("textarea")).toHaveValue("Window one draft");
});

test("attachment failure retries only that file and keeps the draft",async({page})=>{
 await parityFixture(page);let failed=true;const names:string[]=[];
 await page.route("**/api/proxy/agent/attachments/upload",async route=>{
  const file=route.request().postDataJSON().attachments[0];names.push(file.name);
  if(file.name==="retry.txt"&&failed){failed=false;await route.fulfill({status:503,json:{ok:false}});return;}
  await route.fulfill({json:{ok:true,attachments:[{...file,artifact_uri:"artifact://"+file.id,uploaded:true}]}});
 });
 await page.goto("/chat/parity-session");await expect(page.getByTestId("runtime-notice")).toHaveCount(0);
 await page.locator("textarea").fill("Keep my message");
 await page.locator('input[type="file"]').setInputFiles([{name:"ok.txt",mimeType:"text/plain",buffer:Buffer.from("ok")},{name:"retry.txt",mimeType:"text/plain",buffer:Buffer.from("retry")}]);
 await expect(page.getByTestId("attachment-progress")).toContainText("Upload failed");
 await page.getByRole("button",{name:"Retry this file"}).click();
 await expect(page.getByTestId("attachment-progress")).toHaveCount(0);
 await expect(page.locator("textarea")).toHaveValue("Keep my message");
 expect(names).toEqual(["ok.txt","retry.txt","retry.txt"]);
});

test("1000-message timeline bounds mounted content and finds historical turns",async({page},info)=>{
 const fixture=await parityFixture(page,{historyCount:1000});
 await page.setViewportSize({width:1440,height:1000});
 await page.goto("/chat/parity-session");
 await expect(page.getByTestId("conversation-find")).toHaveCount(0);await page.getByRole("button",{name:"Find in conversation",exact:true}).click();await expect(page.getByTestId("conversation-find")).toBeVisible();
 await expect.poll(()=>page.locator('[data-turn-role="assistant"]').count()).toBeLessThan(35);
 await page.getByRole("searchbox",{name:"Find in conversation"}).fill("historical result 101.");
 await page.getByRole("button",{name:"Next match"}).click();
 await expect(page.getByText("Verified historical result 101.",{exact:false}).first()).toBeVisible();
 const samples=[];
 for(let i=0;i<12;i++)samples.push(await page.evaluate(async()=>{const field=document.querySelector<HTMLTextAreaElement>('[data-chat-composer] textarea')!;const start=performance.now();const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!;setter.call(field,field.value+"x");field.dispatchEvent(new Event("input",{bubbles:true}));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return performance.now()-start;}));
 samples.sort((a,b)=>a-b);await info.attach("input-latency.json",{body:JSON.stringify({messages:1000,median:samples[6],p95:samples[11],measurement:"input to two animation frames, not INP"}),contentType:"application/json"});
 await page.screenshot({path:info.outputPath("long-history.png")});
 expect(fixture.errors).toEqual([]);
});

for(const width of [1440,1280,768,390,320])test("responsive workbench "+width,async({page},info)=>{
 const fixture=await parityFixture(page,{complete:true,language:width===320?"zh":"en",theme:width===390?"light":"dark"});
 await page.setViewportSize({width,height:900});await page.goto("/chat/parity-session");
  await expect(page.getByTestId("composer-add")).toBeVisible();
  await expect(page.getByText("Loading conversation…",{exact:true})).toHaveCount(0);
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:info.outputPath("workbench-"+width+".png")});
 expect(fixture.errors).toEqual([]);
});


test("runtime projection update is visible within one second",async({page})=>{
 await parityFixture(page);let revision="1",execution="running";
 await page.route("**/api/proxy/agent/sessions/view?**",route=>route.fulfill({json:{ok:true,session_id:"parity-session",revision,status:{execution,waiting_for:null,completion:execution==="succeeded"?"turn_finished":null,needs_attention:false,external:false},pending_interactions:[],queue:{count:0,paused:false},approvals:[],agents:[],result_refs:[],available_actions:{send:true,guide:true,stop:true}}}));
 await page.goto("/chat/parity-session");await expect(page.getByTestId("task-header-status")).toHaveText("Running");
 execution="succeeded";revision="2";const start=Date.now();await expect(page.getByTestId("task-header-status")).toHaveText("Turn finished",{timeout:1200});expect(Date.now()-start).toBeLessThan(1000);
});


test("strategy directory renders translated edit label",async({page})=>{
 await parityFixture(page);
 await page.route("**/api/proxy/strategies/runtime/workflows",route=>route.fulfill({json:{ok:true,workflows:[{key:"candidate-one",strategy_id:"strategy-one",proposal_id:"proposal-one",title:"Evidence strategy",mode:"paper",state:"pending_review",counts:{script:1}}]}}));
 await page.goto("/strategies");await expect(page.getByTestId("strategy-directory-card")).toBeVisible();
 await expect(page.getByRole("button",{name:"Edit strategy",exact:true})).toBeVisible();
 await expect(page.getByText("strategyTransfer.edit",{exact:true})).toHaveCount(0);
});
