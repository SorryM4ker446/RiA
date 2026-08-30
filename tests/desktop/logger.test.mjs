import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { finished } from "node:stream/promises";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { createDesktopLogger, createDesktopLogSink } = require("../../electron-dist/logger.js");
function temporaryLog(t) {
  const root = mkdtempSync(join(tmpdir(), "private-ai-log-"));
  t.after(() => {
    if (resolve(dirname(root)) !== resolve(tmpdir())) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  });
  return { root, path: join(root, "desktop.log") };
}

test("desktop logs bound active and archived files including oversized legacy logs", (t) => {
  const { root, path } = temporaryLog(t);
  writeFileSync(path, "legacy".repeat(1000));
  const logger = createDesktopLogger(path, { maxBytes: 256, backupCount: 2 });
  for (let index = 0; index < 40; index += 1) logger.info(`message ${index}`, "x".repeat(80));
  assert.deepEqual(readdirSync(root).sort(), ["desktop.log", "desktop.log.1", "desktop.log.2"]);
  for (const file of readdirSync(root)) assert.ok(statSync(join(root, file)).size <= 256);
  assert.match(readFileSync(path, "utf8"), /message 39/);
  logger.info("x".repeat(2000));
  assert.ok(statSync(path).size <= 256);
  assert.match(readFileSync(path, "utf8"), /oversized log entry omitted/);
});

test("child output is decoded and redacted across chunks before log rotation", async (t) => {
  const { path } = temporaryLog(t);
  const sink = createDesktopLogSink(createDesktopLogger(path), "Next stdout");
  sink.write(Buffer.from('OPENROUTER_API_'));
  sink.write(Buffer.from('KEY="synthetic-private-value"\nAuthorization: Bearer synthetic-bearer\n'));
  sink.write(Buffer.from("{ password: 'synthetic-password', cookie: 'session=synthetic-cookie' }\n"));
  sink.write(Buffer.from("https://sample:synthetic-proxy@localhost/path\npostgresql://sample:synthetic-database@localhost/db\n"));
  const utf8 = Buffer.from("中文输出\n");
  sink.write(utf8.subarray(0, 1));
  sink.end(utf8.subarray(1));
  await finished(sink);
  const log = readFileSync(path, "utf8");
  for (const secret of ["synthetic-private-value", "synthetic-bearer", "synthetic-password", "synthetic-cookie", "synthetic-proxy", "synthetic-database"]) assert.ok(!log.includes(secret));
  assert.match(log, /中文输出/);
  assert.match(log, /redacted/);
});

test("oversized child lines are discarded until the next line without leaking their tails", async (t) => {
  const { path } = temporaryLog(t);
  const sink = createDesktopLogSink(createDesktopLogger(path), "Next stderr");
  sink.write("x".repeat(20_000));
  sink.write("discard-this-tail\n");
  sink.end("normal final line");
  await finished(sink);
  const log = readFileSync(path, "utf8");
  assert.match(log, /oversized log line omitted/);
  assert.ok(!log.includes("discard-this-tail"));
  assert.match(log, /normal final line/);
  assert.doesNotThrow(() => createDesktopLogger(join(path, "missing", "log")).error("Unwritable destination"));
});
