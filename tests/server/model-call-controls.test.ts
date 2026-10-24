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
  const results = await Promise.allSettled([beginModelAttempt({ ...request, source: "scheduled" }), beginModelAttempt({ ...request, source: "scheduled" })]);
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(await db.modelRequest.count({ where: { status: "pending" } }), 1);
  const row = (await db.modelRequest.findMany())[0];
  await settle(row.id, new DOMException("cancelled", "AbortError"));
  assert.equal((await db.modelRequest.findUniqueOrThrow({ where: { id: row.id } })).status, "aborted");
  await assert.rejects(beginModelAttempt({ ...request, source: "scheduled" }), /当日|本地日期/);
  const foreground = await beginModelAttempt({ ...request, source: "chat" });
  await settle(foreground.id);
  assert.equal((await usageSummary("scheduled")).totals.requests, 1);
});

test("chat-driven summaries are attributed but never consume or wait on the background allowance", async () => {
  await limits({ backgroundDailyCalls: 0, backgroundMaxEstimatedUsd: 0.000001, backgroundDailyEstimatedUsd: 0 });
  await assert.rejects(beginModelAttempt({ ...request, source: "scheduled" }), /配置模型|本地日期/);
  const summary = await beginModelAttempt({ ...request, source: "summary" });
  await settle(summary.id);
  assert.equal((await usageSummary("summary")).totals.requests, 1);
  assert.equal(await db.modelCallDay.count({ where: { day: { not: "lock" } } }), 0);
  await limits({ maxConcurrent: 1 });
  const held = await beginModelAttempt({ ...request, source: "chat" });
  await assert.rejects(beginModelAttempt({ ...request, source: "summary" }), /并发/);
  await settle(held.id);
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
  const first = await beginModelAttempt({ ...request, source: "scheduled" });
  await db.$disconnect();
  assert.equal((await recoverModelAttempts()).count, 1);
  await settle(first.id);
  const row = await db.modelRequest.findUniqueOrThrow({ where: { id: first.id } });
  assert.equal(row.status, "interrupted"); assert.equal(row.costSource, "unknown");
  assert.equal((await recoverModelAttempts()).count, 0);
  assert.equal((await db.modelCallDay.findMany({ where: { day: { not: "lock" } } }))[0].calls, 1);
});

test("pre-cancelled calls consume no allowance and dates use the configured zone across DST", async () => {
  await assert.rejects(beginModelAttempt({ ...request, source: "scheduled", signal: AbortSignal.abort() }), { name: "AbortError" });
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
  // The transient failure is retried on the primary before the fallback is tried.
  assert.equal(rows.length, 4); assert.deepEqual(rows.slice(0, 3).map(row => [row.status, row.fallback]), [["error", false], ["error", false], ["error", false]]);
  assert.equal(rows[3].status, "success"); assert.equal(rows[3].modelProvider, "deepseek"); assert.equal(rows[3].fallback, true);
});

test("a smaller fallback rejects oversized context before submission and releases its model lease", { timeout: 5000 }, async () => {
  const settings = await getModelPreferences();
  const fallback = { providerId: "deepseek" as const, modelId: "deepseek-small-context" };
  settings.library.push({ ...settings.library[0], ...fallback, modes: ["chat"], contextLength: 4096 });
  settings.chat.fallback = fallback;
  // Library membership is authoritative and is not overwritten by preference updates.
  await db.workspacePreference.update({ where: { id: "local" }, data: { settings } });
  let primaryCalls = 0, fallbackCalls = 0;
  const primary = new MockLanguageModelV3({ doStream: async () => { primaryCalls++; throw Object.assign(new Error("unavailable"), { statusCode: 503 }); } });
  const backup = new MockLanguageModelV3({ doStream: async () => { fallbackCalls++; throw new Error("must not submit"); } });
  const observed = observeLanguageModel(primary, CHAT_MODEL_REF, () => backup);
  await assert.rejects(async () => observed.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "0".repeat(6000) }] }] }), { code: "CONTEXT_LIMIT" });
  assert.equal(primaryCalls, 3, "two retries of the transient failure"); assert.equal(fallbackCalls, 0);
  assert.equal(await db.modelRequest.count({ where: { status: "pending" } }), 0);
  assert.equal(await db.modelRequest.count(), 3);
  const { removeModel } = await import("@/lib/models/preferences");
  await removeModel(fallback);
});

test("every chat call is capped by the known output limit, else the 128K default, that its input leaves room for", async () => {
  const sent: Array<number | undefined> = [];
  const finish = { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } };
  const provider = new MockLanguageModelV3({
    doStream: async options => { sent.push(options.maxOutputTokens); return { stream: new ReadableStream({ start(controller) { controller.enqueue(finish); controller.close(); } }) }; },
    doGenerate: async options => { sent.push(options.maxOutputTokens); return { content: [{ type: "text", text: "ok" }], finishReason: finish.finishReason, usage: finish.usage, warnings: [] }; },
  });
  const model = withModelCallSource("chat", () => observeLanguageModel(provider, CHAT_MODEL_REF, () => provider));
  const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "Write the full solution" }] }];
  const drain = async () => { for await (const _part of (await model.doStream({ prompt })).stream) { /* consume */ } };

  // A large window, so the cap reflects the output limit rather than the room left.
  const seeded = await getModelPreferences();
  await db.workspacePreference.update({ where: { id: "local" }, data: { settings: { ...seeded, library: seeded.library.map(row => row.modelId === CHAT_MODEL_REF.modelId ? { ...row, contextLength: 1_000_000 } : row) } } });
  await drain(); await model.doGenerate({ prompt });
  assert.deepEqual(sent.splice(0), [131_072, 131_072], "an unknown limit uses the 128K default");
  await model.doGenerate({ prompt, maxOutputTokens: 512 });
  assert.deepEqual(sent.splice(0), [512], "an explicit smaller cap is kept");

  const preferences = await getModelPreferences();
  // The library is catalog-owned, so the catalog values are seeded directly.
  await db.workspacePreference.update({ where: { id: "local" }, data: { settings: { ...preferences, library: preferences.library.map(row => row.modelId === CHAT_MODEL_REF.modelId ? { ...row, contextLength: 1_000_000, maxOutputTokens: 100_000 } : row) } } });
  await drain();
  assert.deepEqual(sent.splice(0), [100_000], "the catalog limit is used in full, above the 8,192-token planning reservation");

  const catalog = await getModelPreferences();
  await saveModelPreferences({ ...catalog, contextLimits: { [`${CHAT_MODEL_REF.providerId}:${CHAT_MODEL_REF.modelId}`]: { contextLength: null, maxOutputTokens: 2048 } } });
  await drain();
  assert.deepEqual(sent.splice(0), [2048], "a configured limit lowers the cap");
});

test("a background call with no known limit is bounded by the planning reservation only when a monetary ceiling must price it", async () => {
  const sent: Array<number | undefined> = [];
  const provider = new MockLanguageModelV3({ doGenerate: async options => { sent.push(options.maxOutputTokens); return { content: [{ type: "text", text: "ok" }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] }; } });
  const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "Summarize the counts" }] }];
  const scheduled = withModelCallSource("scheduled", () => observeLanguageModel(provider, CHAT_MODEL_REF, () => provider));
  const seeded = await getModelPreferences();
  await db.workspacePreference.update({ where: { id: "local" }, data: { settings: { ...seeded, library: seeded.library.map(row => row.modelId === CHAT_MODEL_REF.modelId ? { ...row, contextLength: 1_000_000 } : row) } } });
  await scheduled.doGenerate({ prompt });
  assert.deepEqual(sent.splice(0), [131_072]);
  const preferences = await getModelPreferences();
  await saveModelPreferences({ ...preferences, rates: { ...preferences.rates, [`${CHAT_MODEL_REF.providerId}:${CHAT_MODEL_REF.modelId}`]: { inputPerMillion: 1, outputPerMillion: 1, perRequest: null } }, callLimits: { ...preferences.callLimits, backgroundMaxEstimatedUsd: 10 } });
  await scheduled.doGenerate({ prompt });
  assert.deepEqual(sent.splice(0), [8192]);
  const row = await db.modelRequest.findFirstOrThrow({ where: { source: "scheduled", estimatedUsd: { not: null } } });
  assert.ok(row.estimatedUsd! > 0, "the bounded call is priced rather than refused as unknown");
  const chat = withModelCallSource("chat", () => observeLanguageModel(provider, CHAT_MODEL_REF, () => provider));
  await chat.doGenerate({ prompt });
  assert.deepEqual(sent.splice(0), [131_072], "foreground calls keep the default");
});

const usage = (input: number, output: number) => ({ inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: output, text: output, reasoning: 0 } });
function streamOf(parts: unknown[]) { return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }) }; }
const userPrompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "Write the whole solution" }] }];
type SeenPart = { type: string; id?: string; delta?: string; finishReason?: { unified: string }; usage?: ReturnType<typeof usage> };

test("a text answer cut off by the output limit is continued into the same text part", async () => {
  const { CONTINUE_INSTRUCTION } = await import("@/lib/models/continuation");
  const prompts: unknown[] = [];
  const provider = new MockLanguageModelV3({ doStream: async options => {
    prompts.push(options.prompt);
    return (prompts.length === 1
      ? streamOf([{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "int main() {" }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "length", raw: "length" }, usage: usage(100, 50) }])
      : streamOf([{ type: "stream-start", warnings: [] }, { type: "reasoning-start", id: "r" }, { type: "reasoning-delta", id: "r", delta: "resume" }, { type: "reasoning-end", id: "r" },
        { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: " return 0; }" }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(160, 20) }])) as never;
  } });
  const model = withModelCallSource("chat", () => observeLanguageModel(provider, CHAT_MODEL_REF, () => provider));
  const parts: SeenPart[] = [];
  for await (const part of (await model.doStream({ prompt: userPrompt })).stream) parts.push(part as never);
  assert.equal(prompts.length, 2);
  const second = JSON.stringify(prompts[1]);
  assert.ok(second.includes("int main() {") && second.includes(CONTINUE_INSTRUCTION), "the continuation sees what was written");
  assert.deepEqual(parts.filter(part => part.type === "text-delta").map(part => [part.id, part.delta]), [["t", "int main() {"], ["t", " return 0; }"]], "one text part carries the whole answer");
  assert.equal(parts.filter(part => part.type === "text-start").length, 1);
  assert.deepEqual(parts.filter(part => part.type === "text-end").map(part => part.id), ["t"]);
  assert.ok(parts.findIndex(part => part.type === "reasoning-start") < parts.findIndex(part => part.type === "text-end"), "the text part stays open across the continuation's reasoning");
  const finish = parts.filter(part => part.type === "finish");
  assert.equal(finish.length, 1); assert.equal(finish[0].finishReason!.unified, "stop");
  assert.equal(finish[0].usage!.inputTokens.total, 100, "input stays the step's own prompt");
  assert.equal(finish[0].usage!.outputTokens.total, 70);
  assert.equal(await db.modelRequest.count(), 2, "each request is admitted and recorded");
});

test("a cut-off tool call is never continued and continuations are bounded", async () => {
  const { MAX_CONTINUATIONS } = await import("@/lib/models/continuation");
  let calls = 0;
  const truncatedTool = new MockLanguageModelV3({ doStream: async () => { calls++; return streamOf([{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Editing" }, { type: "text-end", id: "t" },
    { type: "tool-input-start", id: "c", toolName: "editFile" }, { type: "tool-input-delta", id: "c", delta: "{\"path\":" }, { type: "finish", finishReason: { unified: "length", raw: "length" }, usage: usage(10, 10) }]) as never; } });
  const tool = withModelCallSource("chat", () => observeLanguageModel(truncatedTool, CHAT_MODEL_REF, () => truncatedTool));
  const toolParts: SeenPart[] = [];
  for await (const part of (await tool.doStream({ prompt: userPrompt })).stream) toolParts.push(part as never);
  assert.equal(calls, 1); assert.equal(toolParts.at(-1)!.finishReason!.unified, "length");

  calls = 0;
  const endless = new MockLanguageModelV3({ doStream: async () => { calls++; return streamOf([{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "more " }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "length", raw: "length" }, usage: usage(10, 10) }]) as never; } });
  const model = withModelCallSource("chat", () => observeLanguageModel(endless, CHAT_MODEL_REF, () => endless));
  const parts: SeenPart[] = [];
  for await (const part of (await model.doStream({ prompt: userPrompt })).stream) parts.push(part as never);
  assert.equal(calls, 1 + MAX_CONTINUATIONS);
  assert.equal(parts.at(-1)!.finishReason!.unified, "length", "a still-incomplete answer keeps its length finish");
});

test("transient failures are retried after Retry-After, other failures and unattended calls are not", async t => {
  // The waits between attempts are what Retry-After decides, so those are what is
  // checked: the call's total time also covers recording each attempt, which a
  // busy machine can stretch past any fixed budget.
  const waits: number[] = [];
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", ((handler: () => void, ms?: number, ...args: unknown[]) => {
    if (new Error().stack?.includes("waitForRetry")) waits.push(ms ?? 0);
    return schedule(handler, ms, ...args);
  }) as typeof setTimeout);
  let calls = 0;
  const rateLimited = new MockLanguageModelV3({ doGenerate: async () => {
    if (calls++ < 2) throw Object.assign(new Error("rate limited"), { statusCode: 429, responseHeaders: { "Retry-After": "0" } });
    return { content: [{ type: "text", text: "ok" }], finishReason: { unified: "stop", raw: "stop" }, usage: usage(1, 1), warnings: [] };
  } });
  const chat = withModelCallSource("chat", () => observeLanguageModel(rateLimited, CHAT_MODEL_REF, () => rateLimited));
  await chat.doGenerate({ prompt: userPrompt });
  assert.equal(calls, 3); assert.deepEqual(waits, [0, 0], "Retry-After: 0 is honoured instead of the backoff");
  assert.deepEqual((await db.modelRequest.findMany({ orderBy: { createdAt: "asc" } })).map(row => row.status), ["error", "error", "success"]);

  calls = 0;
  const invalid = new MockLanguageModelV3({ doGenerate: async () => { calls++; throw Object.assign(new Error("bad request"), { statusCode: 400 }); } });
  await assert.rejects(async () => withModelCallSource("chat", () => observeLanguageModel(invalid, CHAT_MODEL_REF, () => invalid)).doGenerate({ prompt: userPrompt }));
  assert.equal(calls, 1);

  calls = 0;
  const unavailable = new MockLanguageModelV3({ doGenerate: async () => { calls++; throw Object.assign(new Error("unavailable"), { statusCode: 503 }); } });
  await assert.rejects(async () => withModelCallSource("scheduled", () => observeLanguageModel(unavailable, CHAT_MODEL_REF, () => unavailable)).doGenerate({ prompt: userPrompt }));
  assert.equal(calls, 1, "background attempts each spend the daily allowance");

  const { retryDelay, MAX_RETRY_DELAY_MS } = await import("@/lib/models/model-retry");
  assert.deepEqual([0, 1].map(retries => retryDelay(Object.assign(new Error("slow down"), { statusCode: 429 }), retries)), [500, 1000], "without Retry-After the backoff grows");
  assert.equal(retryDelay(Object.assign(new Error("slow down"), { statusCode: 429, responseHeaders: { "retry-after": String(MAX_RETRY_DELAY_MS / 1000 + 1) } }), 0), null, "a longer requested wait is not held");
  assert.equal(retryDelay(Object.assign(new Error("missing"), { statusCode: 404 }), 0), null);
  assert.equal(retryDelay(Object.assign(new Error("down"), { statusCode: 503 }), 2), null, "retries are bounded");
});

test("a streamed call ends when the provider goes quiet, not after a fixed total", async () => {
  const { streamDeadline } = await import("@/lib/models/call-deadlines");
  const deadline = streamDeadline(undefined, 50, 10_000);
  for (let i = 0; i < 4; i++) { await new Promise(resolve => setTimeout(resolve, 30)); deadline.touch(); }
  assert.equal(deadline.signal.aborted, false, "steady chunks keep a call alive past the idle window");
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(deadline.signal.aborted, true);
  assert.equal((deadline.signal.reason as DOMException).name, "TimeoutError");
  deadline.dispose();
  const cancelled = new AbortController(), linked = streamDeadline(cancelled.signal, 1000, 10_000);
  cancelled.abort(); assert.equal(linked.signal.aborted, true); linked.dispose();
});
