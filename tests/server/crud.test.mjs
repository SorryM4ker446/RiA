import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database.mjs";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { createSession } = await import("@/lib/auth/session");
const conversations = await import("@/app/api/conversations/route");
const conversation = await import("@/app/api/conversations/[id]/route");
const messages = await import("@/app/api/conversations/[id]/messages/route");
const message = await import("@/app/api/conversations/[id]/messages/[messageId]/route");
const tasks = await import("@/app/api/tasks/route");
const task = await import("@/app/api/tasks/[id]/route");
const tools = await import("@/app/api/tools/run/route");
const knowledge = await import("@/app/api/knowledge/route");
const knowledgeEntry = await import("@/app/api/knowledge/[id]/route");
let user, cookie, otherCookie;
const context = (id, messageId) => ({ params: Promise.resolve({ id, messageId }) });
function request(path, method = "GET", body, session = cookie) {
  return new NextRequest(`http://localhost${path}`, { method, headers: { cookie: session, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function data(response, status = 200) {
  assert.equal(response.status, status);
  return (await response.json()).data;
}
async function missing(response) {
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "NOT_FOUND");
}
beforeEach(async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "info", () => {});
  user = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  const other = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  cookie = `app_session=${await createSession(user.id)}`;
  otherCookie = `app_session=${await createSession(other.id)}`;
});
after(async () => { await db.$disconnect(); cleanup(); });

test("conversation and message CRUD persists edits, deduplicates retries and scopes client IDs", async () => {
  const owned = await data(await conversations.POST(request("/api/conversations", "POST", { title: "Original title" })), 201);
  const sibling = await data(await conversations.POST(request("/api/conversations", "POST", { title: "Sibling" })), 201);
  const body = { role: "user", content: "Original content", clientMessageId: "shared-client-id", status: "pending" };
  const row = await data(await messages.POST(request("/api/messages", "POST", body), context(owned.id)), 201);
  const retry = await data(await messages.POST(request("/api/messages", "POST", body), context(owned.id)), 201);
  assert.equal(retry.id, row.id);
  const siblingRow = await data(await messages.POST(request("/api/messages", "POST", { ...body, content: "Sibling content" }), context(sibling.id)), 201);
  assert.notEqual(siblingRow.id, row.id);
  for (const id of [row.id, body.clientMessageId]) {
    assert.equal((await data(await message.GET(request("/api/messages"), context(owned.id, id)))).content, body.content);
    await missing(await message.GET(request("/api/messages", "GET", undefined, otherCookie), context(owned.id, id)));
    await missing(await message.DELETE(request("/api/messages", "DELETE", undefined, otherCookie), context(owned.id, id)));
  }
  await missing(await conversation.PATCH(request("/api/conversations", "PATCH", { title: "Stolen" }, otherCookie), context(owned.id)));
  assert.equal((await data(await conversation.PATCH(request("/api/conversations", "PATCH", { title: " Renamed " }), context(owned.id)))).title, "Renamed");
  await data(await message.PATCH(request("/api/messages", "PATCH", { content: "Edited", status: "success" }), context(owned.id, body.clientMessageId)));
  assert.equal((await db.message.findUnique({ where: { id: row.id } })).content, "Edited");
  assert.equal((await data(await message.GET(request("/api/messages"), context(sibling.id, body.clientMessageId)))).content, "Sibling content");
  assert.equal((await data(await conversation.GET(request("/api/conversations"), context(owned.id)))).messageCount, 1);
  assert.equal((await message.DELETE(request("/api/messages", "DELETE"), context(owned.id, body.clientMessageId))).status, 200);
  await missing(await message.GET(request("/api/messages"), context(owned.id, row.id)));
  assert.equal((await data(await conversation.GET(request("/api/conversations"), context(owned.id)))).messageCount, 0);
  assert.equal((await conversation.DELETE(request("/api/conversations", "DELETE"), context(sibling.id))).status, 200);
  assert.equal(await db.message.count({ where: { chatId: sibling.id } }), 0);
  await missing(await conversation.GET(request("/api/conversations"), context(sibling.id)));
});

test("task CRUD validates atomic updates, date normalization, filters and user isolation", async () => {
  const created = await data(await tools.POST(request("/api/tools/run", "POST", { tool: "createTask", mode: "chat", input: { title: "Task", dueDate: "2026-09-01T08:00:00+08:00", priority: "high" } })));
  const id = created.taskId;
  assert.equal((await data(await task.GET(request("/api/tasks"), context(id)))).dueDate, "2026-09-01T00:00:00.000Z");
  for (const method of ["GET", "PATCH", "DELETE"]) {
    await missing(await task[method](request("/api/tasks", method, method === "PATCH" ? { status: "done" } : undefined, otherCookie), context(id)));
  }
  assert.deepEqual(await data(await tasks.GET(request("/api/tasks", "GET", undefined, otherCookie))), []);
  const invalid = await task.PATCH(request("/api/tasks", "PATCH", { title: "Must not persist", dueDate: "invalid date" }), context(id));
  assert.equal(invalid.status, 400);
  assert.equal((await db.task.findUnique({ where: { id } })).title, "Task");
  for (const status of ["in_progress", "done", "todo"]) {
    await data(await task.PATCH(request("/api/tasks", "PATCH", { status, details: " Updated ", dueDate: null }), context(id)));
    const rows = await data(await tasks.GET(request(`/api/tasks?status=${status}&limit=1`)));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, status);
    assert.equal(rows[0].details, "Updated");
    assert.equal(rows[0].dueDate, null);
  }
  assert.equal((await task.DELETE(request("/api/tasks", "DELETE"), context(id))).status, 200);
  assert.equal(await db.task.count({ where: { userId: user.id } }), 0);
  await missing(await task.GET(request("/api/tasks"), context(id)));
  await missing(await task.DELETE(request("/api/tasks", "DELETE"), context(id)));
});

test("knowledge upserts update one owned row and CRUD excludes tool memories", async () => {
  const entry = await data(await knowledge.POST(request("/api/knowledge", "POST", { key: " 数据库约定 ", value: " First " })), 201);
  const updated = await data(await knowledge.POST(request("/api/knowledge", "POST", { key: "数据库约定", value: "Updated", score: 0.7 })), 201);
  assert.equal(updated.id, entry.id);
  assert.equal(updated.value, "Updated");
  const other = await data(await knowledge.POST(request("/api/knowledge", "POST", { key: "数据库约定", value: "Other user" }, otherCookie)), 201);
  assert.notEqual(other.id, entry.id);
  const internal = await db.memory.create({ data: { userId: user.id, key: "tool:private", value: "Tool record" } });
  assert.deepEqual((await data(await knowledge.GET(request("/api/knowledge?limit=100")))).map((row) => row.id), [entry.id]);
  await missing(await knowledgeEntry.DELETE(request("/api/knowledge", "DELETE", undefined, otherCookie), context(entry.id)));
  await missing(await knowledgeEntry.DELETE(request("/api/knowledge", "DELETE"), context(internal.id)));
  assert.equal((await knowledgeEntry.DELETE(request("/api/knowledge", "DELETE"), context(entry.id))).status, 200);
  assert.deepEqual(await data(await knowledge.GET(request("/api/knowledge"))), []);
  assert.equal((await db.memory.findUnique({ where: { id: other.id } })).value, "Other user");
  assert.ok(await db.memory.findUnique({ where: { id: internal.id } }));
});
