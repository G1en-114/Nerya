import { defineConfig } from "@playwright/test";
import { createRequire } from "node:module";
import ui from "./playwright.ui.config";

const projectRequire = createRequire(`${process.cwd()}/package.json`);
const nextCli = projectRequire.resolve("next/dist/bin/next");

/** Isolated server lifecycle; all API requests are mocked by the setup spec. */
export default defineConfig({
  ...ui,
  testMatch: "setup-onboarding.spec.ts",
  outputDir: "./test-results/setup-review-20260922",
  use: { ...ui.use, baseURL: "http://127.0.0.1:3116" },
  webServer: {
    command: `"${process.execPath}" "${nextCli}" dev --hostname 127.0.0.1 --port 3116`,
    url: "http://127.0.0.1:3116/setup",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NERYA_UI_DIST_DIR: ".next-setup-review",
      NERYA_UI_TSCONFIG: "tsconfig.setup-review.json",
      NERYA_E2E: "1",
    },
  },
});
