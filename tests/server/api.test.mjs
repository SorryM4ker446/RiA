import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database.mjs";
import { languageModel, providerState } from "../helpers/model-provider.mjs";

const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";

const { db } = await import("@/db");
const { createSession } = await import("@/lib/auth/session");
const { saveMemory } = await import("@/lib/memory/store");
const { getRegenerationSnapshot, saveRegeneratedResponse, saveChatMessage } = await import("@/lib/chat/store");
const { ApiError } = await import("@/lib/server/api-error");
const { encodePersistedAssistantToolMessage, decodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
const { getToolDescriptor } = await import("@/tools/catalog");
const chat = await import("@/app/api/chat/route");
const tools = await import("@/app/api/tools/run/route");
const conversations = await import("@/app/api/conversations/route");
const conversation = await import("@/app/api/conversations/[id]/route");
const messages = await import("@/app/api/conversations/[id]/messages/route");
const messageRoute = await import("@/app/api/conversations/[id]/messages/[messageId]/route");
const taskRoute = await import("@/app/api/tasks/[id]/route");
const knowledge = await import("@/app/api/knowledge/route");
const knowledgeEntry = await import("@/app/api/knowledge/[id]/route");
const register = await import("@/app/api/auth/register/route");
const login = await import("@/app/api/auth/login/route");
const logout = await import("@/app/api/auth/logout/route");
const me = await import("@/app/api/auth/me/route");

function request(path, method = "GET", body, cookie) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const context = (id, messageId) => ({ params: Promise.resolve({ id, messageId }) });
const uiMessage = (id, role, text) => ({ id, role, parts: [{ type: "text", text }] });

let user;
let cookie;
beforeEach(async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "info", () => {});
  process.env.OPENROUTER_API_KEY = "";
  providerState.streamError = false;
  providerState.streamGate = undefined;
  user = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  cookie = `app_session=${await createSession(user.id)}`;
});
after(async () => { await db.$disconnect(); cleanup(); });

test("chat authenticates before exposing configuration or parsing a body", async () => {
  const response = await chat.POST(new NextRequest("http://localhost/api/chat", { method: "POST", body: "invalid-json" }));
  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.error.code, "UNAUTHORIZED");
  assert.equal(JSON.stringify(payload).includes("OPENROUTER"), false);
});

test("registration, login and logout use real persisted sessions", async () => {
  const credentials = { email: `${randomUUID()}@example.invalid`, password: randomUUID() };
  const created = await register.POST(request("/api/auth/register", "POST", credentials));
  assert.equal(created.status, 201);
  const registered = (await created.json()).data;
  const stored = await db.user.findUnique({ where: { id: registered.id } });
  assert.notEqual(stored.passwordHash, credentials.password);
  const signedIn = await login.POST(request("/api/auth/login", "POST", credentials));
  assert.equal(signedIn.status, 200);
  const sessionCookie = signedIn.headers.get("set-cookie").split(";")[0];
  assert.equal((await me.GET(request("/api/auth/me", "GET", undefined, sessionCookie))).status, 200);
  await logout.POST(request("/api/auth/logout", "POST", {}, sessionCookie));
  assert.equal((await me.GET(request("/api/auth/me", "GET", undefined, sessionCookie))).status, 401);
});

test("manual task execution persists data and emits one success log", async () => {
  const response = await tools.POST(request("/api/tools/run", "POST", { tool: "createTask", mode: "chat", input: { title: "Integration task" } }, cookie));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal((await db.task.findUnique({ where: { id: payload.data.taskId } })).userId, user.id);
  const logs = console.info.mock.calls.filter((call) => call.arguments[0] === "tool.execution");
  assert.deepEqual(logs.map((call) => call.arguments[1].state), ["output-available"]);
});

for (const code of ["TIMEOUT", "UPSTREAM_FAILED"]) {
  test(`manual ${code} execution emits only one failure log`, async (t) => {
    t.mock.method(getToolDescriptor("createTask"), "execute", async () => { throw new ApiError({ code, message: "Simulated failure" }); });
    const response = await tools.POST(request("/api/tools/run", "POST", { tool: "createTask", mode: "chat", input: { title: "Must not exist" } }, cookie));
    assert.equal(response.status, code === "TIMEOUT" ? 504 : 502);
    assert.equal(await db.task.count({ where: { userId: user.id } }), 0);
    const logs = console.info.mock.calls.filter((call) => call.arguments[0] === "tool.execution");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].arguments[1].state, "output-error");
    assert.equal(logs[0].arguments[1].errorCode, code);
  });
}

test("invalid tool input never emits a success record", async () => {
  const response = await tools.POST(request("/api/tools/run", "POST", { tool: "createTask", mode: "chat", input: { title: "" } }, cookie));
  assert.equal(response.status, 400);
  const logs = console.info.mock.calls.filter((call) => call.arguments[0] === "tool.execution");
  assert.deepEqual(logs.map((call) => call.arguments[1].state), ["output-error"]);
});

test("conversation, message, task and knowledge APIs enforce user ownership", async () => {
  const response = await conversations.POST(request("/api/conversations", "POST", { title: "Private" }, cookie));
  const ownedChat = (await response.json()).data;
  const savedMessage = await messages.POST(request("/api/messages", "POST", { role: "user", content: "Private text", clientMessageId: "client-1" }, cookie), context(ownedChat.id));
  assert.equal(savedMessage.status, 201);
  const row = (await savedMessage.json()).data;
  const task = await db.task.create({ data: { userId: user.id, title: "Private task" } });
  const entry = await knowledge.POST(request("/api/knowledge", "POST", { key: "Private", value: "Private fact" }, cookie));
  const entryId = (await entry.json()).data.id;
  const other = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  const otherCookie = `app_session=${await createSession(other.id)}`;
  assert.equal((await conversation.GET(request("/api/conversations", "GET", undefined, otherCookie), context(ownedChat.id))).status, 404);
  assert.equal((await conversation.DELETE(request("/api/conversations", "DELETE", undefined, otherCookie), context(ownedChat.id))).status, 404);
  assert.equal((await messageRoute.PATCH(request("/api/messages", "PATCH", { content: "stolen" }, otherCookie), context(ownedChat.id, row.id))).status, 404);
  assert.equal((await taskRoute.DELETE(request("/api/tasks", "DELETE", undefined, otherCookie), context(task.id))).status, 404);
  assert.equal((await knowledgeEntry.DELETE(request("/api/knowledge", "DELETE", undefined, otherCookie), context(entryId))).status, 404);
  process.env.OPENROUTER_API_KEY = "test-provider-placeholder";
  const forbidden = await chat.POST(request("/api/chat", "POST", { chatId: ownedChat.id, messages: [uiMessage("x", "user", "hello")] }, otherCookie));
  assert.equal(forbidden.status, 404);
  assert.equal(await db.message.count({ where: { chatId: ownedChat.id } }), 1);
});

test("concurrent memory saves share one row and clear stale embeddings", async () => {
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => saveMemory({ userId: user.id, key: "preference", value: `value ${index}`, score: 0.9 })));
  // A failed write must not leave the remaining writes running into the next test.
  for (const result of results) if (result.status === "rejected") throw result.reason;
  assert.equal(await db.memory.count({ where: { userId: user.id, key: "preference" } }), 1);
  await db.memory.update({ where: { userId_key: { userId: user.id, key: "preference" } }, data: { embedding: [1, 2] } });
  const updated = await saveMemory({ userId: user.id, key: "preference", value: "updated without embeddings" });
  assert.equal(updated.embedding, null);
  assert.equal(updated.score, 0.9);
});

test("assistant persistence updates the approval row instead of duplicating it", async () => {
  const owned = await db.chat.create({ data: { userId: user.id, title: "Approval" } });
  const pending = await saveChatMessage({ chatId: owned.id, role: "assistant", content: "Pending", clientMessageId: "approval-response" });
  const completed = await saveChatMessage({ chatId: owned.id, role: "assistant", content: "Completed", clientMessageId: "approval-response", updateExisting: true });
  assert.equal(completed.id, pending.id);
  assert.equal(completed.content, "Completed");
  assert.equal(await db.message.count({ where: { chatId: owned.id } }), 1);
});

async function seedConversation() {
  const owned = await db.chat.create({ data: { userId: user.id, title: "Regeneration" } });
  await saveChatMessage({ chatId: owned.id, role: "user", content: "Original question", clientMessageId: "u1" });
  await saveChatMessage({ chatId: owned.id, role: "assistant", content: "Original answer", clientMessageId: "a1" });
  return owned;
}

test("chat sends assistant history to the model and persists the streamed answer", async () => {
  const owned = await seedConversation();
  process.env.OPENROUTER_API_KEY = "test-provider-placeholder";
  const response = await chat.POST(request("/api/chat", "POST", { chatId: owned.id, manualToolsOnly: true, messages: [uiMessage("u1", "user", "Original question"), uiMessage("a1", "assistant", "Original answer"), uiMessage("u2", "user", "Explain that answer")] }, cookie));
  assert.equal(response.status, 200);
  await response.text();
  assert.ok(languageModel.doStreamCalls.at(-1).prompt.some((item) => item.role === "assistant" && item.content[0].text === "Original answer"));
  assert.equal(await db.message.count({ where: { chatId: owned.id, content: "Generated answer" } }), 1);
});

test("failed regeneration leaves the original answer intact", async () => {
  const owned = await seedConversation();
  providerState.streamError = true;
  process.env.OPENROUTER_API_KEY = "test-provider-placeholder";
  const response = await chat.POST(request("/api/chat", "POST", { chatId: owned.id, manualToolsOnly: true, trigger: "regenerate-message", messages: [uiMessage("u1", "user", "Original question")] }, cookie));
  await response.text();
  const rows = await db.message.findMany({ where: { chatId: owned.id } });
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => row.content === "Original answer"));
});

test("successful regeneration replaces old history only after the stream finishes", async () => {
  const owned = await seedConversation();
  let release;
  providerState.streamGate = new Promise((resolve) => { release = resolve; });
  process.env.OPENROUTER_API_KEY = "test-provider-placeholder";
  const response = await chat.POST(request("/api/chat", "POST", { chatId: owned.id, manualToolsOnly: true, trigger: "regenerate-message", messages: [uiMessage("u1", "user", "Original question")] }, cookie));
  assert.equal(await db.message.count({ where: { chatId: owned.id, content: "Original answer" } }), 1);
  release();
  await response.text();
  const rows = await db.message.findMany({ where: { chatId: owned.id } });
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => row.content === "Generated answer"));
  assert.equal(rows.some((row) => row.content === "Original answer"), false);
});

test("regeneration rejects concurrent edits without deleting any messages", async () => {
  const owned = await seedConversation();
  const snapshot = await getRegenerationSnapshot(user.id, owned.id, "u1");
  await saveChatMessage({ chatId: owned.id, role: "user", content: "Concurrent follow-up", clientMessageId: "u2" });
  await assert.rejects(saveRegeneratedResponse({ snapshot, userMessageId: "u1", clientMessageId: "replacement", content: "Replacement" }), (error) => error.code === "CONFLICT");
  assert.equal(await db.message.count({ where: { chatId: owned.id } }), 3);
});

for (const approved of [true, false]) {
  test(`tool approval ${approved ? "acceptance" : "denial"} survives persistence and cannot be replayed`, async () => {
    const owned = await seedConversation();
    const input = { title: "Approved task", priority: "medium" };
    const content = encodePersistedAssistantToolMessage({
      type: "assistant-tool-message", text: "Please approve",
      tools: [{ toolName: "createTask", toolCallId: "call-1", state: "approval-requested", input, approval: { id: "approval-1" } }],
    });
    await saveChatMessage({ chatId: owned.id, role: "assistant", content, clientMessageId: "pending-1" });
    const payload = { chatId: owned.id, messages: [
      uiMessage("u1", "user", "Original question"),
      uiMessage("a1", "assistant", "Original answer"),
      { id: "pending-1", role: "assistant", parts: [{ type: "tool-createTask", toolCallId: "call-1", state: "approval-responded", input, approval: { id: "approval-1", approved } }] },
    ] };
    process.env.OPENROUTER_API_KEY = "test-provider-placeholder";
    const response = await chat.POST(request("/api/chat", "POST", payload, cookie));
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(await db.task.count({ where: { userId: user.id } }), approved ? 1 : 0);
    const rows = await db.message.findMany({ where: { chatId: owned.id } });
    assert.equal(rows.length, 3);
    assert.ok(rows.some((row) => row.content === "Original answer"));
    const persisted = decodePersistedAssistantToolMessage(rows.find((row) => row.clientMessageId === "pending-1").content);
    assert.equal(persisted.tools[0].state, approved ? "output-available" : "output-denied");
    assert.equal(persisted.tools[0].approval.approved, approved);
    const replay = await chat.POST(request("/api/chat", "POST", payload, cookie));
    assert.equal(replay.status, 409);
    assert.equal(await db.task.count({ where: { userId: user.id } }), approved ? 1 : 0);
  });
}

test("approval rejects changed tool arguments without executing the task", async () => {
  const owned = await seedConversation();
  const content = encodePersistedAssistantToolMessage({ type: "assistant-tool-message", text: "", tools: [{ toolName: "createTask", toolCallId: "call-1", state: "approval-requested", input: { title: "Original" }, approval: { id: "approval-1" } }] });
  await saveChatMessage({ chatId: owned.id, role: "assistant", content, clientMessageId: "pending-1" });
  process.env.OPENROUTER_API_KEY = "test-provider-placeholder";
  const response = await chat.POST(request("/api/chat", "POST", { chatId: owned.id, messages: [uiMessage("u1", "user", "Original question"), { id: "pending-1", role: "assistant", parts: [{ type: "tool-createTask", toolCallId: "call-1", state: "approval-responded", input: { title: "Tampered" }, approval: { id: "approval-1", approved: true } }] }] }, cookie));
  assert.equal(response.status, 400);
  assert.equal(await db.task.count({ where: { userId: user.id } }), 0);
});
