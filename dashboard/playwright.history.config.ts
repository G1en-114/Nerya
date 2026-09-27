import { defineConfig } from "@playwright/test";
import base from "./playwright.composer.config";

/** Requests are mocked in-browser; no real runtime or user records are changed. */
export default defineConfig({
  ...base,
  testMatch: ["chat-history.spec.ts", "composer-interactions.spec.ts"],
  outputDir: "./test-results/history-review",
});
