import { test, expect, type Page } from "@playwright/test";

async function shell(page:Page,language="en",darkMode="dark"){
  // Authenticate the test browser itself. The production proxy correctly
  // refuses to turn a server-side fallback token into remote browser trust.
  await page.setExtraHTTPHeaders({Authorization:"Bearer isolated-factor-ui-test-token"});
  await page.addInitScript(({language,darkMode})=>localStorage.setItem("nerya.ui_settings.v1",JSON.stringify({language,darkMode})),{language,darkMode});
  // Factor and Skill requests reach the real isolated Python backend. Only
  // unrelated shell polling is stubbed: no models, wallets, orders or feeds.
  await page.route("**/api/**",async route=>{
    const path=new URL(route.request().url()).pathname.replace(/^\/api\/proxy/,"");
    if(path.startsWith("/factors/")||path.startsWith("/skills/")||path==="/workspace")return route.continue();
    let body:unknown={ok:true,items:[],count:0,total:0};
    if(path==="/auth/status")body={ok:true,local_access:true,password_configured:false};
    if(path==="/operator/nav")body={ok:true,data:{primary:[],advanced:[],hidden:[],capabilities:{}}};
    if(path==="/setup/readiness")body={status:"ok",data:{checks:[],blocking:[]}};
    if(path==="/agent/sessions")body={sessions:[],has_more:false};
    if(path==="/agent/stream/events")body={events:[],cursor:0,latest_seq:0};
    if(path==="/accounts/list")body={accounts:[],ts:0};
    if(path==="/operator/overview")body={status:"ok",data:{attention:[],counts:{},accounts:[],strategies:[]}};
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(body)});
  });
}

test("create, evaluate, export and edit through real isolated API",async({page})=>{
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));await shell(page);
  await page.goto("/factors");await expect(page.getByRole("heading",{name:"Factor library",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Add factor",exact:true}).click();
  const dialog=page.getByRole("dialog");await dialog.getByLabel("Name",{exact:true}).fill("Synthetic UI momentum");
  await dialog.getByLabel("Factor ID").fill("ui.momentum");
  await dialog.getByLabel("Factor expression").fill("close / delay(close,n) - 1");
  await dialog.getByLabel("Numeric parameters").fill('{"n":10}');
  await dialog.getByLabel("Research hypothesis").fill("Synthetic regression fixture — not market research or alpha evidence.");
  await dialog.getByLabel("Change reason").fill("UI regression");await dialog.getByRole("button",{name:"Save factor",exact:true}).click();
  await expect(dialog).not.toBeVisible();await expect(page.getByRole("heading",{name:"Synthetic UI momentum"})).toBeVisible();
  await page.getByRole("tab",{name:"Run diagnostics"}).click();
  await page.getByLabel("Reuse a local data window").selectOption("0");
  await page.getByLabel("Actual instrument type").selectOption("perpetual");
  await page.getByRole("button",{name:"Run local diagnostics",exact:true}).click();
  await expect(page.getByTestId("factor-evidence")).toBeVisible();
  await expect(page.getByText("Calculated · research",{exact:true})).toBeVisible();
  await expect(page.getByText(/Funding, liquidation and mark-price effects are excluded/)).toBeVisible();
  await expect(page.getByText("After fee/slippage · bps",{exact:true})).toBeVisible();
  await page.screenshot({path:"test-results/factor-evidence-desktop.png",fullPage:true});
  const download=page.waitForEvent("download");await page.getByRole("button",{name:"Export pinned version"}).click();
  expect((await download).suggestedFilename()).toBe("ui.momentum.v1.factors.json");
  await page.getByRole("button",{name:"Edit",exact:true}).click();
  await dialog.getByLabel("Numeric parameters").fill('{"n":20}');await dialog.getByLabel("Change reason").fill("Test new version");
  await dialog.getByRole("button",{name:"Save factor",exact:true}).click();await expect(dialog).not.toBeVisible();
  await expect(page.getByLabel("Select version")).toHaveValue("2");
  await page.getByRole("tab",{name:/Evidence/}).click();await expect(page.getByText("No evidence for this version",{exact:true})).toBeVisible();
  await page.getByLabel("Select version").selectOption("1");await expect(page.getByTestId("factor-evidence")).toBeVisible();
  expect(errors).toEqual([]);
});

test("Chinese mobile layout and blocked historical window",async({page,request})=>{
  const seeded=await request.post("http://127.0.0.1:18329/factors/save",{headers:{Authorization:"Bearer isolated-factor-ui-test-token"},data:{action:"save",definition:{factor_id:"ui.mobile",name:"Synthetic mobile fixture",expression:"close / delay(close,n) - 1",parameters:{n:10}},expected_version:0,reason:"Independent mobile UI regression"}});
  expect((await seeded.json()).ok).toBe(true);
  await page.setViewportSize({width:390,height:844});await shell(page,"zh","light");
  await page.goto("/factors?id=ui.mobile&version=1");await expect(page.getByRole("heading",{name:"因子库",exact:true})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Synthetic mobile fixture"})).toBeVisible();
  await page.getByRole("tab",{name:"验证因子",exact:true}).click();await page.getByLabel("复用本地数据窗口").selectOption("0");
  await page.getByLabel("实际市场类型").selectOption("spot");await page.getByLabel("开始 UTC（包含）").fill("2023-12-31T00:00:00Z");
  await page.getByRole("button",{name:"运行本地验证",exact:true}).click();await expect(page.getByText(/24 missing bars/)).toBeVisible();
  // The failure is immediately visible in retained evidence without a manual
  // refresh; no completed badge or fabricated IC is shown.
  await expect(page.getByTestId("factor-evidence")).toBeVisible();
  await expect(page.getByText("已计算 · 研究诊断",{exact:true})).toHaveCount(0);
  await expect(page.getByText("blocked",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  await page.screenshot({path:"test-results/factor-evidence-mobile.png",fullPage:true});
});

test("invalid formula is rejected by the backend without closing the editor",async({page})=>{
  await shell(page);await page.goto("/factors");await page.getByRole("button",{name:"Add factor",exact:true}).click();
  const dialog=page.getByRole("dialog");await dialog.getByLabel("Name",{exact:true}).fill("Invalid future factor");
  await dialog.getByLabel("Factor ID").fill("ui.invalid");await dialog.getByLabel("Factor expression").fill("delay(close,-1)");
  await dialog.getByLabel("Change reason").fill("Invalid formula regression");await dialog.getByRole("button",{name:"Save factor",exact:true}).click();
  await expect(dialog.getByText(/future shifts are forbidden/)).toBeVisible();await expect(dialog).toBeVisible();
});
