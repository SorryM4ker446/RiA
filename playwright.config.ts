import { defineConfig, devices } from "@playwright/test";

const e2ePort = 3100;
const e2eRunId = `playwright-${process.pid}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${e2ePort}`,
    trace: "on-first-retry",
  },
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${e2ePort}`,
    url: `http://127.0.0.1:${e2ePort}/chat`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      APP_RUNTIME: "test",
      LOCAL_DATABASE_FILE: `.desktop-data/test/${e2eRunId}/app.db`,
      TAVILY_API_KEY: process.env.TAVILY_API_KEY || "test-tavily-key",
      TAVILY_SEARCH_URL: process.env.TAVILY_SEARCH_URL || "http://127.0.0.1:4010/search",
      AUTH_DISABLED: "1",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
