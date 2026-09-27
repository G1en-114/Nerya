import {defineConfig} from "@playwright/test";
export default defineConfig({
 testDir:"tests/ui",testMatch:["workbench-layout.spec.ts","agent-parity.spec.ts","workbench.spec.ts"],workers:1,retries:0,timeout:45000,
 expect:{timeout:15000},outputDir:"test-results/zcode-layout",reporter:[["list"],["json",{outputFile:"test-results/zcode-layout-results.json"}]],
 use:{baseURL:"http://127.0.0.1:3154",headless:true,screenshot:"only-on-failure",trace:"retain-on-failure"},
 webServer:{command:"../node_modules/.bin/next dev -p 3154",url:"http://127.0.0.1:3154",reuseExistingServer:false,timeout:180000,
 env:{NERYA_API:"http://127.0.0.1:1",NERYA_E2E:"1",NERYA_E2E_MOCKED_UI:"1",NERYA_UI_DIST_DIR:".next-zcode-layout",NERYA_UI_TSCONFIG:"tsconfig.zcode-layout.json"}}
});
