import {defineConfig} from "@playwright/test";
export default defineConfig({
  testDir:"tests/ui",testMatch:["agent-output-rendering.spec.ts"],workers:1,retries:0,timeout:60000,
  expect:{timeout:15000},outputDir:"test-results/agent-output-rendering",reporter:[["list"],["json",{outputFile:"test-results/agent-output-rendering-results.json"}]],
  use:{baseURL:"http://127.0.0.1:3167",headless:true,screenshot:"only-on-failure",trace:"retain-on-failure"},
  webServer:{command:"../node_modules/.bin/next dev -p 3167",url:"http://127.0.0.1:3167",reuseExistingServer:false,timeout:180000,
    env:{NERYA_API:"http://127.0.0.1:1",NERYA_E2E:"1",NERYA_E2E_MOCKED_UI:"1",NERYA_UI_DIST_DIR:".next-rendering-review",NERYA_UI_TSCONFIG:"tsconfig.rendering-review.json"}},
});
