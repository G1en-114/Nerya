import {defineConfig} from "@playwright/test";
export default defineConfig({
 testDir:"tests/ui",testMatch:"workbench-performance.spec.ts",workers:1,retries:0,timeout:60000,
 expect:{timeout:15000},outputDir:"test-results/workbench-production",reporter:[["list"],["json",{outputFile:"test-results/workbench-production.json"}]],
 use:{baseURL:"http://127.0.0.1:3153",headless:true,trace:"retain-on-failure"},
 webServer:{command:"../node_modules/.bin/next start -p 3153",url:"http://127.0.0.1:3153",reuseExistingServer:false,timeout:60000,
 env:{NERYA_API:"http://127.0.0.1:1",NERYA_UI_DIST_DIR:".next-workbench-release2",NERYA_UI_TSCONFIG:"tsconfig.workbench-build.json"}}
});
