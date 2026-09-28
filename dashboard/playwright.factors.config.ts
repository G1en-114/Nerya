import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir:"./tests/ui",testMatch:["factors.spec.ts","backtest-research.spec.ts"],timeout:90_000,expect:{timeout:25_000},workers:1,retries:0,
  reporter:[["list"]],outputDir:"./test-results/factor-ui-run",
  use:{baseURL:"http://127.0.0.1:3074",browserName:"chromium",viewport:{width:1440,height:1000},serviceWorkers:"block",screenshot:"only-on-failure",trace:"retain-on-failure"},
  webServer:[
    {command:`${process.env.NERYA_PYTHON || "../.venv/bin/python"} ../tools/factor_ui_test_server.py --port 18329 --root test-results`,url:"http://127.0.0.1:18329/health",timeout:120_000,reuseExistingServer:false,env:{NERYA_API_TOKEN:"isolated-factor-ui-test-token"}},
    {command:"npx --no-install next dev --hostname 127.0.0.1 --port 3074",url:"http://127.0.0.1:3074",timeout:120_000,reuseExistingServer:false,
      env:{NERYA_UI_DIST_DIR:".next-factor-tests",NERYA_UI_TSCONFIG:"tsconfig.factors.json",NERYA_API:"http://127.0.0.1:18329",NERYA_API_TOKEN:"isolated-factor-ui-test-token",NERYA_E2E:"1"}},
  ],
});
