import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { testPng } from "../helpers/model-provider";

const cleanup = createTestDatabase();
const { db } = await import("@/db");

const archive = await import("@/lib/backups/archive");
const files = await import("@/lib/backups/files");
const storage = await import("@/lib/media/storage");
const { restoreAccountBackup } = await import("@/lib/backups/restore");
const { exportBackupCopy, listBackupExports } = await import("@/lib/backups/exports");
const { exclusiveDataOperation, protectDataOperation, retainDataOperation } = await import("@/lib/server/data-operations");
const { createScheduledJob, runDueScheduledJob } = { createScheduledJob: (await import("@/lib/scheduler/jobs")).createScheduledJob, runDueScheduledJob: (await import("@/lib/scheduler/runner")).runDueScheduledJob };
const uploadRoute = await import("@/app/api/backups/import/[id]/route");
const beginRoute = await import("@/lib/backups/imports");

const HOUR = 60 * 60 * 1000;
let cookie: string;
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const chunk = (id: string, offset: number, body: Buffer) =>
  new NextRequest(`http://localhost/api/backups/import/${id}?offset=${offset}`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/octet-stream" },
    body: new Uint8Array(body)
  });

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  globalThis.__privateAiRateLimitStore?.clear();
  cookie = localAccessCookie();
  for (const file of await files.listBackupFiles()) await files.removeBackupFile(file.id, file.extension);
  await db.message.deleteMany({});
  await db.chat.deleteMany({});
  await db.chatTag.deleteMany({});
  await db.memory.deleteMany({});
  await db.task.deleteMany({});
  await db.knowledgeDocument.deleteMany({});
  await db.documentChunk.deleteMany({});
  await db.documentTerm.deleteMany({});
  await db.mediaAsset.deleteMany({});
  await db.messageMedia.deleteMany({});
  await db.mediaGenerationInput.deleteMany({});
  await db.modelRequest.deleteMany({});
  await db.workspacePreference.deleteMany({});
  await db.scheduledJob.deleteMany({});
  await db.appNotice.deleteMany({});
  await db.directoryGrant.deleteMany({});
  await db.backupExport.deleteMany({});
});

after(async () => {
  await db.$disconnect();
  cleanup();
});

/** One conversation with a message, plus a media asset referenced by it. */
async function seed() {
  const chat = await db.chat.create({ data: { title: "Live workspace", tags: { create: { label: "keep" } } } });
  const message = await db.message.create({ data: { chatId: chat.id, role: "user", content: "before the backup" } });
  const asset = await storage.createMediaAsset({ bytes: testPng, mediaType: "image/png", kind: "attachment" });
  await db.messageMedia.create({ data: { messageId: message.id, assetId: asset.id } });
  return { chat, message, asset };
}

// --- a summary pointer survives the id remap ----------------------------------

test("restore rewrites the chat summary pointer onto the message it now covers", async () => {
  const original = await seed();
  const covered = await db.message.create({ data: { chatId: original.chat.id, role: "assistant", content: "covered by the summary" } });
  await db.chat.update({
    where: { id: original.chat.id },
    data: { summary: "Earlier turns, folded in.", summaryUpToMessageId: covered.id, summaryModelId: "openrouter:test/model", summaryRevision: 0 }
  });

  const backup = await exclusiveDataOperation(() => archive.createAccountBackup());
  await exclusiveDataOperation(() => restoreAccountBackup(backup.id));

  const restored = await db.chat.findFirstOrThrow({ where: {}, include: { messages: true, tags: true } });
  assert.notEqual(restored.id, original.chat.id, "the restore renumbers the conversation");
  const coveredAgain = restored.messages.find((message) => message.content === "covered by the summary");
  // Before the fix this was copied straight from the archive, so it named a
  // message row that had been deleted: the coverage note offered an id the
  // reader could never find, and the next summary started the conversation over.
  assert.equal(restored.summaryUpToMessageId, coveredAgain?.id, "the pointer names the restored message, not the archived id");
  assert.equal(restored.summary, "Earlier turns, folded in.");
  assert.equal(restored.summaryModelId, "openrouter:test/model");
  assert.equal(restored.createdAt.getTime(), original.chat.createdAt.getTime(), "timestamps travel with the row");
  assert.deepEqual(restored.tags.map((tag) => tag.label), ["keep"]);
  assert.equal(await db.messageMedia.count({ where: { assetId: restored.summaryUpToMessageId } }), 0);
  assert.equal((await db.messageMedia.count({ where: {} })), 1, "the attachment reference is remapped too");
});

test("a conversation with no summary does not gain a coverage pointer", async () => {
  const original = await seed();
  const backup = await exclusiveDataOperation(() => archive.createAccountBackup());
  await exclusiveDataOperation(() => restoreAccountBackup(backup.id));
  const restored = await db.chat.findFirstOrThrow({ where: {} });
  assert.notEqual(restored.id, original.chat.id);
  assert.equal(restored.summaryUpToMessageId, null);
});

// --- pausing is part of the restore, not a step after it ---------------------

test("a restore that cannot pause its schedules leaves the live workspace alone", async () => {
  const original = await seed();
  const backup = await exclusiveDataOperation(() => archive.createAccountBackup());
  await db.chat.update({ where: { id: original.chat.id }, data: { title: "Edited since the backup" } });
  await db.scheduledJob.create({ data: { kind: "scheduledBackup", enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily", dayOfWeek: null, nextRunAt: new Date(Date.now() + HOUR) } });

  // The pause used to run after the rows it describes had already been replaced
  // and committed, so this failure left a restored workspace whose schedules
  // were still live while the call reported the whole restore as failed.
  await db.$executeRawUnsafe("CREATE TRIGGER reject_pause BEFORE UPDATE ON scheduled_jobs WHEN OLD.\"enabled\" = 1 BEGIN SELECT RAISE(ABORT, 'Synthetic pause failure'); END");
  try {
    await assert.rejects(exclusiveDataOperation(() => restoreAccountBackup(backup.id)));
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER reject_pause");
  }

  const live = await db.chat.findUnique({ where: { id: original.chat.id } });
  assert.ok(live, "the live conversation still exists: the destructive step rolled back with the pause");
  assert.equal(live.title, "Edited since the backup", "and it still holds the user's live edits");
  assert.equal((await db.message.count({ where: { chatId: original.chat.id } })), 1);
  assert.equal((await db.scheduledJob.findFirstOrThrow({ where: { kind: "scheduledBackup" } })).enabled, true, "a restore that did not happen pauses nothing");
  // The safety backup taken before the attempt is still there to restore from.
  assert.ok((await files.listBackupFiles()).filter((file) => file.extension === "paib").length >= 1);
});

test("a completed restore pauses schedules and grants in the same commit and reports the counts", async () => {
  await seed();
  const backup = await exclusiveDataOperation(() => archive.createAccountBackup());
  await db.scheduledJob.create({ data: { kind: "scheduledBackup", enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily", dayOfWeek: null, nextRunAt: new Date(Date.now() + HOUR) } });
  await db.scheduledJob.create({ data: { kind: "dailyBrief", enabled: false, localTime: "09:00", timeZone: "UTC", interval: "daily", dayOfWeek: null, nextRunAt: new Date(Date.now() + HOUR) } });
  const grant = await db.directoryGrant.create({ data: { label: "Documents", path: "C:/Users/someone/Documents", realPath: "C:/Users/someone/Documents" } });

  const result = await exclusiveDataOperation(() => restoreAccountBackup(backup.id));
  assert.equal(result.restored, true);
  assert.equal(result.pausedSchedules, 1, "only the schedule that was running is reported as paused");
  assert.equal(result.revokedDirectoryGrants, 1);
  assert.equal((await db.scheduledJob.findFirstOrThrow({ where: { kind: "scheduledBackup" } })).enabled, false);
  assert.equal((await db.scheduledJob.findFirstOrThrow({ where: { kind: "dailyBrief" } })).enabled, false, "an already-off schedule stays off");
  assert.ok((await db.directoryGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokedAt);
});

// --- a scheduled backup is a reader, not an exclusive operation ---------------

test("a conversation in progress no longer costs the user the scheduled backup", async () => {
  let open!: ReadableStreamDefaultController<Uint8Array>;
  const streaming = protectDataOperation(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            open = controller;
            controller.enqueue(new TextEncoder().encode("data: partial\n\n"));
          }
        }),
        { headers: { "Content-Type": "text/event-stream" } }
      )
  );
  const response = await streaming(new NextRequest("http://localhost/api/chat", { headers: { cookie } }));

  await createScheduledJob({ kind: "scheduledBackup", enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily" });
  await db.scheduledJob.updateMany({ data: { nextRunAt: new Date(Date.now() - HOUR) } });

  // `protectDataOperation` holds the read for the whole turn, so the exclusive
  // lock the run used to ask for was refused here — and because a failed run is
  // marked done until its next turn, the day's backup was simply lost with a
  // "backup-failed" notice the user could not act on.
  const run = await runDueScheduledJob(new Date());
  open.close();
  await response.text();

  assert.equal(run?.outcome.ok, true, `the backup ran: ${JSON.stringify(run?.outcome)}`);
  assert.equal((await files.listBackupFiles()).filter((file) => file.extension === "paib").length, 1);
  assert.equal(await db.appNotice.count({ where: { title: "backup-failed" } }), 0);
  assert.equal((await db.scheduledJob.findFirstOrThrow({ where: { kind: "scheduledBackup" } })).lastStatus, "done");
});

test("the read a scheduled backup takes still excludes a restore in both directions", async () => {
  // A restore in flight must refuse to start once a backup is reading, and a
  // backup must refuse to start while a restore is replacing the workspace.
  const release = retainDataOperation();
  try {
    await assert.rejects(exclusiveDataOperation(async () => {}), /仍有请求/);
  } finally {
    release();
  }
  await exclusiveDataOperation(async () => {
    assert.throws(() => retainDataOperation(), /备份或恢复/);
  });
  // Released again, so nothing downstream inherits a held gate.
  await exclusiveDataOperation(async () => {});
});

// --- an interrupted import neither holds the gate nor looks complete ----------

test("an import that fails after claiming exclusivity releases the gate and stays un-restorable", async () => {
  const started = await beginRoute.beginBackupImport(50);
  const rejected = await uploadRoute.PUT(chunk(started.id, 0, Buffer.alloc(51)), context(started.id));
  assert.equal(rejected.status, 413, "the oversized chunk is refused");
  // The gate is released by the same `finally` that runs on the throwing path,
  // so one bad chunk cannot leave the workspace locked against every later
  // request until the process restarts.
  await exclusiveDataOperation(async () => {});

  const accepted = await uploadRoute.PUT(chunk(started.id, 0, Buffer.alloc(20)), context(started.id));
  assert.equal(accepted.status, 200, "the import resumes from the offset it was left at");
  const finished = await uploadRoute.POST(
    new NextRequest(`http://localhost/api/backups/import/${started.id}`, { method: "POST", headers: { cookie, "content-type": "application/json" } }),
    context(started.id)
  );
  assert.equal(finished.status, 409, "a half-written upload is not a restorable backup");
  assert.equal((await files.listBackupFiles()).some((file) => file.extension === "paib"), false);

  await uploadRoute.DELETE(new NextRequest(`http://localhost/api/backups/import/${started.id}`, { method: "DELETE", headers: { cookie } }), context(started.id));
  await exclusiveDataOperation(async () => {});
});

// --- a failed export leaves nothing where the user was told to trust ----------

test("an export that cannot be written leaves no file and no record at the destination", async () => {
  const backup = await exclusiveDataOperation(() => archive.createAccountBackup());
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ria-export-fail-")));
  try {
    // A destination whose directory does not exist is the ordinary Windows
    // failure: a removable drive that is gone, a folder the user deleted while
    // the dialog was open.
    const target = join(root, "missing-folder", `${backup.id}.paib`);
    await assert.rejects(() => exportBackupCopy(backup.id, target));

    assert.equal(existsSync(join(root, "missing-folder")), false, "nothing was created on the way to the destination");
    assert.deepEqual(readdirSync(root), [], "no partial or mislabeled artifact is left behind");
    assert.deepEqual(await listBackupExports(), [], "a copy that was never written is not recorded as one");

    // A destination that does work produces a complete file and a record.
    const good = join(root, `${backup.id}.paib`);
    const exported = await exportBackupCopy(backup.id, good);
    assert.equal(existsSync(good), true);
    assert.equal(exported.byteSize, (await files.listBackupFiles()).find((file) => file.id === backup.id)!.bytes);
    assert.equal((await listBackupExports()).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("restoring a summary without a valid history revision discards compression and preserves original messages", async () => {
  const original = await seed();
  await db.chat.update({ where: { id: original.chat.id }, data: { summary: "Unverified older summary", summaryUpToMessageId: original.message.id, summaryModelId: "openrouter:test/model", summaryRevision: null } });
  const backup = await exclusiveDataOperation(() => archive.createAccountBackup());
  await exclusiveDataOperation(() => restoreAccountBackup(backup.id));
  const restored = await db.chat.findFirstOrThrow({ include: { messages: true } });
  assert.equal(restored.summary, null); assert.equal(restored.summaryUpToMessageId, null); assert.equal(restored.summaryRevision, null);
  assert.ok(restored.messages.some(message => message.content === "before the backup"));
});
