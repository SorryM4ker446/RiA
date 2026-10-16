import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { getE2ERun } from "../helpers/e2e-run";
import { createTempDirectory } from "../helpers/temp-directory";

test("browser workers inherit one run while independent runs have separate state and artifacts", async () => {
  const environment: Partial<NodeJS.ProcessEnv> = {};
  const first = await getE2ERun(environment);
  assert.deepEqual(await getE2ERun({ ...environment }), first);
  const second = await getE2ERun({});
  assert.notEqual(second.id, first.id);
  for (const field of ["directory", "storageState", "resultsDirectory", "reportDirectory"] as const) {
    assert.notEqual(second[field], first[field]);
  }
  assert.equal(new URL(first.origin).hostname, "localhost");
  assert.equal(new URL(first.origin).port, String(first.port));
});

test("invalid inherited browser identities cannot redirect test data outside the test directory", async () => {
  for (const environment of [
    { RIA_E2E_RUN_ID: "../../dev", RIA_E2E_PORT: "3100" },
    { RIA_E2E_RUN_ID: `e2e-${"a".repeat(36)}`, RIA_E2E_PORT: "0" },
    { RIA_E2E_RUN_ID: `e2e-${"a".repeat(36)}`, RIA_E2E_PORT: "65536" },
    { RIA_E2E_RUN_ID: `e2e-${"a".repeat(36)}`, RIA_E2E_PORT: "3100junk" },
    { RIA_E2E_PORT: "3100" },
  ]) await assert.rejects(getE2ERun(environment), /Invalid E2E run/);
});

test("browser report configuration excludes inherited environment secrets", async () => {
  const previous = process.env.RIA_REPORT_PRIVACY_PROBE;
  process.env.RIA_REPORT_PRIVACY_PROBE = "synthetic-private-value";
  try {
    const configuration = await (await import("../../playwright.config.ts")).default;
    assert.ok(configuration.webServer && !Array.isArray(configuration.webServer));
    assert.equal("RIA_REPORT_PRIVACY_PROBE" in configuration.webServer.env, false);
    assert.equal(configuration.webServer.env.OPENROUTER_API_KEY, "");
    assert.equal(configuration.webServer.env.DEEPSEEK_API_KEY, "");
    assert.ok(!JSON.stringify(configuration).includes("synthetic-private-value"));
  } finally {
    if (previous === undefined) delete process.env.RIA_REPORT_PRIVACY_PROBE;
    else process.env.RIA_REPORT_PRIVACY_PROBE = previous;
  }
});

function schemaFixture(root: string, migration = "CREATE TABLE fixture (id INTEGER PRIMARY KEY);") {
  for (const directory of ["scripts", "src/db/migrations/001", "node_modules/prisma/build", "temp"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeFileSync(join(root, "scripts/check-schema-drift.mjs"), readFileSync("scripts/check-schema-drift.mjs"));
  writeFileSync(join(root, "src/db/schema.prisma"), "fixture schema");
  writeFileSync(join(root, "src/db/migrations/001/migration.sql"), migration);
  writeFileSync(join(root, "node_modules/prisma/build/index.js"), `
    const fs = require('node:fs');
    const path = require('node:path');
    const { fileURLToPath } = require('node:url');
    const { DatabaseSync } = require('node:sqlite');
    const file = fileURLToPath(process.argv[process.argv.indexOf('--from-url') + 1]);
    const db = new DatabaseSync(file, { readOnly: true });
    db.prepare('SELECT * FROM fixture').all();
    db.close();
    fs.appendFileSync(path.join(process.cwd(), 'observed.jsonl'), JSON.stringify(file) + '\\n');
    const timer = setInterval(() => {
      if (fs.existsSync(path.join(process.cwd(), 'release'))) clearInterval(timer);
    }, 20);
    setTimeout(() => { clearInterval(timer); process.exitCode = 1; }, 10000).unref();
  `);
}

function runSchemaCheck(root: string) {
  const child = spawn(process.execPath, [join(root, "scripts/check-schema-drift.mjs")], {
    cwd: root, windowsHide: true,
    env: { ...process.env, TEMP: join(root, "temp"), TMP: join(root, "temp"), TMPDIR: join(root, "temp") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const completed = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolve({ code, output }));
  });
  return { child, completed };
}

test("concurrent schema checks own distinct databases outside the checkout and clean them after success", { timeout: 20_000 }, async () => {
  const { root, remove } = createTempDirectory("ria-schema-isolation-");
  schemaFixture(root);
  const runs = [runSchemaCheck(root), runSchemaCheck(root)];
  try {
    const deadline = Date.now() + 10_000;
    let files: string[] = [];
    while (Date.now() < deadline) {
      if (existsSync(join(root, "observed.jsonl"))) {
        files = readFileSync(join(root, "observed.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
        if (files.length === 2) break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(files.length, 2, "both comparisons must reach their independent databases");
    assert.notEqual(files[0], files[1]);
    assert.ok(files.every(file => dirname(dirname(resolve(file))) === resolve(root, "temp")));
    assert.equal(existsSync(join(root, ".drift-check")), false);
    writeFileSync(join(root, "release"), "");
    for (const result of await Promise.all(runs.map(run => run.completed))) assert.equal(result.code, 0, result.output);
    assert.deepEqual(readdirSync(join(root, "temp")), []);
  } finally {
    writeFileSync(join(root, "release"), "");
    await Promise.allSettled(runs.map(run => run.completed));
    remove();
  }
});

test("a failed schema migration closes its database and removes only its own temporary directory", async () => {
  const { root, remove } = createTempDirectory("ria-schema-failure-");
  try {
    schemaFixture(root, "INVALID MIGRATION;");
    writeFileSync(join(root, "temp/retain.txt"), "unrelated");
    const result = await runSchemaCheck(root).completed;
    assert.notEqual(result.code, 0);
    assert.match(result.output, /syntax error/);
    assert.deepEqual(readdirSync(join(root, "temp")), ["retain.txt"]);
  } finally { remove(); }
});
