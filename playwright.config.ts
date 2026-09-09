import { defineConfig } from "@playwright/test";
const baseURL = process.env.BASE_URL || "http://127.0.0.1:5180";
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 2,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { baseURL, actionTimeout: 15_000 },
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: "npm run dev -- --host 127.0.0.1 --port 5180 --strictPort",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
