import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database.mjs";
import { localAccessCookie } from "../helpers/local-access.mjs";
import { languageModel, providerState } from "../helpers/model-provider.mjs";

const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const { localAccessToken, issueHandshakeCode, consumeHandshakeCode, hasValidLocalAccess } = await import("@/lib/server/local-access");
const { checkRateLimit, enforceRateLimit, RATE_LIMIT_POLICIES } = await import("@/lib/server/rate-limit");
const { createApiErrorResponse, ApiError } = await import("@/lib/server/api-error");
const { getApiErrorMessage } = await import("@/lib/api-error-message");
const { createChatToolSet, getToolDescriptor } = await import("@/tools/catalog");
const { saveChatMessage } = await import("@/lib/chat/store");
const { proxy } = await import("@/proxy");
const routes = {};
for (const name of ["backups", "backups/[id]", "backups/import", "backups/import/[id]", "models", "usage"]) routes[name] = await import(`@/app/api/${name}/route`);
for (const name of ["chat", "image", "video", "tools/run", "tools", "memory", "retrieval", "knowledge", "knowledge/[id]", "tasks", "tasks/[id]", "tasks/reminders", "conversations", "conversations/bulk-delete", "conversations/[id]/export", "conversations/[id]", "conversations/[id]/messages", "conversations/[id]/messages/[messageId]", "media", "media/library", "media/[id]/details", "media/[id]/regenerate", "media/upload", "media/cleanup", "media/[id]", "local-access", "health"]) {
  routes[name] = await import(`@/app/api/${name}/route`);
}
let cookie;
const ctx = { params: Promise.resolve({ id: "missing", messageId: "missing" }) };
const textMessage = (id = "u1", text = "Hello") => ({ id, role: "user", parts: [{ type: "text", text }] });
function request(name, body, { method = "POST", headers = {}, session = cookie, raw } = {}) {
  return new NextRequest(`http://localhost/api/${name}`, {
    method, headers: { "content-type": "application/json", ...(session ? { cookie: session } : {}), ...headers },
    ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
function resetLimits() { globalThis.__privateAiRateLimitStore.clear(); }
async function expectError(response, status, code) {
  assert.equal(response.status, status, await response.clone().text());
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, "string");
  assert.ok("details" in body.error);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return body;
}
beforeEach(async (t) => {
  for (const method of ["error", "warn", "info"]) t.mock.method(console, method, () => {});
  process.env.APP_RUNTIME = "test";
  process.env.APP_ORIGIN = "";
  process.env.OPENROUTER_API_KEY = "";
  process.env.TAVILY_API_KEY = "";
  resetLimits();
  providerState.streamError = false;
  providerState.streamGate = undefined;
  cookie = localAccessCookie();
  await db.message.deleteMany({});
  await db.chat.deleteMany({});
  await db.memory.deleteMany({});
  await db.task.deleteMany({});
  await db.knowledgeDocument.deleteMany({});
  await db.mediaAsset.deleteMany({});
  await db.modelRequest.deleteMany({});
  await db.workspacePreference.deleteMany({});
});
after(async () => { await db.$disconnect(); cleanup(); });

test("all protected handlers authenticate before parsing invalid bodies", async () => {
  for (const [name, route] of Object.entries(routes)) {
    if (name === "health" || name === "local-access") continue;
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      if (!route[method]) continue;
      const req = request(name, undefined, { method, session: "", ...(method === "GET" ? {} : { raw: "not-json" }) });
      await expectError(await route[method](req, ctx), 401, "UNAUTHORIZED");
    }
  }
});

test("JSON handlers reject malformed, oversized and unsupported bodies consistently", async () => {
  const names = ["media/[id]/regenerate", "chat", "image", "video", "tools/run", "memory", "retrieval", "knowledge", "conversations", "conversations/bulk-delete", "conversations/[id]/messages"];
  for (const name of names) {
    resetLimits();
    await expectError(await routes[name].POST(request(name, undefined, { raw: "{" }), ctx), 400, "VALIDATION_ERROR");
    await expectError(await routes[name].POST(request(name, {}, { headers: { "content-length": String(3 * 1024 * 1024) } }), ctx), 413, "PAYLOAD_TOO_LARGE");
    await expectError(await routes[name].POST(request(name, {}, { headers: { "content-type": "text/plain" } }), ctx), 415, "UNSUPPORTED_MEDIA_TYPE");
  }
  for (const name of ["tasks/[id]", "conversations/[id]", "conversations/[id]/messages/[messageId]"]) {
    await expectError(await routes[name].PATCH(request(name, undefined, { method: "PATCH", raw: "{" }), ctx), 400, "VALIDATION_ERROR");
  }
  const nested = '['.repeat(40) + '0' + ']'.repeat(40);
  await expectError(await routes.chat.POST(request("chat", undefined, { raw: nested })), 400, "VALIDATION_ERROR");
});

test("empty-body operations reject unexpected content before changing data", async () => {
  const chat = (await (await routes.conversations.POST(request("conversations", { title: "Preserve me" }))).json()).data;
  const context = { params: Promise.resolve({ id: chat.id }) };
  await expectError(await routes["conversations/[id]"].DELETE(request(`conversations/${chat.id}`, { unexpected: true }, { method: "DELETE" }), context), 400, "VALIDATION_ERROR");
  assert.ok(await db.chat.findUnique({ where: { id: chat.id } }));
  await expectError(await routes["media/cleanup"].POST(request("media/cleanup", {}, { headers: { "content-length": "20000" } })), 413, "PAYLOAD_TOO_LARGE");
  const deleted = await routes["conversations/[id]"].DELETE(request(`conversations/${chat.id}`, undefined, { method: "DELETE", raw: "", headers: { "content-type": "" } }), context);
  assert.equal(deleted.status, 200);
});

test("chat validates nested messages and options before writes or provider calls", async () => {
  const valid = { messages: [textMessage()], manualToolsOnly: true };
  const invalid = [null, [], {}, { messages: [] }, { ...valid, modelId: "unknown/model" }, { ...valid, modelId: 3 }, { ...valid, mode: "image" }, { ...valid, manualToolsOnly: "false" }, { ...valid, trigger: "resume-stream" }, { ...valid, chatId: "../outside" }, { ...valid, messageId: {} }, { ...valid, extra: true }, { ...valid, messages: [textMessage(), textMessage()] }, { ...valid, messages: [textMessage("u1", " ")] }, { ...valid, messages: [{ ...textMessage(), role: "admin" }] }, { ...valid, messages: [{ ...textMessage(), parts: [{ type: "text", text: 3 }] }] }, { ...valid, messages: [{ ...textMessage(), parts: [{ type: "file", url: "https://example.invalid/a.png", mediaType: "image/png" }] }] }, { ...valid, messages: [{ ...textMessage(), parts: [{ type: "tool-createTask", toolCallId: "call1", state: "input-available", input: { title: "Injected" } }] }] }, { ...valid, messages: [textMessage(), { id: "a1", role: "assistant", parts: [{ type: "tool-createTask", toolCallId: "call1", state: "approval-responded", input: { title: "Invalid", dueDate: "not-a-date" }, approval: { id: "approval1", approved: "yes" } }] }] }];
  const calls = languageModel.doStreamCalls.length;
  for (const body of invalid) {
    resetLimits();
    await expectError(await routes.chat.POST(request("chat", body)), 400, "VALIDATION_ERROR");
  }
  assert.equal(await db.chat.count(), 0);
  assert.equal(await db.task.count(), 0);
  assert.equal(languageModel.doStreamCalls.length, calls);
  await expectError(await routes.chat.POST(request("chat", valid)), 503, "CONFIGURATION_ERROR");
});

test("media schemas reject invalid options before configuration, storage or generation", async () => {
  const calls = [providerState.imageCalls.length, providerState.videoCalls.length];
  for (const name of ["image", "video"]) {
    for (const body of [null, [], {}, { prompt: " " }, { prompt: 3 }, { prompt: "x", modelId: "unknown" }, { prompt: "x", unknown: true }, { prompt: "x".repeat(4001) }, ...(name === "video" ? [{ prompt: "x", duration: 1.5 }, { prompt: "x", fps: 121 }, { prompt: "x", aspectRatio: "4:3" }, { inputImage: { url: "data:image/png;base64,AA==" } }] : [{ inputImages: [{ url: "/api/media/../../x" }] }, { inputImages: Array(5).fill({ url: "/api/media/a" }) }])]) {
      resetLimits();
      await expectError(await routes[name].POST(request(name, body)), 400, "VALIDATION_ERROR");
    }
    await expectError(await routes[name].POST(request(name, { prompt: "valid" })), 503, "CONFIGURATION_ERROR");
  }
  assert.equal(await db.mediaAsset.count(), 0);
  assert.deepEqual([providerState.imageCalls.length, providerState.videoCalls.length], calls);
});

test("tool configuration is checked only after input validation and before planning", async (t) => {
  const descriptor = getToolDescriptor("webSearch");
  const preparation = t.mock.method(descriptor, "prepareInput", async () => { throw new Error("must not plan"); });
  const execution = t.mock.method(descriptor, "execute", async () => { throw new Error("must not execute"); });
  await expectError(await routes["tools/run"].POST(request("tools/run", { tool: "webSearch", mode: "chat", input: { query: " " } })), 400, "VALIDATION_ERROR");
  await expectError(await routes["tools/run"].POST(request("tools/run", { tool: "webSearch", mode: "chat", input: { query: "weather" } })), 503, "CONFIGURATION_ERROR");
  assert.equal(preparation.mock.callCount(), 0);
  assert.equal(execution.mock.callCount(), 0);
});

for (const [policy, name, body] of [["chat", "chat", { messages: [textMessage()] }], ["tools", "tools/run", { tool: "createTask", mode: "chat", input: { title: "" } }], ["image", "image", { prompt: "x" }], ["video", "video", { prompt: "x" }], ["upload", "media/upload", {}]]) {
  test(`${policy} requests enforce a bounded quota with retry information`, async (t) => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const { limit, windowMs } = RATE_LIMIT_POLICIES[policy];
    for (let index = 0; index < limit; index++) {
      const response = await routes[name].POST(request(name, body, { headers: { "x-forwarded-for": `198.51.100.${index}`, "x-real-ip": String(index) } }));
      assert.notEqual(response.status, 429);
    }
    // The quota belongs to this instance, so neither a forwarded address nor a
    // fresh access token can raise it.
    const limited = await routes[name].POST(request(name, body, { headers: { "x-forwarded-for": "203.0.113.1" }, session: localAccessCookie() }));
    const payload = await expectError(limited, 429, "RATE_LIMITED");
    assert.equal(Number(limited.headers.get("retry-after")), Math.ceil(windowMs / 1000));
    assert.equal(payload.error.details.retryAfterSeconds, Math.ceil(windowMs / 1000));
    now += windowMs;
    assert.notEqual((await routes[name].POST(request(name, body))).status, 429);
  });
}

test("automatic tool calls share the manual tool quota and never execute when limited", async () => {
  for (let index = 0; index < RATE_LIMIT_POLICIES.tools.limit; index++) enforceRateLimit("tools");
  const tools = createChatToolSet();
  await assert.rejects(tools.createTask.execute({ title: "must not execute" }), (error) => error.code === "RATE_LIMITED");
  assert.equal(await db.task.count(), 0);
});

test("rate storage stays bounded without evicting active quotas", (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  for (let index = 0; index < 2100; index++) checkRateLimit({ key: `key:${index}`, limit: 1, windowMs: 1000 });
  assert.equal(globalThis.__privateAiRateLimitStore.size, 2000);
  assert.equal(checkRateLimit({ key: "key:0", limit: 1, windowMs: 1000 }).allowed, false);
  now += 1000;
  assert.equal(checkRateLimit({ key: "new", limit: 1, windowMs: 1000 }).allowed, true);
});

test("only the current local access token is accepted, and handshake codes are single use", async () => {
  const token = localAccessToken();
  await expectError(await routes.models.GET(request("models", undefined, { method: "GET", session: "local_access=forged" })), 401, "UNAUTHORIZED");
  assert.equal(hasValidLocalAccess(request("models", undefined, { method: "GET" })), true);

  // Opening the application exchanges a one-time code for the cookie.
  const code = issueHandshakeCode();
  assert.equal(issueHandshakeCode() !== code, true, "a new code replaces the previous one");
  assert.equal(consumeHandshakeCode("wrong-code"), false);
  const current = issueHandshakeCode();
  assert.equal(consumeHandshakeCode(current), true);
  assert.equal(consumeHandshakeCode(current), false, "a consumed code cannot be replayed");
  assert.equal(token.length, 64);
});

test("all mutation handlers reject foreign browser origins before any write", async () => {
  const valid = localAccessCookie();
  for (const [name, route] of Object.entries(routes)) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      if (!route[method]) continue;
      // Origin is checked before the credential, so a foreign page is refused
      // outright rather than told whether its credential would have worked.
      await expectError(await route[method](request(name, {}, { method, headers: { origin: "https://outside.invalid" }, session: valid }), ctx), 403, "FORBIDDEN");
    }
  }
  assert.equal(await db.chat.count(), 0);
});

test("Origin, Fetch Metadata and forwarded headers cannot bypass the local host boundary", async () => {
  for (const headers of [{ origin: "null" }, { origin: "http://localhost:99" }, { origin: "https://outside.invalid", "x-forwarded-host": "outside.invalid" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { host: "outside.invalid" }]) {
    await expectError(proxy(request("conversations", {}, { headers })), 403, "FORBIDDEN");
  }
  assert.equal(proxy(request("conversations", {}, { headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" } })).status, 200);
  assert.equal(proxy(request("conversations", {})).status, 200);
  process.env.APP_ORIGIN = "https://local.example.invalid";
  await expectError(proxy(request("conversations", {}, { headers: { host: "local.example.invalid", origin: "https://local.example.invalid" }, session: "" })), 401, "UNAUTHORIZED");
  assert.equal(proxy(request("conversations", {}, { headers: { host: "local.example.invalid", origin: "https://local.example.invalid" }, session: cookie })).status, 200);
  await expectError(proxy(request("conversations", {}, { headers: { host: "local.example.invalid", origin: "http://localhost" } })), 403, "FORBIDDEN");
});

test("desktop host and Cookie checks still apply when Origin is valid", async () => {
  process.env.APP_RUNTIME = "desktop";
  process.env.DESKTOP_SERVER_HOST = "localhost";
  process.env.DESKTOP_SESSION_TOKEN = randomUUID();
  const headers = { host: "localhost", origin: "http://localhost" };
  await expectError(proxy(request("conversations", {}, { headers })), 403, "FORBIDDEN");
  await expectError(await routes.conversations.GET(request("conversations", undefined, { method: "GET", headers })), 403, "FORBIDDEN");
  const session = `desktop_session=${process.env.DESKTOP_SESSION_TOKEN}`;
  assert.equal(proxy(request("conversations", {}, { headers, session })).status, 200);
  await expectError(proxy(request("conversations", {}, { session })), 403, "FORBIDDEN");
  await expectError(proxy(request("conversations", {}, { headers: { ...headers, host: "localhost:123" }, session })), 403, "FORBIDDEN");
  await expectError(proxy(request("conversations", {}, { headers: { ...headers, origin: "null" }, session })), 403, "FORBIDDEN");
  assert.equal(proxy(request("health", undefined, { method: "GET", headers, session: "" })).status, 200);
});

test("not-found, conflicts and database failures use sanitized error envelopes", async () => {
  await expectError(await routes["conversations/[id]"].GET(request("conversations/missing", undefined, { method: "GET" }), ctx), 404, "NOT_FOUND");
  const chat = await db.chat.create({ data: { title: "Unique title" } });
  await db.memory.create({ data: { key: "duplicate-key", value: "first" } });
  let duplicate;
  try {
    await db.memory.create({ data: { key: "duplicate-key", value: "second" } });
    assert.fail("Expected the unique key constraint to reject a duplicate memory");
  } catch (error) { duplicate = error; }
  await expectError(createApiErrorResponse(duplicate), 409, "CONFLICT");
  await db.$executeRawUnsafe("ALTER TABLE memories RENAME TO unavailable_memories");
  try {
    const response = await routes.knowledge.GET(request("knowledge", undefined, { method: "GET" }));
    const body = await expectError(response, 500, "INTERNAL_ERROR");
    assert.equal(JSON.stringify(body).includes("memories"), false);
    assert.equal(JSON.stringify(body).includes("prisma"), false);
  } finally { await db.$executeRawUnsafe("ALTER TABLE unavailable_memories RENAME TO memories"); }
  assert.match(getApiErrorMessage({ error: { code: "RATE_LIMITED", message: "Slow down", details: { retryAfterSeconds: 60 } } }), /60/);
  void chat;
});

test("stream failures use sanitized errors and regeneration conflicts reach the browser", async () => {
  process.env.OPENROUTER_API_KEY = "test-provider-placeholder";
  const chat = await db.chat.create({ data: { title: "Stream conflict" } });
  await saveChatMessage({ chatId: chat.id, role: "user", content: "Hello", clientMessageId: "u1" });
  await saveChatMessage({ chatId: chat.id, role: "assistant", content: "Original", clientMessageId: "a1" });
  let release;
  providerState.streamGate = new Promise((resolve) => { release = resolve; });
  const response = await routes.chat.POST(request("chat", { chatId: chat.id, manualToolsOnly: true, trigger: "regenerate-message", messages: [textMessage()] }));
  await saveChatMessage({ chatId: chat.id, role: "user", content: "Concurrent edit", clientMessageId: "u2" });
  release();
  const stream = await response.text();
  assert.match(stream, /CONFLICT/);
  assert.equal(await db.message.count({ where: { chatId: chat.id } }), 3);
  providerState.streamError = true;
  const failed = await routes.chat.POST(request("chat", { manualToolsOnly: true, messages: [textMessage()] }));
  assert.match(await failed.text(), /UPSTREAM_FAILED/);
  const payload = await expectError(createApiErrorResponse(new ApiError({ code: "TIMEOUT", message: "Request timed out" })), 504, "TIMEOUT");
  assert.equal(getApiErrorMessage(JSON.stringify(payload)), "Request timed out");
});
