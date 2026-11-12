import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { createTestDatabase } from "../helpers/database";
import { seedTestModelPreferences, CHAT_MODEL_REF } from "../helpers/model-library";
import { localAccessCookie } from "../helpers/local-access";
import { languageModel } from "../helpers/model-provider";

const cleanup = createTestDatabase();
process.env.RIA_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const { createChatToolSet } = await import("@/tools/catalog");
const { startRun } = await import("@/lib/agent/runs");
const { indexDocument } = await import("@/lib/documents/store");
const { searchDocuments } = await import("@/lib/documents/retrieval");
const { updateConversation } = await import("@/lib/conversations/mutations");
const { executeRegisteredTool, getToolDescriptor } = await import("@/tools/catalog");
const { encodeDocumentScope, decodeDocumentScope } = await import("@/lib/documents/scope");
const { summarizeOlderTurns } = await import("@/lib/chat/summary");
const { observeLanguageModel } = await import("@/lib/models/observe-language");
const { removeModel, getModelPreferences, withModelSettingsLock } = await import("@/lib/models/preferences");

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  globalThis.__riaRateLimitStore?.clear();
  await db.chat.deleteMany({});
  await db.agentRun.deleteMany({});
  await db.scheduledJob.deleteMany({});
  await db.memory.deleteMany({});
  await db.knowledgeDocument.deleteMany({});
  await seedTestModelPreferences(db);
  process.env.OPENROUTER_API_KEY = "offline-test-key";
});
after(async () => { await db.$disconnect(); cleanup(); });

const options = {} as never;
test("with memory off the model cannot extract notes, while saving to the knowledge base still works", async () => {
  const tools = await createChatToolSet({ usesMemory: false, toolIds: ["saveKnowledgeEntry"] });
  assert.ok(tools.saveKnowledgeEntry);
  assert.equal(tools.extractMemory, undefined);
  await executeRegisteredTool(getToolDescriptor("saveKnowledgeEntry")!, { key: "reference", value: "a fact to look up" }, { trigger: "manual", usesMemory: false });
  assert.equal(await db.memory.count(), 1);
});

test("parallel tool sets share one atomic step budget", async () => {
  const run = await startRun({ chatId: null, goal: "One task", budget: { maxSteps: 1 } });
  const [first, second] = await Promise.all([1, 2].map(() => createChatToolSet({ runId: run.id, toolIds: ["createTask"] })));
  await Promise.all([first.createTask.execute!({ title: "First", prompt: "Do it.", cron: "0 9 * * *", timeZone: "UTC" }, options), second.createTask.execute!({ title: "Second", prompt: "Do it.", cron: "0 9 * * *", timeZone: "UTC" }, options)]);
  assert.equal(await db.agentStep.count({ where: { runId: run.id } }), 1);
  assert.equal(await db.scheduledJob.count(), 1);
});

test("a failed budget reservation cannot execute a task", async () => {
  const run = await startRun({ chatId: null, goal: "No unrecorded writes" });
  const tools = await createChatToolSet({ runId: run.id, toolIds: ["createTask"] });
  const transaction = db.$transaction;
  db.$transaction = async () => { throw new Error("Database reservation unavailable"); };
  try { await tools.createTask.execute!({ title: "Must not exist", prompt: "Do it.", cron: "0 9 * * *", timeZone: "UTC" }, options); }
  finally { db.$transaction = transaction; }
  assert.equal(await db.scheduledJob.count(), 0);
  assert.equal(await db.agentStep.count({ where: { runId: run.id } }), 0);
});

test("only a template narrows what a conversation searches", async () => {
  const { conversationCollections } = await import("@/lib/conversations/document-scope");
  const { updateConversationSchema } = await import("@/lib/conversations/mutations");
  const template = { templateId: "t", templateRevision: 1, name: "Scoped", description: "", instructions: "Help.", model: null, tools: ["searchKnowledge"], collections: ["医疗"], usesMemory: true };
  assert.deepEqual(conversationCollections({ assistantConfig: template }), ["医疗"]);
  assert.deepEqual(conversationCollections({ assistantConfig: null }), [], "without a template, the whole library");
  for (const documentScope of [["财务"], "财务", ""]) {
    assert.equal(updateConversationSchema.safeParse({ documentScope }).success, false, "a conversation has no scope of its own to set");
  }
});

test("collection names with separators remain exact across scope encoding and retrieval", async () => {
  await indexDocument({ filename: "exact.txt", collection: "A|B", format: "txt", byteSize: 10, pages: [{ pageNumber: null, text: "scopedneedle" }] });
  await indexDocument({ filename: "outside.txt", collection: "A", format: "txt", byteSize: 10, pages: [{ pageNumber: null, text: "scopedneedle" }] });
  const stored = encodeDocumentScope(["A|B"]);
  assert.deepEqual(decodeDocumentScope(stored), ["A|B"]);
  assert.deepEqual((await searchDocuments("scopedneedle", 4, decodeDocumentScope(stored))).map(item => item.filename), ["exact.txt"]);
  assert.deepEqual(decodeDocumentScope("A|B"), ["A", "B"]);
  assert.deepEqual(decodeDocumentScope(encodeDocumentScope(["|scope:v1|", 'quote"\\name', "中文|资料"])), ['quote"\\name', "|scope:v1|", "中文|资料"].sort());
  assert.deepEqual(decodeDocumentScope(encodeDocumentScope([])), []);
});

test("retrying the same long conversation reuses its cached summary without a model call", async () => {
  const messages = Array.from({ length: 44 }, (_, index) => ({ id: `summary-${index}`, role: index % 2 ? "assistant" : "user", text: `text ${index}` }));
  const chat = await db.chat.create({ data: { title: "Summary reuse", summary: "Keep the original decision", summaryUpToMessageId: "summary-19", summaryModelId: "openrouter:summary-model", summaryRevision: 0 } });
  await db.message.createMany({ data: messages.map((message, index) => ({ id: message.id, chatId: chat.id, role: message.role as "user" | "assistant", content: message.text, createdAt: new Date(index * 1000) })) });
  const calls = languageModel.doGenerateCalls.length;
  const result = await summarizeOlderTurns({ chatId: chat.id, messages, keepRecent: 24 });
  assert.deepEqual(result, { summary: chat.summary, upToMessageId: "summary-19", modelId: "summary-model" });
  assert.equal(languageModel.doGenerateCalls.length, calls);
});

for (const outcome of ["end", "error", "cancel"] as const) {
  test(`model removal waits for a stream and releases its lease on ${outcome}`, { timeout: 10_000 }, async () => {
    let controller!: ReadableStreamDefaultController<LanguageModelV3StreamPart>;
    let cancelled = false;
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: new ReadableStream<LanguageModelV3StreamPart>({
      start(value) { controller = value; value.enqueue({ type: "text-start", id: "t" }); value.enqueue({ type: "text-delta", id: "t", delta: "In progress" }); },
      cancel() { cancelled = true; },
    }) }) });
    const result = await observeLanguageModel(model, CHAT_MODEL_REF, () => model).doStream({ prompt: [] });
    const removal = removeModel(CHAT_MODEL_REF);
    await withModelSettingsLock(async () => {});
    assert.ok((await getModelPreferences()).chat.model);
    if (outcome === "cancel") {
      await result.stream.cancel();
      assert.equal(cancelled, true);
    } else {
      const consuming = (async () => { for await (const _part of result.stream) { /* Consume the provider stream to termination. */ } })();
      if (outcome === "error") {
        controller.error(new Error("Stream failed"));
        await assert.rejects(consuming, /Stream failed/);
      } else {
        controller.close();
        await consuming;
      }
    }
    await removal;
    assert.equal((await getModelPreferences()).chat.model, null);
  });
}

test("provider submission failure releases the model lease", async () => {
  const model = new MockLanguageModelV3({ doStream: async () => { throw new Error("Provider unavailable"); } });
  await assert.rejects(async () => await observeLanguageModel(model, CHAT_MODEL_REF, () => model).doStream({ prompt: [] }), /Provider unavailable/);
  await removeModel(CHAT_MODEL_REF);
});
