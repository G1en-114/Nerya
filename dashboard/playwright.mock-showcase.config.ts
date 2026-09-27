import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/ui",
  testMatch: "mock-showcase.spec.ts",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "./test-results/mock-showcase-run",
  use: {
    baseURL: "http://127.0.0.1:3061",
    browserName: "chromium",
    viewport: { width: 1500, height: 1000 },
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "npx --no-install next dev --hostname 127.0.0.1 --port 3061",
    url: "http://127.0.0.1:3061",
    timeout: 120_000,
    reuseExistingServer: false,
    env: { NERYA_UI_DIST_DIR: ".next-mock-showcase", NERYA_UI_TSCONFIG: "tsconfig.mock-showcase.json", NERYA_API: "http://127.0.0.1:1", NERYA_E2E: "1" }
  }
});
