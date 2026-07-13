import { defineConfig } from "@playwright/test";

const port = 4173;
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  outputDir: "../../output/playwright",
  use: {
    baseURL,
    browserName: "chromium",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun run e2e/server.ts",
    url: `${baseURL}/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
