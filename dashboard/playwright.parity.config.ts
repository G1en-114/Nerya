import { defineConfig } from "@playwright/test";

/** Isolated build/API address: never restart or send test requests to the user's service. */
export default defineConfig({
  testDir:"tests/ui", testMatch:["agent-parity.spec.ts","agent-parity-unit.spec.ts","composer-interactions.spec.ts","chat-history.spec.ts","strategy-editor.spec.ts","workflow-experience.spec.ts","agent-conversation.spec.ts"],
  timeout:45000, expect:{ timeout:12000 }, fullyParallel:false, workers:1, retries:0,
  outputDir:"test-results/agent-parity", reporter:[["list"],["json",{ outputFile:"test-results/agent-parity-results.json" }]],
  use:{ baseURL:"http://127.0.0.1:3151", headless:true, screenshot:"only-on-failure", trace:"retain-on-failure" },
  webServer:{ command:"../node_modules/.bin/next dev -p 3151", url:"http://127.0.0.1:3151", reuseExistingServer:false, timeout:180000,
    env:{ NERYA_API:"http://127.0.0.1:1", NERYA_E2E:"1", NERYA_E2E_MOCKED_UI:"1", NERYA_UI_DIST_DIR:".next-agent-parity", NERYA_UI_TSCONFIG:"tsconfig.agent-parity.json" } },
});
