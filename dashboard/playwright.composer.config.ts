import { defineConfig } from "@playwright/test";
import base from "./playwright.ui.config";

/** Fully isolated composer regression. Requests are intercepted by the specs. */
export default defineConfig({
  ...base,
  testMatch: ["composer-interactions.spec.ts", "usability.spec.ts"],
  outputDir: "./test-results/composer-review",
  use: { ...base.use, baseURL: "http://127.0.0.1:3147" },
  webServer: {
    command: `node ${JSON.stringify(require.resolve("next/dist/bin/next"))} dev --hostname 127.0.0.1 --port 3147`,
    url: "http://127.0.0.1:3147",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { NERYA_UI_DIST_DIR: ".next-composer-review", NERYA_UI_TSCONFIG: "tsconfig.composer-review.json", NERYA_E2E: "1" },
  },
});
