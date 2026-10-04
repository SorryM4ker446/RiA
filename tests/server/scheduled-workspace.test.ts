import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { createTestDatabase } from "../helpers/database";

const cleanup = createTestDatabase();
delete process.env.PRIVATE_AI_TEST_PROVIDER;
const { db } = await import("@/db");
const { createScheduledJob, updateScheduledJob } = await import("@/lib/scheduler/jobs");
const { runDueScheduledJob } = await import("@/lib/scheduler/runner");
const { exclusiveDataOperation, dataRequestContext } = await import("@/lib/server/data-operations");
const { defaultModelPreferences } = await import("@/lib/models/preferences-schema");
const { getModelProvider } = await import("@/lib/models/providers");
const ref = { providerId: "openrouter" as const, modelId: "test/status-snapshot" };

beforeEach(async () => {
  await db.chat.deleteMany({});
  await db.task.deleteMany({});
  await db.modelRequest.deleteMany({});
  await db.appNotice.deleteMany({});
  await db.scheduledJob.deleteMany({});
  const settings = defaultModelPreferences();
  settings.chat.model = ref;
  settings.library = [{ ...ref, name: "Snapshot", description: "", modes: ["chat"], supportsImageInput: false, endpointImageInput: null, supportsTools: false, contextLength: null, pricing: {}, addedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() }];
  settings.rates[`${ref.providerId}:${ref.modelId}`] = { inputPerMillion: 1, outputPerMillion: 2, perRequest: null };
  await db.workspacePreference.upsert({ where: { id: "local" }, create: { id: "local", settings }, update: { settings } });
});
after(async () => { await db.$disconnect(); cleanup(); });

async function due(kind: "dailyBrief" | "weeklySummary" = "dailyBrief") {
  const job = await createScheduledJob({ kind, enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily" });
  await db.scheduledJob.update({ where: { id: job.id }, data: { nextRunAt: new Date(0) } });
  return job;
}

test("restore defers a due job without claiming it and a paused job stays paused", async () => {
  const job = await due();
  await exclusiveDataOperation(async () => {
    assert.equal(await runDueScheduledJob(), null);
    const row = await db.scheduledJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(row.lastStatus, null);
    assert.equal(row.nextRunAt.getTime(), 0);
    await updateScheduledJob(job.id, { enabled: false });
  });
  assert.equal(await runDueScheduledJob(), null);
  assert.equal(await db.chat.count(), 0);
  assert.equal(await db.modelRequest.count(), 0);
});

test("a running snapshot blocks restore, records one billed attempt and persists current totals", async (t) => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  let requestId: string | undefined;
  let prompt = "";
  const model = new MockLanguageModelV3({ doGenerate: async options => {
    assert.equal(options.maxOutputTokens, 512);
    assert.ok(options.abortSignal);
    requestId = dataRequestContext()?.requestId;
    prompt = JSON.stringify(options.prompt);
    entered();
    await gate;
    return { content: [{ type: "text", text: "当前有一项已完成任务。" }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } }, warnings: [] };
  } });
  t.mock.method(getModelProvider(ref.providerId), "createChatModel", () => model);
  await db.task.create({ data: { title: "Old task", status: "done", createdAt: new Date("2025-01-01"), updatedAt: new Date("2025-01-01") } });
  await due();
  const execution = runDueScheduledJob();
  try {
    await started;
    await assert.rejects(() => exclusiveDataOperation(async () => undefined), { code: "CONFLICT" });
    assert.equal(await runDueScheduledJob(), null);
  } finally { resume(); }
  assert.equal((await execution)?.outcome.ok, true);
  assert.match(prompt, /current totals/i);
  assert.match(prompt, /1 done/);
  assert.doesNotMatch(prompt, /Over today|Over the past week/);
  const [usage] = await db.modelRequest.findMany();
  assert.equal(await db.modelRequest.count(), 1);
  assert.equal(usage.requestId, requestId);
  assert.equal(usage.inputTokens, 5);
  assert.equal(usage.outputTokens, 3);
  assert.equal(usage.costSource, "configured");
  assert.equal(usage.costUsd, 0.000011);
  assert.equal(await db.message.count(), 2);
  const user = await db.message.findFirstOrThrow({ where: { role: "user" } });
  assert.match(user.content, /当前累计数量/);
  await exclusiveDataOperation(async () => undefined);
  assert.equal(dataRequestContext(), undefined);
});

test("a failed weekly snapshot records the failed attempt, releases the gate and leaves no partial conversation", async (t) => {
  const model = new MockLanguageModelV3({ doGenerate: async () => { throw new Error("Provider unavailable"); } });
  t.mock.method(getModelProvider(ref.providerId), "createChatModel", () => model);
  await due("weeklySummary");
  assert.equal((await runDueScheduledJob())?.outcome.ok, false);
  const records = await db.modelRequest.findMany();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "error");
  assert.equal(records[0].costUsd, null);
  assert.equal(await db.chat.count(), 0);
  await exclusiveDataOperation(async () => undefined);
});

test("a message persistence failure rolls back the snapshot conversation and retains usage", async (t) => {
  const model = new MockLanguageModelV3({ doGenerate: async () => ({
    content: [{ type: "text", text: "Current snapshot" }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } },
    warnings: [],
  }) });
  t.mock.method(getModelProvider(ref.providerId), "createChatModel", () => model);
  await due();
  await db.$executeRawUnsafe("CREATE TRIGGER reject_snapshot_reply BEFORE INSERT ON messages WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'simulated persistence failure'); END");
  try {
    assert.equal((await runDueScheduledJob())?.outcome.ok, false);
    assert.equal(await db.chat.count(), 0);
    assert.equal(await db.message.count(), 0);
    assert.equal(await db.modelRequest.count(), 1);
    await exclusiveDataOperation(async () => undefined);
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER reject_snapshot_reply");
  }
});
