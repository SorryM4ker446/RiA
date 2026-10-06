import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import { MockLanguageModelV3 } from "ai/test";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { updateTask } = await import("@/lib/tasks/service");
const { saveMemory } = await import("@/lib/memory/store");
const { indexDocument, reindexDocument, deleteDocument } = await import("@/lib/documents/store");
const { getEventSource, recordWorkspaceEvent, pruneWorkspaceEvents } = await import("@/lib/activity/events");
const { reviewWindow } = await import("@/lib/activity/window");
const { previewWorkspaceReview, generateWorkspaceReview: generateReview } = await import("@/lib/activity/reviews");
const { runBackgroundDataOperation } = await import("@/lib/server/data-operations");
const generateWorkspaceReview = (...args: Parameters<typeof generateReview>) => runBackgroundDataOperation(() => generateReview(...args));
const { getModelProvider } = await import("@/lib/models/providers");
const { defaultModelPreferences } = await import("@/lib/models/preferences-schema");
const { createAccountBackup, readBackupManifest } = await import("@/lib/backups/archive");
const { openBackup, backupFile } = await import("@/lib/backups/files");
const { restoreAccountBackup } = await import("@/lib/backups/restore");
const knowledgeRoute = await import("@/app/api/knowledge/[id]/route");
const previewRoute = await import("@/app/api/activity/review/route");
const sourceRoute = await import("@/app/api/activity/events/[id]/route");
const jobs = await import("@/lib/scheduler/jobs");
const { runDueScheduledJob } = await import("@/lib/scheduler/runner");
const now = new Date("2026-10-05T12:00:00Z");
let cookie: string;
beforeEach(async () => {
  await db.modelCallDay.deleteMany({});
  cookie = localAccessCookie(); globalThis.__privateAiRateLimitStore?.clear();
  delete process.env.PRIVATE_AI_TEST_PROVIDER;
  await db.workspaceReview.deleteMany({}); await db.workspaceEvent.deleteMany({});
  await db.scheduledRun.deleteMany({}); await db.scheduledJob.deleteMany({});
  await db.chat.deleteMany({}); await db.task.deleteMany({}); await db.memory.deleteMany({});
  await db.knowledgeDocument.deleteMany({}); await db.modelRequest.deleteMany({}); await db.workspacePreference.deleteMany({});
  await db.workspaceActivityState.update({ where: { id: "local" }, data: { recordingStartedAt: new Date("2026-01-01"), completeSince: new Date("2026-01-01") } });
});
after(async () => { await db.$disconnect(); cleanup(); });
const request = (path: string, method = "GET", body?: unknown, authenticated = true) => new NextRequest(`http://localhost${path}`, {
  method, headers: { ...(authenticated ? { cookie } : {}), "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function event(at: string, label = "Recorded task") {
  const task = await db.task.create({ data: { title: label } });
  await updateTask(task.id, { status: "done" }, new Date(at));
  return task;
}
async function configureModel() {
  process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  const settings = defaultModelPreferences();
  const ref = { providerId: "openrouter" as const, modelId: "test/review" };
  settings.chat.model = ref;
  settings.library = [{ ...ref, name: "Review fixture", description: "", modes: ["chat"], supportsImageInput: false, endpointImageInput: null, supportsTools: false, contextLength: null, pricing: {}, addedAt: now.toISOString(), lastSeenAt: now.toISOString() }];
  await db.workspacePreference.create({ data: { id: "local", settings } });
  return ref;
}

test("scheduled commentary uses background admission and keeps deterministic facts when pricing is unknown", async (t) => {
  await event("2026-10-04T12:00:00Z");
  await configureModel();
  const { getModelPreferences, saveModelPreferences } = await import("@/lib/models/preferences");
  const preferences = await getModelPreferences();
  await saveModelPreferences({ ...preferences, callLimits: { ...preferences.callLimits, backgroundMaxEstimatedUsd: 0.05 } });
  let submitted = 0;
  t.mock.method(getModelProvider("openrouter"), "createChatModel", () => new MockLanguageModelV3({ doGenerate: async () => { submitted++; throw new Error("must not submit"); } }));
  const result = await generateWorkspaceReview("daily", "Asia/Shanghai", true, now);
  assert.equal(result.review.modelStatus, "failed");
  assert.equal(result.review.modelError, "CONFIGURATION_ERROR");
  assert.ok(result.review.chatId);
  assert.equal(submitted, 0);
  assert.equal(await db.modelRequest.count(), 0);
  assert.match((await db.message.findFirstOrThrow({ where: { chatId: result.review.chatId!, role: "assistant" } })).content, /事实回顾/);
});

test("local review boundaries follow calendar dates through DST and skipped midnight", () => {
  const spring = reviewWindow("daily", "Europe/London", new Date("2026-03-30T12:00:00Z"));
  const fall = reviewWindow("daily", "Europe/London", new Date("2026-10-26T12:00:00Z"));
  assert.equal((spring.endAt.getTime() - spring.startAt.getTime()) / 3_600_000, 23);
  assert.equal((fall.endAt.getTime() - fall.startAt.getTime()) / 3_600_000, 25);
  const week = reviewWindow("weekly", "Europe/London", new Date("2026-03-30T12:00:00Z"));
  assert.equal(week.startDate, "2026-03-23"); assert.equal(week.endDate, "2026-03-30");
  assert.equal((week.endAt.getTime() - week.startAt.getTime()) / 3_600_000, 167);
  const midnight = reviewWindow("daily", "America/Sao_Paulo", new Date("2018-11-05T12:00:00Z"));
  assert.equal(midnight.startAt.toISOString(), "2018-11-04T03:00:00.000Z");
});

test("completion and reopening are independent events and duplicate concurrent updates add no events", async () => {
  const task = await db.task.create({ data: { title: "Status changes" } });
  await Promise.all([updateTask(task.id, { status: "done" }), updateTask(task.id, { status: "done" })]);
  await updateTask(task.id, { status: "todo" }); await updateTask(task.id, { status: "todo" });
  await updateTask(task.id, { status: "done" });
  const events = await db.workspaceEvent.findMany({ orderBy: [{ occurredAt: "asc" }, { id: "asc" }] });
  assert.deepEqual(events.map(event => event.kind), ["task.completed", "task.reopened", "task.completed"]);
  assert.equal(new Set(events.map(event => event.id)).size, 3);
});

test("event insertion failure rolls back task state and a repeated task successor", async () => {
  const task = await db.task.create({ data: { title: "Recurring", dueDate: new Date("2026-10-01T09:00:00Z"), repeatAnchor: new Date("2026-10-01T09:00:00Z"), repeatRule: "daily" } });
  const sqlite = new DatabaseSync(process.env.DATABASE_URL!.slice(5));
  sqlite.exec("CREATE TRIGGER reject_activity BEFORE INSERT ON workspace_events BEGIN SELECT RAISE(ABORT, 'fixture-event-failure'); END;");
  try {
    await assert.rejects(() => updateTask(task.id, { status: "done" }, now));
    assert.equal(await db.task.count(), 1);
    const original = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(original.status, "todo"); assert.equal(original.repeatGenerated, false);
  } finally { sqlite.exec("DROP TRIGGER reject_activity"); sqlite.close(); }
});

test("document imports and changes record events while duplicate import and reindex do not", async () => {
  const input = { filename: "record.txt", format: "txt", byteSize: 8, pages: [{ pageNumber: null, text: "Original source text" }] };
  const first = await indexDocument(input);
  await indexDocument(input); await reindexDocument(first.document.id);
  await indexDocument({ ...input, pages: [{ pageNumber: null, text: "Changed source text" }] });
  assert.deepEqual((await db.workspaceEvent.findMany({ orderBy: [{ occurredAt: "asc" }, { id: "asc" }] })).map(event => event.kind), ["document.imported", "document.updated"]);
  await deleteDocument(first.document.id);
  assert.equal((await getEventSource((await db.workspaceEvent.findFirstOrThrow()).id))?.entity, null);
});

test("memory confirmation is transactional and repeated acceptance or assistant inference adds no confirmation", async () => {
  const candidate = await saveMemory({ key: "Preference", value: "Candidate", source: "assistant" });
  assert.equal(await db.workspaceEvent.count(), 0);
  const path = `/api/knowledge/${candidate.id}`, context = { params: Promise.resolve({ id: candidate.id }) };
  assert.equal((await knowledgeRoute.PATCH(request(path, "PATCH", { confirmed: true }), context)).status, 200);
  assert.equal((await knowledgeRoute.PATCH(request(path, "PATCH", { confirmed: true }), context)).status, 200);
  await saveMemory({ key: candidate.key, value: "Discarded inference", source: "assistant" });
  assert.equal(await db.workspaceEvent.count(), 1);
  assert.equal((await db.memory.findUniqueOrThrow({ where: { id: candidate.id } })).value, "Candidate");
});

test("review uses an inclusive start and exclusive end in the selected zone, not current task status", async () => {
  await event("2026-10-03T15:59:59Z");
  const task = await event("2026-10-03T16:00:00Z", "Boundary task");
  await updateTask(task.id, { status: "todo" }, new Date("2026-10-04T05:00:00Z"));
  await event("2026-10-04T16:00:00Z");
  const review = await previewWorkspaceReview("daily", "Asia/Shanghai", new Date("2026-10-05T01:00:00Z"));
  assert.equal(review.facts.counts["task.completed"], 1); assert.equal(review.facts.counts["task.reopened"], 1);
  assert.equal(review.facts.complete, true);
  const source = await getEventSource(review.facts.sources[0].id);
  assert.ok(source?.entity && "status" in source.entity); assert.equal(source.entity.status, "todo");
});

test("preexisting rows never manufacture events and partial coverage stays explicit", async () => {
  await db.task.create({ data: { title: "Old completed task", status: "done", updatedAt: new Date("2026-10-04") } });
  await db.workspaceActivityState.update({ where: { id: "local" }, data: { recordingStartedAt: new Date("2026-10-04T12:00:00Z"), completeSince: new Date("2026-10-04T12:00:00Z") } });
  const preview = await previewWorkspaceReview("daily", "UTC", now);
  assert.equal(preview.facts.complete, false); assert.equal(preview.facts.counts["task.completed"], 0);
  const { review } = await generateWorkspaceReview("daily", "UTC", true, now);
  assert.equal(review.modelStatus, "empty"); assert.equal(await db.modelRequest.count(), 0);
  assert.match((await db.message.findFirstOrThrow({ where: { role: "assistant" } })).content, /无法还原/);
});

test("missing model and provider failure preserve the same factual report without retries", async (t) => {
  await event("2026-10-04T06:00:00Z");
  const missing = await generateWorkspaceReview("daily", "UTC", true, now);
  assert.equal(missing.review.modelError, "CONFIGURATION_ERROR"); assert.equal(await db.modelRequest.count(), 0);
  await db.workspaceReview.deleteMany({}); await db.chat.deleteMany({});
  const ref = await configureModel();
  const model = new MockLanguageModelV3({ doGenerate: async () => { throw new Error("private-provider-error"); } });
  t.mock.method(getModelProvider(ref.providerId), "createChatModel", () => model);
  const failed = await generateWorkspaceReview("daily", "UTC", true, now);
  assert.equal(failed.review.modelError, "UPSTREAM_FAILED"); assert.equal(await db.modelRequest.count(), 1);
  assert.equal(await db.chat.count(), 1);
  assert.equal((await generateWorkspaceReview("daily", "UTC", true, now)).reused, true);
  assert.equal(await db.modelRequest.count(), 1);
  assert.doesNotMatch((await db.message.findFirstOrThrow({ where: { role: "assistant" } })).content, /private-provider-error/);
});

test("two schedules and a restored or deleted conversation reuse one period and one model request", async (t) => {
  await event("2026-10-04T06:00:00Z"); const ref = await configureModel();
  const model = new MockLanguageModelV3({ doGenerate: { content: [{ type: "text", text: "仅依据已记录的事件。" }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } }, warnings: [] } });
  t.mock.method(getModelProvider(ref.providerId), "createChatModel", () => model);
  const schedules = await Promise.all([1, 2].map(() => jobs.createScheduledJob({ kind: "dailyBrief", enabled: true, useModel: true, localTime: "09:00", timeZone: "UTC", interval: "daily" })));
  await db.scheduledJob.updateMany({ where: { id: { in: schedules.map(job => job.id) } }, data: { nextRunAt: new Date("2026-10-05T09:00:00Z") } });
  assert.equal((await runDueScheduledJob(now))?.outcome.ok, true);
  const first = { review: await db.workspaceReview.findFirstOrThrow() };
  assert.equal((await runDueScheduledJob(now))?.outcome.ok, true);
  const second = { review: await db.workspaceReview.findFirstOrThrow() };
  assert.equal(await db.scheduledRun.count(), 2); assert.equal(await db.workspaceReview.count(), 1);
  assert.equal(second.review.id, first.review.id); assert.equal(await db.modelRequest.count(), 1);
  const backup = await createAccountBackup(); await restoreAccountBackup(backup.id);
  const restored = await generateWorkspaceReview("daily", "UTC", true, now);
  assert.equal(restored.review.id, first.review.id); assert.equal(await db.modelRequest.count(), 1);
  await db.chat.deleteMany({});
  const recreated = await generateWorkspaceReview("daily", "UTC", true, now);
  assert.ok(recreated.review.chatId); assert.equal(await db.modelRequest.count(), 1);
});

test("sleep catch-up produces one latest complete period and a startup interruption does not repeat a model request", async () => {
  const job = await jobs.createScheduledJob({ kind: "dailyBrief", enabled: true, localTime: "09:00", timeZone: "Asia/Shanghai", interval: "daily" });
  await db.scheduledJob.update({ where: { id: job.id }, data: { nextRunAt: new Date("2026-09-25") } });
  assert.equal((await runDueScheduledJob(now))?.outcome.ok, true);
  assert.equal(await runDueScheduledJob(now), null); assert.equal(await db.workspaceReview.count(), 1);
  const review = await db.workspaceReview.findFirstOrThrow(); assert.equal(review.startAt.toISOString(), "2026-10-03T16:00:00.000Z");
  await db.workspaceReview.update({ where: { id: review.id }, data: { modelStatus: "pending" } });
  await jobs.releaseInterruptedJobs(now);
  assert.equal((await generateWorkspaceReview("daily", "Asia/Shanghai", true, now)).review.modelStatus, "interrupted");
  assert.equal(await db.modelRequest.count(), 0);
});

test("portable events retain identity and map source rows without creating restoration activity", async () => {
  const task = await event("2026-10-04T06:00:00Z"); const original = await db.workspaceEvent.findFirstOrThrow();
  const backup = await createAccountBackup(); await restoreAccountBackup(backup.id); await restoreAccountBackup(backup.id);
  assert.equal(await db.workspaceEvent.count(), 1);
  const restored = await db.workspaceEvent.findUniqueOrThrow({ where: { id: original.id } });
  assert.notEqual(restored.entityId, task.id); assert.ok((await getEventSource(restored.id))?.entity);
});

test("an old archive without activity restores empty coverage from restoration time", async () => {
  await event("2026-10-04T06:00:00Z");
  const backup = await createAccountBackup(); const file = await openBackup(backup.id);
  const manifest = (await readBackupManifest(file)).manifest as unknown as Record<string, unknown>; await file.close();
  delete manifest.events; delete manifest.activityCoverage; delete manifest.reviews;
  const json = Buffer.from(JSON.stringify(manifest)); const header = Buffer.alloc(44);
  header.write("PAIB0001"); header.writeUInt32BE(json.length, 8); createHash("sha256").update(json).digest().copy(header, 12);
  const oldId = randomUUID(); await writeFile(await backupFile(oldId), Buffer.concat([header, json]));
  const before = new Date(); await restoreAccountBackup(oldId);
  assert.equal(await db.workspaceEvent.count(), 0);
  assert.ok((await db.workspaceActivityState.findUniqueOrThrow({ where: { id: "local" } })).recordingStartedAt >= before);
});

test("retention exposes incomplete coverage and source API enforces access including deleted sources", async () => {
  await db.workspaceEvent.createMany({ data: Array.from({ length: 10_002 }, (_, index) => ({ id: `bounded-${String(index).padStart(5, "0")}`, kind: "task.completed", entityId: "deleted-source", label: "Snapshot", occurredAt: new Date("2026-10-04T06:00:00Z") })) });
  await db.$transaction(tx => pruneWorkspaceEvents(tx, now)); assert.equal(await db.workspaceEvent.count(), 10_000);
  const preview = await previewWorkspaceReview("daily", "UTC", now); assert.equal(preview.facts.complete, false);
  assert.equal(preview.facts.counts["task.completed"], 10_000); assert.equal(preview.facts.omitted, 9900);
  const id = preview.facts.sources[0].id, path = `/api/activity/events/${id}`, context = { params: Promise.resolve({ id }) };
  assert.equal((await sourceRoute.GET(request(path, "GET", undefined, false), context)).status, 401);
  assert.equal((await (await sourceRoute.GET(request(path), context)).json()).data.entity, null);
  assert.equal((await previewRoute.GET(request("/api/activity/review?period=daily&timeZone=Invalid"))).status, 400);
  assert.equal((await previewRoute.GET(request("/api/activity/review?period=daily&period=weekly&timeZone=UTC"))).status, 400);
  assert.equal((await previewRoute.GET(request("/api/activity/review?period=daily&timeZone=UTC&asOf=2026-01-01"))).status, 400);
  assert.equal((await previewRoute.GET(request("/api/activity/review?period=daily&timeZone=UTC", "GET", undefined, false))).status, 401);
});
