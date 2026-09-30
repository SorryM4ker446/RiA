import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import type { UIMessage } from "ai";
import { createTestDatabase } from "../helpers/database";
import { CHAT_MODEL_REF } from "../helpers/model-library";
import type { ChatRequest } from "@/lib/chat/request";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { encodePersistedAssistantToolMessage, decodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
const { saveChatMessage, claimToolApproval } = await import("@/lib/chat/store");
const { prepareChatPersistence } = await import("@/lib/chat/persistence");
const { startRun, finishRun, checkRunAllowance, reconcileInterruptedRuns, recordStep } = await import("@/lib/agent/runs");
const { saveMemory } = await import("@/lib/memory/store");
const { reindexStaleEmbeddings, currentEmbeddingRef } = await import("@/lib/memory/reindex");
const { defaultModelPreferences } = await import("@/lib/models/preferences-schema");

const EMBEDDING_REF = { providerId: "openrouter", modelId: "test-embedding-v1" } as const;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function seedEmbeddingPreference() {
  const settings = defaultModelPreferences();
  settings.embedding = EMBEDDING_REF;
  settings.library = [{
    ...EMBEDDING_REF,
    name: "Test embedding",
    description: "Test model",
    modes: ["embedding"],
    supportsImageInput: false,
    endpointImageInput: null,
    supportsTools: false,
    contextLength: null,
    pricing: {},
    addedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  }];
  await db.workspacePreference.upsert({ where: { id: "local" }, create: { id: "local", settings }, update: { settings } });
}

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  globalThis.__privateAiRateLimitStore.clear();
  await db.agentStep.deleteMany({});
  await db.agentRun.deleteMany({});
  await db.memory.deleteMany({});
  await db.message.deleteMany({});
  await db.chat.deleteMany({});
  await db.workspacePreference.deleteMany({});
});
after(async () => { await db.$disconnect(); cleanup(); });

test("a claim that lost the race leaves the winner's approval claimed", async () => {
  const chat = await db.chat.create({ data: { title: "Approval race" } });
  const approval = { id: "approval-race", approved: true };
  const input = { title: "Buy milk" };
  await saveChatMessage({
    chatId: chat.id,
    role: "assistant",
    content: encodePersistedAssistantToolMessage({
      type: "assistant-tool-message",
      text: "",
      tools: [{ toolName: "createTask", toolCallId: "call-1", state: "approval-requested", input, approval }],
    }),
    status: "success",
    clientMessageId: "assistant-1",
  });
  const decision: UIMessage = {
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "tool-createTask", toolCallId: "call-1", state: "approval-responded", input, approval }],
  };
  // Another request claims the same approval first and is executing the tool.
  await claimToolApproval(chat.id, decision);
  const request = {
    body: { messages: [decision] },
    messages: [decision],
    latestUserMessage: undefined,
    isApprovalResume: true,
    requestedChatId: chat.id,
    modelRef: CHAT_MODEL_REF,
  } as unknown as ChatRequest;

  await assert.rejects(() => prepareChatPersistence(request), /no longer pending/);

  const row = await db.message.findFirst({ where: { chatId: chat.id } });
  const persisted = decodePersistedAssistantToolMessage(row.content);
  assert.equal(
    persisted.tools[0].state,
    "approval-responded",
    "a losing claim must not hand the winner's approval back as pending, which would let the user approve and replay the same side effect",
  );
});

test("a refusal before the claim reaches its write still leaves the approval pending", async () => {
  const chat = await db.chat.create({ data: { title: "Approval refused" } });
  const approval = { id: "approval-refused", approved: true };
  const stored = { title: "Buy milk" };
  await saveChatMessage({
    chatId: chat.id,
    role: "assistant",
    content: encodePersistedAssistantToolMessage({
      type: "assistant-tool-message",
      text: "",
      tools: [{ toolName: "createTask", toolCallId: "call-1", state: "approval-requested", input: stored, approval }],
    }),
    status: "success",
    clientMessageId: "assistant-1",
  });
  // The client sends a decision whose input no longer matches the pending request.
  const decision: UIMessage = {
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "tool-createTask", toolCallId: "call-1", state: "approval-responded", input: { title: "Buy bread" }, approval }],
  };
  const request = {
    body: { messages: [decision] },
    messages: [decision],
    latestUserMessage: undefined,
    isApprovalResume: true,
    requestedChatId: chat.id,
    modelRef: CHAT_MODEL_REF,
  } as unknown as ChatRequest;

  await assert.rejects(() => prepareChatPersistence(request));

  const row = await db.message.findFirst({ where: { chatId: chat.id } });
  const persisted = decodePersistedAssistantToolMessage(row.content);
  assert.equal(persisted.tools[0].state, "approval-requested", "the user must still be able to retry the decision");
});

test("a run stopped for running out of time keeps that reason when the turn closes", async () => {
  const run = await startRun({ chatId: null, goal: "over time", budget: { deadlineMs: 1 } });
  await wait(5);
  assert.equal((await checkRunAllowance(run.id)).reason, "deadline-exceeded");

  // The turn then finishes normally and closes the run as a delivered answer.
  await finishRun(run.id, "succeeded");

  const stored = await db.agentRun.findUnique({ where: { id: run.id } });
  assert.equal(stored.status, "failed");
  assert.equal(stored.stopReason, "deadline-exceeded", "the recorded stop must not be rewritten by a later close");
});

test("a run that is still in flight is not reconciled as interrupted", async () => {
  const run = await startRun({ chatId: null, goal: "in flight" });
  await recordStep({ runId: run.id, position: 1, kind: "tool", toolName: "createTask" });

  assert.equal(await reconcileInterruptedRuns(), 0);

  const stored = await db.agentRun.findUnique({ where: { id: run.id } });
  assert.equal(stored.status, "running", "a run started by this process cannot be an orphan of a restart");
  assert.equal((await db.agentStep.findMany({ where: { runId: run.id } }))[0].state, "running");
});

test("a run left behind by an earlier process is still reconciled as interrupted", async () => {
  const run = await startRun({ chatId: null, goal: "left behind" });
  const step = await recordStep({ runId: run.id, position: 1, kind: "tool", toolName: "createTask" });
  await db.agentRun.update({ where: { id: run.id }, data: { startedAt: new Date(Date.now() - 3_600_000) } });

  assert.equal(await reconcileInterruptedRuns(), 1);

  const stored = await db.agentRun.findUnique({ where: { id: run.id } });
  assert.equal(stored.status, "paused");
  assert.equal(stored.stopReason, "interrupted-by-restart");
  assert.equal((await db.agentStep.findUnique({ where: { id: step.id } })).state, "cancelled");
});

test("an inference never takes the place of a memory the user accepted", async () => {
  const accepted = await saveMemory({ key: "tool:createTask:milk", value: "the user's own text" });
  assert.equal(accepted.confirmed, true);

  await saveMemory({ key: "tool:createTask:milk", value: "the assistant's summary", source: "assistant" });

  const stored = await db.memory.findUnique({ where: { key: "tool:createTask:milk" } });
  assert.equal(stored.value, "the user's own text", "a confirmed memory is not silently replaced");
  assert.equal(stored.source, "manual");
  assert.equal(stored.confirmed, true, "the entry stays what the user accepted, so the inference never enters the model's context as it");
});

test("a candidate stays a candidate until it is written by hand", async () => {
  const candidate = await saveMemory({ key: "tool:createTask:bread", value: "first inference", source: "assistant" });
  assert.equal(candidate.confirmed, false);

  const later = await saveMemory({ key: "tool:createTask:bread", value: "second inference", source: "assistant" });
  assert.equal(later.value, "second inference", "an unaccepted candidate is still the assistant's to rewrite");
  assert.equal(later.confirmed, false);

  const accepted = await saveMemory({ key: "tool:createTask:bread", value: "what the user typed" });
  assert.equal(accepted.confirmed, true);
  assert.equal(accepted.source, "manual");
});

test("a rebuild reaches a memory older than one pass of rows", async () => {
  const smoke = process.env.DESKTOP_SMOKE_TEST;
  process.env.DESKTOP_SMOKE_TEST = "1";
  try {
    await seedEmbeddingPreference();
    assert.deepEqual(await currentEmbeddingRef(), EMBEDDING_REF);
    // One row written before the embedding model changed, so it is stale.
    const stale = await db.memory.create({
      data: { key: "oldest", value: "written by another model", confirmed: true, embeddingModelId: "previous-model", embeddingModelProvider: "openrouter", embedding: [0.5, 0.5] },
    });
    await wait(20);
    // A thousand newer rows that already carry this model's vector push it out
    // of a recency window, so only selecting stale rows can still reach it.
    await db.memory.createMany({
      data: Array.from({ length: 1000 }, (_, index) => ({
        key: `fresh-${index}`,
        value: `fresh value ${index}`,
        confirmed: true,
        embeddingModelId: EMBEDDING_REF.modelId,
        embeddingModelProvider: EMBEDDING_REF.providerId,
        embedding: [0.1, 0.2],
      })),
    });

    const result = await reindexStaleEmbeddings();
    assert.equal(result.reindexed, 1, "the stale row is reachable regardless of how many fresher rows exist");

    const stored = await db.memory.findUnique({ where: { id: stale.id } });
    assert.notEqual(stored.embeddingModelId, "previous-model");
    assert.ok(Array.isArray(stored.embedding), "the row is embedded again");
  } finally {
    if (smoke === undefined) delete process.env.DESKTOP_SMOKE_TEST;
    else process.env.DESKTOP_SMOKE_TEST = smoke;
  }
});
