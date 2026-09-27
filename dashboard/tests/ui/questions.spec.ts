import { test, expect } from "@playwright/test";
import { parityFixture } from "./command-fixture";

test("per-question drafts, custom answers, retries and last selection", async ({page}) => {
  await parityFixture(page);
  const item={interaction_id:"questions-test",session_id:"parity-session",turn_id:"turn-test",revision:1,state:"pending",kind:"question",payload:{title:"Strategy inputs",questions:[
    {id:"market",question:"Which market?",options:["BTC","ETH"],multiple:false},
    {id:"rules",question:"Which rules?",options:["ATR","Trend"],multiple:true},
    {id:"period",question:"Which period?",options:["1h","4h"],multiple:false}]}};
  await page.route("**/api/proxy/agent/sessions/view?**",route=>route.fulfill({json:{ok:true,session_id:"parity-session",revision:"v1",status:{execution:"awaiting_input",waiting_for:"user",external:false,needs_attention:true},pending_interactions:[item],queue:{count:0,paused:true},approvals:[],agents:[],result_refs:[],available_actions:{send:false,stop:false,guide:false}}}));
  const requests:any[]=[];
  await page.route("**/api/proxy/agent/interactions/respond",route=>{requests.push(route.request().postDataJSON());return route.fulfill({status:409,json:{ok:false}});});
  await page.goto("/chat/parity-session");
  const card=page.getByTestId("user-interaction");
  await expect(card.getByLabel("BTC",{exact:true})).not.toBeChecked();
  await card.getByLabel("BTC",{exact:true}).click();
  await expect(card).toContainText("Which rules?");
  await card.getByLabel("ATR",{exact:true}).check();
  await card.getByLabel("Trend",{exact:true}).check();
  await card.getByLabel("Custom answer").fill("Also use volume");
  await card.getByRole("button",{name:"Previous question"}).click();
  await card.getByLabel("Custom answer").fill("SOL");
  await expect(card.getByLabel("BTC",{exact:true})).not.toBeChecked();
  await card.getByRole("button",{name:"Continue",exact:true}).click();
  await page.reload();
  await expect(card).toContainText("Which rules?");
  await expect(card.getByLabel("ATR",{exact:true})).toBeChecked();
  await expect(card.getByLabel("Custom answer")).toHaveValue("Also use volume");
  await card.getByRole("button",{name:"Continue",exact:true}).click();
  await card.getByLabel("4h",{exact:true}).click();
  await expect(card.getByRole("alert")).toBeVisible();
  expect(requests[0].answers).toEqual({market:{selected:[],text:"SOL"},rules:{selected:["ATR","Trend"],text:"Also use volume"},period:{selected:["4h"],text:""}});
  await card.getByRole("button",{name:"Submit answers"}).click();
  await expect.poll(()=>requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
  await page.screenshot({path:"/tmp/nerya-questions-desktop.png"});
  await page.setViewportSize({width:390,height:844});
  expect(await card.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await page.screenshot({path:"/tmp/nerya-questions-mobile.png"});
});
