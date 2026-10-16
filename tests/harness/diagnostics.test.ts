import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import JSZip from "jszip";
import playwrightConfig from "../../playwright.config.ts";
import { createTempDirectory } from "../helpers/temp-directory";

test("a first browser failure preserves a trace, screenshot and reports without retrying", { timeout: 45_000 }, async () => {
  const configuration = await playwrightConfig;
  const { root, remove } = createTempDirectory("ria-browser-diagnostics-");
  try {
    assert.equal(configuration.retries, 0);
    assert.ok(Array.isArray(configuration.reporter));
    const jsonFile = join(root, "results.json");
    const htmlDirectory = join(root, "report");
    const config = {
      testDir: root, outputDir: join(root, "artifacts"), workers: 1,
      timeout: 10_000, expect: { timeout: 100 }, retries: configuration.retries,
      reporter: configuration.reporter.map(reporter => reporter[0] === "html"
        ? ["html", { outputFolder: htmlDirectory, open: "never" }]
        : reporter[0] === "json" ? ["json", { outputFile: jsonFile }] : ["line"]),
      use: { trace: configuration.use.trace, screenshot: configuration.use.screenshot, headless: true },
    };
    writeFileSync(join(root, "playwright.config.cjs"), `module.exports = ${JSON.stringify(config)};`);
    const serverEntry = join(root, "fixture-server.cjs");
    writeFileSync(serverEntry, `
      console.log('API_KEY=sk-diagnostics-fixture');
      console.log('isolated fixture server ready');
      require('node:http').createServer((request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok' }));
      }).listen(Number(process.env.PORT), '127.0.0.1');
    `);
    writeFileSync(join(root, "failure.spec.cjs"), `
      const { test: base, expect } = require(${JSON.stringify(resolve("node_modules/@playwright/test"))});
      const { startStandaloneServer } = require(${JSON.stringify(resolve("tests/helpers/standalone-server.ts"))});
      const test = base.extend({
        app: async ({}, use) => {
          const app = await startStandaloneServer({ serverEntry: ${JSON.stringify(serverEntry)} });
          try { await use(app); } finally { await app.close(); }
        }
      });
      test('first failure artifact probe', async ({ page }) => {
        await page.setContent('<h1>diagnostic target</h1>');
        await expect(page.locator('h1')).toHaveText('intentional mismatch');
      });
      test.beforeEach(async ({ app }) => { expect(app.origin).toContain('localhost'); });
    `);
    const result = spawnSync(process.execPath, [resolve("node_modules/playwright/cli.js"), "test", "--config", join(root, "playwright.config.cjs")], {
      cwd: resolve("."), windowsHide: true, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PLAYWRIGHT_HTML_OPEN: "never" },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(readFileSync(jsonFile, "utf8"));
    assert.equal(report.stats.unexpected, 1);
    assert.equal(report.stats.flaky, 0);
    const results = report.suites[0].specs[0].tests[0].results;
    assert.equal(results.length, 1, "a failed first attempt must not depend on a retry");
    const attachments = results[0].attachments;
    const trace = attachments.find(attachment => attachment.name === "trace");
    const screenshot = attachments.find(attachment => attachment.contentType === "image/png");
    assert.ok(trace?.path, "the failure must retain its trace");
    assert.ok(screenshot?.path, "the failure must retain its screenshot");
    const zip = await JSZip.loadAsync(readFileSync(trace.path));
    const traceFiles = Object.values(zip.files).filter(file => file.name.endsWith(".trace"));
    assert.ok(traceFiles.length > 0);
    const recorded = await Promise.all(traceFiles.map(file => file.async("string")));
    assert.ok(recorded.some(text => text.includes("diagnostic target")));
    assert.equal(readFileSync(screenshot.path).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    const serverLog = attachments.find(attachment => attachment.name === "standalone-server-log");
    assert.ok(serverLog?.path, "failed fixture teardown must preserve its server log before cleanup");
    const log = readFileSync(serverLog.path, "utf8");
    assert.match(log, /isolated fixture server ready/);
    assert.match(log, /\[redacted\]/);
    assert.ok(!log.includes("sk-diagnostics-fixture"));
    assert.ok(existsSync(join(htmlDirectory, "index.html")));
  } finally { remove(); }
});
