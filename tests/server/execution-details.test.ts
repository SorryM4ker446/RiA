import assert from "node:assert/strict";
import { test, beforeEach, after, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { seedTestModelPreferences, CHAT_MODEL_REF } from "../helpers/model-library";
import { languageModel, resetProviderState } from "../helpers/model-provider";
const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const chatRoute = await import("@/app/api/chat/route");
const runRoute = await import("@/app/api/conversations/[id]/runs/route");
const { decodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
const { mapStoredMessagesToUI } = await import("@/features/chat/page-utils");
const { createChat } = await import("@/lib/chat/store");
const { saveAssistant } = await import("@/lib/assistants/store");
const { assistantConfigSchema } = await import("@/lib/assistants/schema");
const { encodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
const { prepareChatPersistence, persistChatResponse } = await import("@/lib/chat/persistence");
const { listRuns } = await import("@/lib/agent/runs");
const { executionEntries } = await import("@/features/chat/execution-entries");
const request = (url: string, method = "GET", body?: unknown, auth = localAccessCookie()) => new NextRequest(`http://localhost${url}`, { method, headers: { cookie: auth, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {});
  globalThis.__privateAiRateLimitStore?.clear(); resetProviderState();
  process.env.OPENROUTER_API_KEY = "offline-key"; process.env.DEEPSEEK_API_KEY = ""; process.env.TAVILY_API_KEY = "";
  await db.chat.deleteMany({}); await db.agentRun.deleteMany({}); await seedTestModelPreferences(db);
});
after(async () => { await db.$disconnect(); cleanup(); });

test("execution details use the persisted server run identity after reload and reject cross-conversation access", async () => {
  const conversation = await createChat({ title: "Record details" });
  const response = await chatRoute.POST(request("/api/chat", "POST", { chatId: conversation.id, model: CHAT_MODEL_REF, messages: [{ id: "user-detail", role: "user", metadata: { runId: "forged-run" }, parts: [{ type: "text", text: "Hello" }] }] }));
  assert.equal(response.status, 200); const stream = await response.text();
  const saved = await db.message.findFirstOrThrow({ where: { chatId: conversation.id, role: "assistant" } });
  const payload = decodePersistedAssistantToolMessage(saved.content)!;
  assert.ok(payload.runId); assert.notEqual(payload.runId, "forged-run");
  assert.match(stream, new RegExp(payload.runId));
  const run = await db.agentRun.findUniqueOrThrow({ where: { id: payload.runId } });
  assert.equal(run.chatId, conversation.id);
  const get = (chatId: string, runId: string, auth?: string) => runRoute.GET(request(`/api/conversations/${chatId}/runs?runId=${runId}`, "GET", undefined, auth), { params: Promise.resolve({ id: chatId }) });
  const details = await get(conversation.id, run.id);
  assert.equal(details.status, 200); assert.match(details.headers.get("cache-control")!, /no-store/);
  const restored = mapStoredMessagesToUI([(await details.json()).data]).uiMessages[0];
  assert.equal((restored.metadata as any).runId, run.id);
  assert.equal((restored.metadata as any).modelLabel, `${CHAT_MODEL_REF.providerId}/${CHAT_MODEL_REF.modelId}`);
  const other = await createChat({ title: "Another" });
  assert.equal((await get(other.id, run.id)).status, 404);
  assert.equal((await get(conversation.id, run.id, "")).status, 401);
  assert.equal((await get(conversation.id, "invalid%22id")).status, 400);
});

test("a template with no tools is described as template-disabled, while configured provider search is never reported as missing Tavily", async () => {
  for (const restricted of [false, true]) {
    const template = restricted ? await saveAssistant(assistantConfigSchema.parse({ name: "No tools", instructions: "Be helpful", tools: [] })) : null;
    const conversation = await createChat({ title: "Prompt status", ...(template ? { assistantTemplateId: template.id } : {}) });
    const response = await chatRoute.POST(request("/api/chat", "POST", { chatId: conversation.id, model: CHAT_MODEL_REF, messages: [{ id: `user-${restricted}`, role: "user", parts: [{ type: "text", text: "Hello" }] }] }));
    assert.equal(response.status, 200); await response.text();
    const prompt = JSON.stringify(languageModel.doStreamCalls.at(-1)?.prompt);
    assert.doesNotMatch(prompt, /webSearch is not configured/);
    if (restricted) assert.match(prompt, /webSearch is disabled by the current assistant template/);
    else assert.doesNotMatch(prompt, /Capability status \(internal context\): webSearch/);
  }
});

test("approval continuations retain every server run link and display one request after reload", async () => {
  const chat = await createChat({ title: "One request" });
  const first = await db.agentRun.create({ data: { chatId: chat.id, goal: "Create task", status: "succeeded", finishedAt: new Date() } });
  const stored = await db.message.create({ data: { chatId: chat.id, role: "assistant", clientMessageId: "approval-message", content: encodePersistedAssistantToolMessage({
    type: "assistant-tool-message", text: "Review", runId: first.id,
    tools: [{ toolName: "createTask", toolCallId: "task-call", state: "approval-requested", input: { title: "Reviewed task" }, approval: { id: "task-approval" } }],
  }) } });
  const decision = mapStoredMessagesToUI([stored]).uiMessages[0];
  decision.metadata = { runId: "forged-run", runIds: ["forged-run"] };
  Object.assign(decision.parts.find(part => "toolCallId" in part)!, { state: "approval-responded", approval: { id: "task-approval", approved: true } });
  const input = { body: { messages: [decision] }, messages: [decision], requestedChatId: chat.id, isApprovalResume: true, modelRef: CHAT_MODEL_REF } as never;
  const conversation = await prepareChatPersistence(input);
  assert.deepEqual(conversation.previousRunIds, [first.id]);
  const second = await db.agentRun.create({ data: { chatId: chat.id, goal: "Create task", status: "succeeded", finishedAt: new Date() } });
  await persistChatResponse({ input, conversation, responseMessage: { ...decision, parts: [{ type: "text", text: "Done" }] }, isAborted: false, generationFailed: false, runId: second.id, usesMemory: false });
  const reply = await db.message.findUniqueOrThrow({ where: { id: stored.id } });
  const payload = decodePersistedAssistantToolMessage(reply.content)!;
  assert.deepEqual(payload.runIds, [first.id, second.id]);
  assert.equal(payload.runId, second.id);
  const runs = await listRuns(chat.id);
  assert.ok(runs.every(run => run.messageId === "approval-message"));
  const entries = executionEntries(runs, mapStoredMessagesToUI([reply]).uiMessages);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].stages, 2);
  for (const run of [first, second]) {
    const response = await runRoute.GET(request(`/api/conversations/${chat.id}/runs?runId=${run.id}`), { params: Promise.resolve({ id: chat.id }) });
    assert.equal((await response.json()).data.id, reply.id);
  }
});

async function legacyRequest() {
  const chat = await createChat({ title: "Legacy" });
  const time = (seconds: number) => new Date(Date.now() - 60_000 + seconds * 1000);
  await db.message.create({ data: { chatId: chat.id, role: "user", content: "Read the file", createdAt: time(1) } });
  const run = await db.agentRun.create({ data: { chatId: chat.id, goal: "Read the file", status: "succeeded", startedAt: time(2), finishedAt: time(3), steps: { create: { position: 1, kind: "tool", toolName: "readLocalFile", state: "done", input: "notes.txt", output: "Saved summary", finishedAt: time(3) } } } });
  const reply = await db.message.create({ data: { chatId: chat.id, role: "assistant", clientMessageId: "legacy-answer", createdAt: time(4), content: encodePersistedAssistantToolMessage({ type: "assistant-tool-message", text: "Read", tools: [{ toolName: "readLocalFile", toolCallId: "legacy-read", state: "output-available", input: { path: "notes.txt" }, output: { content: "Saved file content" } }] }) } });
  return { chat, run, reply, time };
}

test("an unambiguous legacy request joins its saved file details without duplicating the row", async () => {
  const { chat, run, reply } = await legacyRequest();
  const runs = await listRuns(chat.id);
  assert.equal(runs[0].messageId, "legacy-answer");
  const entries = executionEntries(runs, mapStoredMessagesToUI([reply]).uiMessages);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].message?.parts.some(part => "output" in part), true);
  const response = await runRoute.GET(request(`/api/conversations/${chat.id}/runs?runId=${run.id}`), { params: Promise.resolve({ id: chat.id }) });
  assert.equal((await response.json()).data.id, reply.id);
});

test("ambiguous old runs never attach a regenerated answer based on matching titles", async () => {
  const { chat, run, time } = await legacyRequest();
  await db.agentRun.create({ data: { chatId: chat.id, goal: run.goal, status: "succeeded", startedAt: time(3), finishedAt: time(4) } });
  assert.ok((await listRuns(chat.id)).every(row => row.messageId === undefined));
  const response = await runRoute.GET(request(`/api/conversations/${chat.id}/runs?runId=${run.id}`), { params: Promise.resolve({ id: chat.id }) });
  assert.equal((await response.json()).data, null);
});

test("missing full messages still expose saved redacted step summaries", async () => {
  const { chat, reply } = await legacyRequest();
  await db.message.delete({ where: { id: reply.id } });
  const [run] = await listRuns(chat.id);
  assert.equal(run.messageId, undefined);
  assert.equal(run.steps[0].input, "notes.txt");
  assert.equal(run.steps[0].output, "Saved summary");
});
