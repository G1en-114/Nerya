import {defineConfig} from "@playwright/test";
export default defineConfig({
 testDir:"tests/ui",testMatch:["workbench.spec.ts","agent-parity-unit.spec.ts","agent-parity.spec.ts","strategy-editor.spec.ts","workflow-experience.spec.ts"],workers:1,retries:0,timeout:45000,
 expect:{timeout:15000},outputDir:"test-results/workbench",reporter:[["list"],["json",{outputFile:"test-results/workbench-results.json"}]],
 use:{baseURL:"http://127.0.0.1:3152",headless:true,screenshot:"only-on-failure",trace:"retain-on-failure"},
 webServer:{command:"../node_modules/.bin/next dev -p 3152",url:"http://127.0.0.1:3152",reuseExistingServer:false,timeout:180000,
 env:{NERYA_API:"http://127.0.0.1:1",NERYA_E2E:"1",NERYA_E2E_MOCKED_UI:"1",NERYA_UI_DIST_DIR:".next-workbench",NERYA_UI_TSCONFIG:"tsconfig.workbench.json"}}
});
