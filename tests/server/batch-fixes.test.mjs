import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database.mjs";
import { localAccessCookie } from "../helpers/local-access.mjs";
import { languageModel, providerState } from "../helpers/model-provider.mjs";

const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");

const chatRoute = await import("@/app/api/chat/route");
const { readChatRequest } = await import("@/lib/chat/request");
const { decodePersistedAssistantToolMessage, encodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
const { saveChatMessage, releaseUnclaimedToolApproval } = await import("@/lib/chat/store");
const { persistChatResponse } = await import("@/lib/chat/persistence");
const { runWebSearch } = await import("@/tools/definitions/web-search");
const { createChatToolSet } = await import("@/tools/catalog");
const { GET } = await import("@/app/api/local-access/route");
const { issueHandshakeCode } = await import("@/lib/server/local-access");
let cookie;
beforeEach(async (t) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  providerState.streamGate = undefined;
  providerState.streamError = false;
  cookie = localAccessCookie();
  await db.message.deleteMany({});
  await db.chat.deleteMany({});
  await db.memory.deleteMany({});
});
after(async () => { await db.$disconnect(); cleanup(); });

const ui = (id, role, text) => ({ id, role, parts: [{ type: "text", text }] });
function chatRequest(body, headers = {}) {
  return new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers: { cookie, "content-type": "application/json", ...headers },
    body: JSON.stringify({ manualToolsOnly: true, ...body }),
  });
}

test("approval claimed but lost before tool execution is released for retry", async () => {
  const owned = await db.chat.create({ data: { title: "Approval retry" } });
  const approval = { id: "approval-1", approved: true };
  await saveChatMessage({
    chatId: owned.id, role: "assistant",
    content: encodePersistedAssistantToolMessage({
      type: "assistant-tool-message", text: "waiting",
      tools: [{ toolName: "createTask", toolCallId: "call-1", state: "approval-requested", input: { title: "Buy milk" }, approval }],
    }),
    status: "success",
    clientMessageId: "assistant-1",
  });
  const decision = {
    id: "assistant-1", role: "assistant",
    parts: [{ type: "tool-createTask", toolCallId: "call-1", state: "approval-responded", input: { title: "Buy milk" }, approval }],
  };
  await releaseUnclaimedToolApproval(owned.id, decision);
  const rows = await db.message.findMany({ where: { chatId: owned.id } });
  const restored = decodePersistedAssistantToolMessage(rows[0].content);
  assert.equal(restored.tools[0].state, "approval-requested", "a claimed-but-unexecuted approval returns to pending");
});

test("persistChatResponse never overwrites a title renamed during generation", async () => {
  const owned = await db.chat.create({ data: { title: "New Chat" } });
  const input = await readChatRequest(chatRequest({ chatId: owned.id, messages: [ui("rename-user", "user", "回答这个问题")] }));
  const conversation = { chat: owned, regenerationSnapshot: null };
  await db.chat.update({ where: { id: owned.id }, data: { title: "用户改过的标题" } });
  await persistChatResponse({ input, conversation, responseMessage: ui("assistant-rename", "assistant", "回答"), isAborted: false, generationFailed: false });
  const after = await db.chat.findUnique({ where: { id: owned.id } });
  assert.equal(after.title, "用户改过的标题");
  assert.ok(after.lastMessageAt);
});

test("a still-unrenamed conversation is titled from its first user message", async () => {
  const owned = await db.chat.create({ data: { title: "New Chat" } });
  const input = await readChatRequest(chatRequest({ chatId: owned.id, messages: [ui("title-user", "user", "帮我制定一周学习计划")] }));
  await persistChatResponse({ input, conversation: { chat: owned, regenerationSnapshot: null }, responseMessage: ui("assistant-title", "assistant", "好的"), isAborted: false, generationFailed: false });
  const after = await db.chat.findUnique({ where: { id: owned.id } });
  assert.match(after.title, /帮我制定一周学习计划|帮我制定一周/);
});

test("web search refuses to run after cancellation", async () => {
  process.env.TAVILY_API_KEY = "offline-fixture-key";
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runWebSearch({ query: "test" }, controller.signal), (error) => error.code === "TIMEOUT");
  delete process.env.TAVILY_API_KEY;
});

test("parallel tool executions cannot double-spend the per-turn result budget", async () => {
  const toolSet = createChatToolSet({ toolIds: ["webSearch"] });
  const webSearch = toolSet.webSearch;
  const first = webSearch.execute({ query: "parallel one" });
  const second = webSearch.execute({ query: "parallel two" });
  const results = await Promise.allSettled([first, second]);
  const outputs = results.filter((entry) => entry.status === "fulfilled").map((entry) => entry.value);
  const plannedTotal = outputs.reduce((sum, output) => sum + (output.results?.length ?? 0), 0);
  assert.ok(plannedTotal <= 10, `parallel searches must not exceed the shared budget (planned ${plannedTotal})`);
});

test("the local entry redirect keeps cookie scope for IPv6 loopback as well", (t) => {
  t.mock.method(console, "info", () => {});
  const entryUrl = new URL("/api/local-access", "http://[::1]:3000");
  entryUrl.searchParams.set("handshake", issueHandshakeCode());
  const response = GET(new NextRequest(entryUrl, { headers: { host: entryUrl.host, "sec-fetch-site": "none" } }));
  assert.equal(new URL(response.headers.get("location"), entryUrl).origin, entryUrl.origin);
});
