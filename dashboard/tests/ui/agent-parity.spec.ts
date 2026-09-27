import { test,expect } from "@playwright/test";
import { parityFixture } from "./command-fixture";

const input=(page:import("@playwright/test").Page)=>page.locator("[data-chat-composer] textarea");
async function start(page:import("@playwright/test").Page) {await page.goto("/chat/parity-session");await expect(input(page)).toBeVisible();}

test("running tasks accept queue and guidance; stop waits for terminal confirmation",async({page},info)=>{
  const state=await parityFixture(page);await start(page);
  await input(page).fill("Inspect the source evidence");await page.getByTestId("native-command-send").click();
  await expect(page.getByTestId("task-header-status")).toContainText("Running");
  await input(page).fill("Second independent task");await input(page).press("Enter");
  await expect(page.getByTestId("conversation-queue")).toContainText("Second independent task");
  await input(page).fill("Keep the original constraints");await page.getByTestId("guide-current-turn").click();
  await expect(page.getByTestId("guidance-receipt")).toHaveAttribute("data-state","delivered");
  const guide=[...state.commands.values()].find(item=>item.kind === "guide")!;state.setState(guide.command_id,"injected");
  await expect(page.getByTestId("guidance-receipt")).toHaveCount(0);
  await page.getByTestId("stop-current-command").click();
  await expect(page.getByTestId("task-header-status")).toContainText("Stopping");
  await page.screenshot({path:info.outputPath("stopping-and-queue.png"),fullPage:true});
  const active=[...state.commands.values()].find(item=>item.state === "stopping")!;
  expect(state.controls.filter(item=>item.action === "stop")).toHaveLength(1);
  state.setState(active.command_id,"interrupted");
  await expect(page.getByTestId("command-execution-state")).toHaveCount(0);
  await expect(page.locator('[data-turn-role="assistant"]').first()).toContainText("Stopped");
  expect(state.requests).toHaveLength(3);expect(state.errors).toEqual([]);
});

test("queue edit, order, remove and pause are confirmed by server revisions",async({page})=>{
  const state=await parityFixture(page);await start(page);
  for(const text of ["Run first","Queue second","Queue third"]) {await input(page).fill(text);await page.getByTestId("native-command-send").click();await expect.poll(()=>state.requests.length).toBe(text === "Run first"?1:text === "Queue second"?2:3);}
  const queue=page.getByTestId("conversation-queue");await expect(queue.locator("li")).toHaveCount(2);await queue.locator("summary").click();
  await queue.locator("li").first().getByRole("button",{name:"Edit",exact:true}).click();
  await queue.getByRole("textbox").fill("Edited second task");await queue.getByRole("button",{name:"Save message"}).click();
  await expect(queue).toContainText("Edited second task");
  await queue.locator("li").last().getByRole("button",{name:"Move message up"}).click();
  await expect(queue.locator("li").first()).toContainText("Queue third");
  await queue.getByRole("button",{name:"Pause queue"}).click();await expect(queue).toContainText("Queue paused");
  await queue.locator("li").last().getByRole("button",{name:"Remove",exact:true}).click();await expect(queue.locator("li")).toHaveCount(1);
  expect(state.errors).toEqual([]);
});

test("lost ACK retains original request; recovery and reload do not resubmit work",async({page})=>{
  const state=await parityFixture(page,{loseAck:true});await start(page);
  await input(page).fill("Exactly one admitted request");await page.getByTestId("native-command-send").click();
  await expect(page.getByTestId("command-delivery-unconfirmed")).toBeVisible();
  expect(state.requests).toHaveLength(1);
  await page.getByRole("button",{name:"Check original request"}).click();
  await expect(page.getByTestId("command-delivery-unconfirmed")).toHaveCount(0);
  await page.reload();await expect(page.getByTestId("task-header-status")).toContainText("Running");
  expect(state.requests).toHaveLength(1);expect(state.errors).toEqual([]);
});

test("checkpoint continuation has resume identity, not a replay of the first prompt",async({page})=>{
  const state=await parityFixture(page);await start(page);
  await input(page).fill("Original research task");await page.getByTestId("native-command-send").click();
  await expect.poll(()=>state.commands.size).toBe(1);
  const command=[...state.commands.values()][0];state.setState(command.command_id,"blocked");state.setCheckpoint({turn_id:command.turn_id,resumable:true});
  await page.getByRole("button",{name:"Continue checkpoint"}).click();
  await expect.poll(()=>state.requests.length).toBe(2);
  expect(state.requests[1].command_type).toBe("resume");
  expect(state.requests[1].request.resume_turn_id).toBe(command.turn_id);
  expect(state.requests[1].request.continuation_feedback).toContain("saved checkpoint");
  expect(state.errors).toEqual([]);
});

for(const theme of ["light","dark"]) test(`keyboard, context details and narrow layout in ${theme}`,async({page},info)=>{
  const state=await parityFixture(page,{theme,complete:true});await page.setViewportSize({width:390,height:844});await start(page);
  await input(page).fill("中文输入不会误发");await input(page).dispatchEvent("keydown",{key:"Enter",isComposing:true});expect(state.requests).toHaveLength(0);
  await page.getByTestId("native-command-send").click();
  await expect(page.locator('[data-turn-role="assistant"]')).toContainText("Verified fixture response.");
  await page.getByTestId("turn-context").first().click();
  await expect(page.getByRole("dialog")).toContainText("not a provider-verified limit");await page.keyboard.press("Escape");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth+1)).toBe(true);
  await page.screenshot({path:info.outputPath(`mobile-${theme}.png`),fullPage:true});
  expect(state.errors).toEqual([]);
});

test("300-message history keeps input responsive and preserves the reading anchor",async({page},info)=>{
  const state=await parityFixture(page,{historyCount:300});await page.setViewportSize({width:1440,height:1000});await start(page);
  await expect.poll(()=>page.locator('[data-turn-role="assistant"]').count()).toBeLessThan(35);
  const transcript=page.getByTestId("transcript-scroll");await transcript.evaluate(node=>{node.scrollTop=100;node.dispatchEvent(new Event("scroll"));});
  const anchor=await transcript.evaluate(node=>node.scrollTop);
  const samples:number[]=[];
  for(let index=0;index<12;index++) {
    const elapsed=await page.evaluate(async (index)=>{
      const input=document.querySelector<HTMLTextAreaElement>('[data-chat-composer] textarea')!;
      const start=performance.now();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,`Draft ${index}`);
      input.dispatchEvent(new Event("input",{bubbles:true}));
      await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
      return performance.now()-start;
    },index);samples.push(elapsed);
  }
  await input(page).fill("A preserved draft in a long history");await expect(input(page)).toHaveValue("A preserved draft in a long history");
  const after=await transcript.evaluate(node=>node.scrollTop);expect(Math.abs(after-anchor)).toBeLessThan(2);
  samples.sort((a,b)=>a-b);const metric={messages:300,inputToTwoFramesMedianMs:samples[6],inputToTwoFramesP95Ms:samples[11],scrollDrift:after-anchor};
  await info.attach("long-history-performance.json",{body:JSON.stringify(metric,null,2),contentType:"application/json"});
  expect(metric.inputToTwoFramesP95Ms).toBeLessThan(1500);
  await page.screenshot({path:info.outputPath("long-history-desktop.png"),fullPage:true});
  expect(state.errors).toEqual([]);
});

test("Chinese run controls remain translated and fit a compact workspace",async({page},info)=>{
  const state=await parityFixture(page,{language:"zh",theme:"light"});await page.setViewportSize({width:820,height:900});await start(page);
  await input(page).fill("核对资料来源");await page.getByTestId("native-command-send").click();
  await expect(page.getByTestId("task-header-status")).toContainText("执行中");
  await input(page).fill("追加说明");
  await expect(page.getByTestId("guide-current-turn")).toHaveText("指导本轮");
  await expect(page.getByTestId("native-command-send")).toHaveAttribute("aria-label","排队发送");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth+1)).toBe(true);
  await page.screenshot({path:info.outputPath("compact-chinese.png"),fullPage:true});expect(state.errors).toEqual([]);
});

test("history branch creates a draft without automatically executing it",async({page})=>{
  const state=await parityFixture(page,{complete:true});await start(page);
  await input(page).fill("Original wording");await page.getByTestId("native-command-send").click();
  await page.getByTestId("fork-from-message").click();
  const dialog=page.getByRole("dialog");await dialog.getByRole("textbox").fill("Revised branch wording");
  await dialog.getByTestId("create-history-branch").click();
  await expect(page).toHaveURL(/\/chat\/branch_a{32}$/);await expect(input(page)).toHaveValue("Revised branch wording");
  expect(state.requests).toHaveLength(1);expect(state.controls).toHaveLength(1);expect(state.errors).toEqual([]);
});
