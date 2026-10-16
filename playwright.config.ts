import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { getE2ERun } from "./tests/helpers/e2e-run";
import { TEST_ACCESS_TOKEN } from "./tests/helpers/workspace-entry";

export default (async () => {
  const run = await getE2ERun();
  return defineConfig({
    testDir: "./tests/e2e",
    outputDir: resolve(run.resultsDirectory, "artifacts"),
    reporter: [
      ["list"],
      ["html", { outputFolder: run.reportDirectory, open: "never" }],
      ["json", { outputFile: resolve(run.resultsDirectory, "results.json") }],
    ],
    metadata: { runId: run.id, origin: run.origin },
    retries: 0,
    timeout: 45_000,
    expect: {
      timeout: 10_000,
    },
    // Installs the access cookie for the suite that shares one web server.
    globalSetup: "./tests/e2e/global.setup.ts",
    use: {
      // The application resolves its own origin as `localhost`, so the suite uses
      // that name too; a cookie stored for `127.0.0.1` would never be sent.
      baseURL: run.origin,
      storageState: run.storageState,
      trace: "retain-on-failure",
      screenshot: "only-on-failure",
    },
    webServer: {
      // Development hot reloads can reset a page while other tests compile routes.
      command: "npm run build && node scripts/prepare-desktop.mjs && node scripts/run-with-local-db.mjs --migrate node .desktop-runtime/server.js",
      url: `${run.origin}/chat`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        // Playwright inherits the process environment itself. Only explicit
        // test overrides belong here: the JSON reporter serializes this object.
        APP_RUNTIME: "test",
        APP_ORIGIN: "",
        HOSTNAME: "127.0.0.1",
        PORT: String(run.port),
        LOCAL_DATABASE_FILE: resolve(run.directory, "app.db"),
        MEDIA_DIRECTORY: resolve(run.directory, "media"),
        LEGACY_VIDEO_DIRECTORY: resolve(run.directory, "legacy-videos"),
        LOCAL_ACCESS_TOKEN: TEST_ACCESS_TOKEN,
        OPENROUTER_API_KEY: "",
        DEEPSEEK_API_KEY: "",
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
})();
