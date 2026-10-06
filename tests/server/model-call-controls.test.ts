import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { createTestDatabase } from "../helpers/database";
import { seedTestModelPreferences, CHAT_MODEL_REF } from "../helpers/model-library";
const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { beginModelAttempt, budgetDay, recoverModelAttempts } = await import("@/lib/models/call-controls");
const { recordModelAttempt, usageSummary, usageCost } = await import("@/lib/models/usage");
const { getModelPreferences, saveModelPreferences } = await import("@/lib/models/preferences");
const { withModelCallSource } = await import("@/lib/models/call-context");
const { observeLanguageModel } = await import("@/lib/models/observe-language");
beforeEach(async () => { await db.modelRequest.deleteMany({}); await db.modelCallDay.deleteMany({}); await db.workspacePreference.deleteMany({}); await seedTestModelPreferences(db); });
after(async () => { await db.$disconnect(); cleanup(); });
const request = { mode: "chat" as const, ref: CHAT_MODEL_REF, prompt: "hello", maxOutputTokens: 512 };
async function limits(patch: Partial<Awaited<ReturnType<typeof getModelPreferences>>["callLimits"]>) {
  const preferences = await getModelPreferences();
  await saveModelPreferences({ ...preferences, callLimits: { ...preferences.callLimits, ...patch } });
}
async function settle(id: string, error?: Error) { await recordModelAttempt({ attemptId: id, mode: "chat", modelId: CHAT_MODEL_REF.modelId, started: Date.now(), ...(error ? { error } : {}) }); }

test("concurrent admission reserves one durable slot and cancellation frees only concurrency", async () => {
  await limits({ maxConcurrent: 1, backgroundDailyCalls: 1 });
  const results = await Promise.allSettled([beginModelAttempt({ ...request, source: "summary" }), beginModelAttempt({ ...request, source: "summary" })]);
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(await db.modelRequest.count({ where: { status: "pending" } }), 1);
  const row = (await db.modelRequest.findMany())[0];
  await settle(row.id, new DOMException("cancelled", "AbortError"));
  assert.equal((await db.modelRequest.findUniqueOrThrow({ where: { id: row.id } })).status, "aborted");
  await assert.rejects(beginModelAttempt({ ...request, source: "summary" }), /当日|本地日期/);
  const foreground = await beginModelAttempt({ ...request, source: "chat" });
  await settle(foreground.id);
  assert.equal((await usageSummary("summary")).totals.requests, 1);
});

test("unknown pricing and per-call or daily estimates reject before admission; failures cannot reset budgets", async () => {
  await limits({ backgroundMaxEstimatedUsd: 1, backgroundDailyEstimatedUsd: 0.006 });
  await assert.rejects(beginModelAttempt({ ...request, source: "scheduled" }), /配置模型/);
  assert.equal(await db.modelRequest.count(), 0);
  const preferences = await getModelPreferences();
  await saveModelPreferences({ ...preferences, rates: { ["openrouter:" + CHAT_MODEL_REF.modelId]: { inputPerMillion: 1, outputPerMillion: 10, perRequest: null } } });
  await limits({ backgroundMaxEstimatedUsd: 0.001 });
  await assert.rejects(beginModelAttempt({ ...request, source: "scheduled" }), /单次上限/);
  await limits({ backgroundMaxEstimatedUsd: 1 });
  const first = await beginModelAttempt({ ...request, source: "scheduled" });
  await settle(first.id, new Error("failed"));
  await assert.rejects(beginModelAttempt({ ...request, source: "scheduled" }), /本地日期/);
  assert.equal((await db.modelRequest.findUniqueOrThrow({ where: { id: first.id } })).costUsd, null);
});

test("restart interrupts pending records without replay or a late settlement overwriting them", async () => {
  const first = await beginModelAttempt({ ...request, source: "summary" });
  await db.$disconnect();
  assert.equal((await recoverModelAttempts()).count, 1);
  await settle(first.id);
  const row = await db.modelRequest.findUniqueOrThrow({ where: { id: first.id } });
  assert.equal(row.status, "interrupted"); assert.equal(row.costSource, "unknown");
  assert.equal((await recoverModelAttempts()).count, 0);
  assert.equal((await db.modelCallDay.findMany({ where: { day: { not: "lock" } } }))[0].calls, 1);
});

test("pre-cancelled calls consume no allowance and dates use the configured zone across DST", async () => {
  await assert.rejects(beginModelAttempt({ ...request, source: "summary", signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(await db.modelRequest.count(), 0);
  assert.equal(await db.modelCallDay.count(), 0);
  assert.equal(budgetDay(new Date("2026-10-04T16:01:00Z"), "Asia/Shanghai"), "2026-10-05:Asia/Shanghai");
  assert.equal(budgetDay(new Date("2026-11-01T05:30:00Z"), "America/New_York"), budgetDay(new Date("2026-11-01T06:30:00Z"), "America/New_York"));
});

test("the real observer records source and unknown cancellation exactly once", async () => {
  let submitted = 0;
  const provider = new MockLanguageModelV3({ doStream: async () => {
    submitted++;
    return { stream: new ReadableStream({ start(controller) { controller.enqueue({ type: "text-delta", id: "t", delta: "partial" }); } }) };
  } });
  const model = withModelCallSource("chat", () => observeLanguageModel(provider, CHAT_MODEL_REF, () => provider));
  const result = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }] });
  assert.equal((await usageSummary("chat")).recent[0].status, "pending");
  const reader = result.stream.getReader(); await reader.read(); await reader.cancel();
  assert.equal(submitted, 1);
  const rows = (await usageSummary("chat")).recent;
  assert.equal(rows.length, 1); assert.equal(rows[0].status, "aborted"); assert.equal(rows[0].costUsd, null);
});

test("configured cache writes are subtracted from fresh input when the provider omits the split", () => {
  const cost = usageCost("chat", { inputTokens: { total: 100, cacheRead: 20, cacheWrite: 30 }, outputTokens: 0 }, {}, { inputPerMillion: 1, outputPerMillion: 1, perRequest: null, cacheReadPerMillion: 0.1, cacheWritePerMillion: 2 });
  assert.equal(cost.costUsd, 112 / 1_000_000);
});

test("a fallback resolves the selected provider adapter and accounts for both attempts", async (t) => {
  const { getModelProvider } = await import("@/lib/models/providers");
  const { getChatModel } = await import("@/lib/ai/client");
  const preferences = await getModelPreferences();
  const fallback = { providerId: "deepseek" as const, modelId: "deepseek-v4-pro" };
  preferences.library.push({ ...preferences.library[0], ...fallback, modes: ["chat"] });
  preferences.chat.fallback = fallback;
  await db.workspacePreference.update({ where: { id: "local" }, data: { settings: preferences } });
  const adapters: string[] = [];
  t.mock.method(getModelProvider("openrouter"), "createChatModel", modelId => {
    adapters.push(`openrouter:${modelId}`);
    return new MockLanguageModelV3({ doStream: async () => { throw Object.assign(new Error("unavailable"), { statusCode: 503 }); } });
  });
  t.mock.method(getModelProvider("deepseek"), "createChatModel", modelId => {
    adapters.push(`deepseek:${modelId}`);
    return new MockLanguageModelV3({ doStream: async () => ({ stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: "text-delta", id: "t", delta: "fallback" });
      controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
      controller.close();
    } }) }) });
  });
  const response = await getChatModel(CHAT_MODEL_REF).doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }] });
  for await (const _part of response.stream) { /* Consume the real observer lifecycle. */ }
  assert.deepEqual(adapters, [`openrouter:${CHAT_MODEL_REF.modelId}`, `deepseek:${fallback.modelId}`]);
  const rows = await db.modelRequest.findMany({ orderBy: { createdAt: "asc" } });
  assert.equal(rows.length, 2); assert.equal(rows[0].status, "error"); assert.equal(rows[1].status, "success");
  assert.equal(rows[1].modelProvider, "deepseek"); assert.equal(rows[1].fallback, true);
});
