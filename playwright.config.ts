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
    // Development hot reloads can reset a page while other tests compile routes.
    command: "npm run build && node scripts/prepare-desktop.mjs && node scripts/run-with-local-db.mjs --migrate node .desktop-runtime/server.js",
    url: `http://127.0.0.1:${e2ePort}/chat`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      ...process.env,
      APP_RUNTIME: "test",
      HOSTNAME: "127.0.0.1",
      PORT: String(e2ePort),
      LOCAL_DATABASE_FILE: `.desktop-data/test/${e2eRunId}/app.db`,
      OPENROUTER_API_KEY: "",
      TAVILY_API_KEY: "test-tavily-key",
      TAVILY_SEARCH_URL: "http://127.0.0.1:4010/search",
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
