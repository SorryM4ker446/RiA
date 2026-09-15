import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const e2ePort = 3100;
// Shared by every process that loads this configuration: each worker start-up
// and the web server command.
const e2eRunId = "playwright-run";
const e2eDatabaseDirectory = `.desktop-data/test/${e2eRunId}`;
// The workspace has no login. The browser suite presents this credential
// directly, and the web server is started with the same value.
const pinnedAccessToken = "00000000000000000000000000000000feedface";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  // Installs the access cookie for the suite that shares one web server.
  globalSetup: "./tests/e2e/global.setup.ts",
  use: {
    // The application resolves its own origin as `localhost`, so the suite uses
    // that name too; a cookie stored for `127.0.0.1` would never be sent.
    baseURL: `http://localhost:${e2ePort}`,
    storageState: resolve(".desktop-data/test/playwright-storage-state.json"),
    trace: "on-first-retry",
  },
  webServer: {
    // Development hot reloads can reset a page while other tests compile routes.
    command: "npm run build && node scripts/prepare-desktop.mjs && node scripts/run-with-local-db.mjs --migrate node .desktop-runtime/server.js",
    url: `http://localhost:${e2ePort}/chat`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      ...process.env,
      APP_RUNTIME: "test",
      APP_ORIGIN: "",
      HOSTNAME: "127.0.0.1",
      PORT: String(e2ePort),
      LOCAL_DATABASE_FILE: `${e2eDatabaseDirectory}/app.db`,
      MEDIA_DIRECTORY: resolve(`${e2eDatabaseDirectory}/media`),
      LEGACY_VIDEO_DIRECTORY: resolve(`${e2eDatabaseDirectory}/legacy-videos`),
      LOCAL_ACCESS_TOKEN: pinnedAccessToken,
      OPENROUTER_API_KEY: "",
      TAVILY_API_KEY: "test-tavily-key",
      TAVILY_SEARCH_URL: "http://127.0.0.1:4010/search",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
