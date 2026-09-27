import { defineConfig } from "@playwright/test";
import base from "./playwright.ui.config";

export default defineConfig({
  ...base,
  testMatch: "workflow-experience.spec.ts",
  timeout: 60_000,
  outputDir: "./test-results/workflow-replay",
  use: { ...base.use, baseURL: "http://127.0.0.1:3059" },
  webServer: {
    command: "npx --no-install next dev --hostname 127.0.0.1 --port 3059",
    url: "http://127.0.0.1:3059",
    timeout: 90_000,
    reuseExistingServer: false,
    env: { NERYA_UI_DIST_DIR: ".next-workflow-replay", NERYA_UI_TSCONFIG: "tsconfig.replay.json", NERYA_API: "http://127.0.0.1:1", NERYA_E2E: "1" },
  },
});
