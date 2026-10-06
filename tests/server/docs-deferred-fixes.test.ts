import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import { existsSync } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDatabase } from "../helpers/database";
import { testPng } from "../helpers/model-provider";

const cleanup = createTestDatabase();
const { db } = await import("@/db");

const storage = await import("@/lib/media/storage");
const archive = await import("@/lib/backups/archive");
const backupFiles = await import("@/lib/backups/files");
const { restoreAccountBackup } = await import("@/lib/backups/restore");
const { exclusiveDataOperation } = await import("@/lib/server/data-operations");
const { recordStep, updateStep, startRun, finishRun } = await import("@/lib/agent/runs");
const imports = await import("@/lib/backups/imports");

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOUR = 60 * 60 * 1000;

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  for (const file of await backupFiles.listBackupFiles()) await backupFiles.removeBackupFile(file.id, file.extension);
  await db.message.deleteMany({});
  await db.messageMedia.deleteMany({});
  await db.chat.deleteMany({});
  await db.mediaGenerationInput.deleteMany({});
  await db.mediaAsset.deleteMany({});
  await db.agentStep.deleteMany({});
  await db.agentRun.deleteMany({});
  await db.modelRequest.deleteMany({});
});

after(async () => {
  await db.$disconnect();
  cleanup();
});

// --- the execution record the documentation describes ------------------------

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

test("the step record carries no artifact column, in code or in the schema", async (t: TestContext) => {
  t.mock.method(console, "info", () => {});
  // The column was dropped rather than left reserved: it was planned for a chat
  // tool that produces a file, no such tool exists, and a field that is always
  // null is worse than an absent one because nobody can tell from the record
  // that it is dead. This asserts the drop in every place it could come back —
  // the code, the schema, and the migrations that would rebuild the table.
  const survivors: string[] = [];
  const inspect = async (label: string, text: string) => {
    if (/\bartifactAssetId\b/.test(text)) survivors.push(label);
  };
  for (const file of await sourceFiles(join(repositoryRoot, "src"))) await inspect(file, await readFile(file, "utf8"));
  await inspect("schema.prisma", await readFile(join(repositoryRoot, "src", "db", "schema.prisma"), "utf8"));
  // The two migrations that mention it are the one that added the column and
  // the one that drops it. A migration is a record of what an installation did,
  // so neither is rewritten; everything else must be silent about the column.
  const allowedMigrations = new Set([
    "20260929110000_agent_runs",
    "20260930100000_agent_step_drop_artifact_asset_id",
  ]);
  const migrationsRoot = join(repositoryRoot, "src", "db", "migrations");
  for (const name of await readdir(migrationsRoot, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const file = join(migrationsRoot, name.name, "migration.sql");
    if (!existsSync(file) || allowedMigrations.has(name.name)) continue;
    await inspect(file, await readFile(file, "utf8"));
  }
  assert.deepEqual(survivors, [], "only the migration that added the column and the one that drops it may name it");

  // And a step still records and settles exactly the way the catalog settles it.
  const run = await startRun({ chatId: null, goal: "archive" });
  const step = await recordStep({ runId: run.id, position: 1, kind: "tool", toolName: "createTask", input: { title: "整理" } });
  await updateStep(step.id, { state: "done", output: { taskId: "t1" } });
  await finishRun(run.id, "succeeded");
  const settled = await db.agentStep.findUniqueOrThrow({ where: { id: step.id } });
  assert.equal(settled.state, "done");
  assert.deepEqual(settled.output, { taskId: "t1" });
  assert.equal("artifactAssetId" in settled, false, "the stored step has no artifact column at all");
});

test("the tools readiness document no longer promises a step artifact", async () => {
  const document = await readFile(join(repositoryRoot, "docs", "TOOLS_READINESS.md"), "utf8");
  const row = document.split("\n").find((line) => line.startsWith("| Common | Execution records"));
  assert.ok(row, "the execution-record row is still present");
  // It has to describe the fields a step really holds, and it must not claim
  // the artifact the application cannot produce.
  for (const field of ["kind", "tool name", "state", "error code", "summary"]) {
    assert.ok(row.includes(field), `the row still describes ${field}`);
  }
  assert.ok(!/\band artifacts\b/.test(row), "the row no longer claims artifacts");
});

// --- restore keeps the archived last-used stamp ------------------------------

test("a restored media asset keeps the archived lastUsedAt, not the restore time", async () => {
  const chat = await db.chat.create({ data: { title: "Stamp source" } });
  const asset = await storage.createMediaAsset({ bytes: testPng, mediaType: "image/png", kind: "attachment" });
  await db.message.create({ data: { chatId: chat.id, role: "user", content: "attached" } });
  const message = await db.message.findFirstOrThrow({ where: { chatId: chat.id } });
  await db.messageMedia.create({ data: { messageId: message.id, assetId: asset.id } });
  // An asset last used weeks ago. The manifest carries this value, and the
  // createdAt next to it in the same row is already restored faithfully.
  const archived = new Date(Date.now() - 21 * 24 * HOUR);
  const archivedCreatedAt = new Date(Date.now() - 30 * 24 * HOUR);
  await db.mediaAsset.update({ where: { id: asset.id }, data: { createdAt: archivedCreatedAt, lastUsedAt: archived } });

  const backup = await exclusiveDataOperation(() => archive.createAccountBackup(false));
  const before = new Date(archived);
  await db.mediaAsset.update({ where: { id: asset.id }, data: { lastUsedAt: new Date() } });
  await db.chat.update({ where: { id: chat.id }, data: { title: "Changed since backup" } });

  assert.equal((await exclusiveDataOperation(() => restoreAccountBackup(backup.id))).restored, true);

  const restored = await db.mediaAsset.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  // Restore replaces the workspace, so the identity changes; the archived
  // timestamps are what has to survive the round trip.
  assert.notEqual(restored.id, asset.id, "the restore issued a new asset id");
  assert.equal(restored.createdAt.getTime(), archivedCreatedAt.getTime(), "createdAt is restored faithfully");
  assert.equal(restored.lastUsedAt.getTime(), before.getTime(), "lastUsedAt is the archived value, not the restore time");
  // The reference comes back with it, so the reclaim predicate that only
  // counts unreferenced assets cannot select it.
  assert.equal((await db.messageMedia.count({ where: { assetId: restored.id } })), 1);
});

test("an unreferenced asset is still protected by the reference, not by its stamp", async () => {
  const chat = await db.chat.create({ data: { title: "Unreferenced source" } });
  const asset = await storage.createMediaAsset({ bytes: testPng, mediaType: "image/png", kind: "attachment" });
  const archived = new Date(Date.now() - 40 * 24 * HOUR);
  await db.mediaAsset.update({ where: { id: asset.id }, data: { lastUsedAt: archived } });

  const backup = await exclusiveDataOperation(() => archive.createAccountBackup(false));
  assert.equal((await exclusiveDataOperation(() => restoreAccountBackup(backup.id))).restored, true);

  const restored = await db.mediaAsset.findFirstOrThrow();
  assert.equal(restored.lastUsedAt.getTime(), archived.getTime(), "an unreferenced asset is restored with its archived stamp too");
  // It is older than the 24h grace and unreferenced, so the app's own cleanup
  // rules classify it as reclaimable — in the restored workspace exactly as it
  // was in the workspace the archive came from. Restoring the value reproduces
  // the archived state; it does not make anything newly reclaimable.
  assert.equal(restored.lastUsedAt.getTime() < Date.now() - 24 * HOUR, true);
  assert.equal((await db.messageMedia.count({ where: { assetId: restored.id } })), 0);
  assert.equal((await db.chat.count()), 1, "the restore still completed");
});

// --- a partial chunk write does not strand the import ------------------------

/**
 * The FileHandle prototype, reached through a throwaway handle, so a test can
 * make one write land short and then fail the way a full disk does.
 */
async function fileHandlePrototype() {
  const probe = await open(join(await backupFiles.backupDirectory(), "probe.tmp"), "w");
  const prototype = Object.getPrototypeOf(probe) as { write: (...args: unknown[]) => Promise<{ bytesWritten: number }> };
  await probe.close();
  return prototype;
}

test("a chunk write that lands short and then fails leaves the staged file retryable", async (t: TestContext) => {
  const started = await imports.beginBackupImport(20);
  const prototype = await fileHandlePrototype();
  const originalWrite = prototype.write;
  let failed = false;
  t.mock.method(prototype, "write", async function (this: unknown, ...args: unknown[]) {
    if (failed) return originalWrite.apply(this, args as never);
    failed = true;
    // Three of the chunk's ten bytes reach the disk, then the write fails.
    await originalWrite.apply(this, [args[0], args[1], 3, args[3]] as never);
    throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  });

  const send = (offset: number, body: Buffer) =>
    imports.appendBackupImport(
      started.id,
      offset,
      new Request("http://localhost/api/backups/import/x", {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(body)
      })
    );

  await assert.rejects(() => send(0, Buffer.alloc(10, 1)), /ENOSPC|no space left/);

  // The whole point: the staged file is back at the tracked offset, so the
  // retry is accepted instead of being refused as a size mismatch for the next
  // hour. Without the truncation the file is 3 bytes and the check refuses.
  const staged = await stat(await backupFiles.backupFile(started.id, "upload"));
  assert.equal(staged.size, 0, "the failed write left no bytes past the tracked offset");

  const resumed = await send(0, Buffer.alloc(10, 2));
  assert.equal(resumed.offset, 10, "the retry resumes cleanly from the same offset");

  const rest = await send(10, Buffer.alloc(10, 3));
  assert.equal(rest.offset, 20, "the import reaches its declared size");
  await imports.cancelBackupImport(started.id);
});
