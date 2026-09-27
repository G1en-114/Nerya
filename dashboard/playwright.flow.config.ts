import {defineConfig} from "@playwright/test";
export default defineConfig({
 testDir:"tests/ui",testMatch:["conversation-flow.spec.ts","agent-parity-unit.spec.ts","agent-parity.spec.ts","workbench.spec.ts"],workers:1,retries:0,timeout:45000,
 expect:{timeout:15000},outputDir:"test-results/conversation-flow",reporter:[["list"],["json",{outputFile:"test-results/conversation-flow-results.json"}]],
 use:{baseURL:"http://127.0.0.1:3155",headless:true,screenshot:"only-on-failure",trace:"retain-on-failure"},
 webServer:{command:"../node_modules/.bin/next dev -p 3155",url:"http://127.0.0.1:3155",reuseExistingServer:false,timeout:180000,
 env:{NERYA_API:"http://127.0.0.1:1",NERYA_E2E:"1",NERYA_E2E_MOCKED_UI:"1",NERYA_UI_DIST_DIR:".next-conversation-flow",NERYA_UI_TSCONFIG:"tsconfig.conversation-flow.json"}}
});
