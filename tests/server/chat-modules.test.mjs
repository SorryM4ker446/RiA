import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { createTestDatabase } from "../helpers/database.mjs";
import { languageModel } from "../helpers/model-provider.mjs";

const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const { getRelevantMemories } = await import("@/lib/memory/store");
const { searchKnowledge } = await import("@/tools/definitions/search-knowledge");
const { tokenizeQuery, scoreMemory, rankByScore, CONTEXT_MEMORY_POLICY, KNOWLEDGE_MEMORY_POLICY } = await import("@/lib/memory/retrieval");
const { detectAutoToolIntent } = await import("@/lib/chat/tool-intent");
const { getDefaultChatPreferences, readChatPreferences } = await import("@/features/chat/preferences");
const { buildDefaultManualFieldValues, validateManualToolFields, normalizeManualToolInput } = await import("@/features/chat/tool-input");
after(async () => { await db.$disconnect(); cleanup(); });

test("memory ranking preserves lexical, semantic, recency and manual weighting", () => {
  const now = Date.parse("2026-08-30T00:00:00Z");
  const memory = { key: "SQLite", value: "本地数据库", score: 0.5, embedding: [1, 0], updatedAt: new Date(now) };
  const tokens = tokenizeQuery("SQLITE / 本地数据库");
  assert.equal(tokens[0], "sqlite");
  assert.equal(tokens.slice(1).join(""), "本地数据库");
  assert.ok(tokens.length > 2);
  assert.equal(scoreMemory(memory, ["sqlite"], null, CONTEXT_MEMORY_POLICY, now), 1.4);
  assert.equal(scoreMemory(memory, ["sqlite"], null, KNOWLEDGE_MEMORY_POLICY, now), 1.1);
  assert.equal(scoreMemory(memory, ["unmatched"], [1, 0], KNOWLEDGE_MEMORY_POLICY, now), 0.95);
  assert.equal(scoreMemory({ ...memory, embedding: null, score: null, updatedAt: new Date(now - 31 * 86400000) }, ["unmatched"], [1, 0], CONTEXT_MEMORY_POLICY, now), 0);
  const rows = [{ id: "first", score: 1 }, { id: "zero", score: 0 }, { id: "second", score: 1 }, { id: "high", score: 2 }];
  assert.deepEqual(rankByScore(rows, (row) => row.score, 3).map((row) => row.id), ["high", "first", "second"]);
  assert.equal(rows[0].id, "first");
});

test("Chinese retrieval segments natural queries and recalls older lexical matches", async () => {
  const user = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  const target = await db.memory.create({ data: { userId: user.id, key: "旅行偏好", value: "云南徒步路线", score: 0.5, updatedAt: new Date("2020-01-01T00:00:00Z") } });
  await db.memory.createMany({ data: Array.from({ length: 110 }, (_, i) => ({ userId: user.id, key: `other-${i}`, value: "unrelated programming notes", score: 1 })) });
  const query = "请帮我查找云南徒步路线";
  assert.equal((await getRelevantMemories({ userId: user.id, query }))[0].id, target.id);
  assert.equal((await searchKnowledge(user.id, { query, topK: 4 })).results[0].id, target.id);
  assert.deepEqual(tokenizeQuery("ＳＱＬＩＴＥ SQLite 数据库 数据库"), tokenizeQuery("sqlite 数据库"));
  assert.deepEqual(await getRelevantMemories({ userId: user.id, query: "！！！" }), []);
});

test("ranking computes each score once and keeps ties stable", () => {
  let calls = 0;
  const items = [{ id: "one", score: 1 }, { id: "two", score: 1 }, { id: "invalid", score: NaN }];
  const result = rankByScore(items, (item) => { calls += 1; return item.score; }, 3);
  assert.equal(calls, items.length);
  assert.deepEqual(result.map((row) => row.id), ["one", "two"]);
});

test("shared retrieval keeps user isolation and distinct context versus knowledge candidates", async () => {
  const user = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  const other = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  const old = new Date("2020-01-01T00:00:00Z");
  await db.memory.createMany({ data: [
    { userId: user.id, key: "sqlite-note", value: "sqlite local", score: 0.5, updatedAt: old },
    { userId: user.id, key: "tool:sqlite", value: "sqlite tool record", score: 1, updatedAt: old },
    { userId: user.id, key: "unrelated", value: "other topic", score: 0, updatedAt: old },
    { userId: other.id, key: "sqlite-private", value: "another user's memory", score: 1, updatedAt: old },
  ] });
  assert.deepEqual((await getRelevantMemories({ userId: user.id, query: "sqlite" })).map((row) => row.key), ["tool:sqlite", "sqlite-note"]);
  const result = await searchKnowledge(user.id, { query: " sqlite ", topK: 8 });
  assert.equal(result.query, "sqlite");
  assert.deepEqual(result.results.map((row) => [row.title, row.score]), [["sqlite-note", 1.1]]);
  const builtin = await searchKnowledge(other.id, { query: "short-term", topK: 8 });
  assert.ok(builtin.results.some((row) => row.id === "builtin-memory"));
  assert.deepEqual(await getRelevantMemories({ userId: user.id, query: " " }), []);
});

test("automatic tool intent requires explicit action, an available tool and sufficient confidence", async (t) => {
  t.mock.method(console, "warn", () => {});
  const autoTools = [{ id: "createTask", description: "Create task", auto: { intentHint: "explicit request" } }];
  let output = { intent: "createTask", shouldUseToolNow: true, userRequestMode: "explicit-action", confidence: 0.9, expectedBenefit: 0.9 };
  const generate = t.mock.method(languageModel, "doGenerate", async () => ({
    content: [{ type: "text", text: JSON.stringify(output) }],
    finishReason: { unified: "stop", raw: undefined },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [],
  }));
  const params = { text: "Create a task", modelId: "test-model", autoTools };
  assert.equal(await detectAutoToolIntent(params), "createTask");
  const accepted = { ...output };
  for (const rejected of [{ intent: "unavailable" }, { shouldUseToolNow: false }, { userRequestMode: "topic-question" }, { userRequestMode: "ambiguous" }, { confidence: 0.71 }, { expectedBenefit: 0.59 }]) {
    output = { ...accepted, ...rejected };
    assert.equal(await detectAutoToolIntent(params), null);
  }
  const calls = generate.mock.callCount();
  assert.equal(await detectAutoToolIntent({ ...params, text: " " }), null);
  assert.equal(await detectAutoToolIntent({ ...params, autoTools: [] }), null);
  assert.equal(generate.mock.callCount(), calls);
});

test("per-conversation preferences normalize stale models and malformed storage", (t) => {
  let raw = "{";
  globalThis.window = { localStorage: { getItem: () => raw } };
  t.after(() => { delete globalThis.window; });
  assert.equal(readChatPreferences("conversation"), null);
  raw = JSON.stringify({ modelMode: "invalid", selectedChatModel: "removed-model", manualToolsOnly: true });
  assert.deepEqual(readChatPreferences("conversation"), { ...getDefaultChatPreferences(), manualToolsOnly: true });
});

test("manual tool fields preserve defaults, numeric bounds and normalized input", () => {
  const tool = { manual: { primaryFieldKey: "query", fields: [{ key: "topK", type: "number", required: true, min: 1, max: 8, defaultValue: "4" }] } };
  assert.deepEqual(buildDefaultManualFieldValues(tool), { topK: "4" });
  assert.deepEqual(validateManualToolFields(tool, { topK: "9" }), { topK: "最大值为 8" });
  assert.deepEqual(validateManualToolFields(tool, { topK: "abc" }), { topK: "请输入有效数字" });
  assert.deepEqual(normalizeManualToolInput({ tool, text: "SQLite", fieldValues: {} }), { query: "SQLite", topK: 4 });
});
