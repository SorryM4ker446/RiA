import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { getE2ERun, removeE2EWorkspace } from "./tests/helpers/e2e-run";
import { TEST_ACCESS_TOKEN } from "./tests/helpers/workspace-entry";

export default (async () => {
  // Workers inherit the run; only the runner process that created it owns its workspace.
  const ownsRun = process.env.RIA_E2E_RUN_ID === undefined;
  const run = await getE2ERun();
  // The runner exits after the web server has stopped, so the database is closed by then.
  if (ownsRun) process.once("exit", () => removeE2EWorkspace(run.directory));
  // Two suites run only on demand, never in an ordinary or CI run: the
  // screenshot baseline (`npm run test:visual`), whose pixels depend on the
  // machine's fonts and graphics and so stay in a local, git-ignored folder;
  // and the performance baseline (`npm run test:perf`), which measures rather
  // than passes or fails on a shared runner's timing.
  const onDemand = process.env.RIA_ON_DEMAND;
  return defineConfig({
    testDir: "./tests/e2e",
    ...(onDemand === "visual" ? { grep: /@visual/, snapshotPathTemplate: "{testDir}/../../.visual-baseline/{arg}{ext}" }
      : onDemand === "perf" ? { grep: /@perf/ }
      : { grepInvert: /@visual|@perf/ }),
    outputDir: resolve(run.resultsDirectory, "artifacts"),
    reporter: [
      ["list"],
      ["html", { outputFolder: run.reportDirectory, open: "never" }],
      ["json", { outputFile: resolve(run.resultsDirectory, "results.json") }],    ],
    metadata: { runId: run.id, origin: run.origin },
    retries: 0,
    workers: process.env.CI ? 2 : undefined,
    timeout: 45_000,
    expect: {
      timeout: 10_000,
      toHaveScreenshot: { animations: "disabled", caret: "hide", maxDiffPixelRatio: 0.002 },
    },
    // Installs the access cookie for the suite that shares one web server.
    globalSetup: "./tests/e2e/global.setup.ts",
    use: {
      locale: "zh-CN",
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
