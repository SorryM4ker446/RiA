import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { seedTestModelPreferences } from "../helpers/model-library";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const conversations = await import("@/app/api/conversations/route");
const conversation = await import("@/app/api/conversations/[id]/route");
const messages = await import("@/app/api/conversations/[id]/messages/route");
const message = await import("@/app/api/conversations/[id]/messages/[messageId]/route");
const tasks = await import("@/app/api/tasks/route");
const task = await import("@/app/api/tasks/[id]/route");
const { executeRegisteredTool, getToolDescriptor } = await import("@/tools/catalog");
const knowledge = await import("@/app/api/knowledge/route");
const knowledgeEntry = await import("@/app/api/knowledge/[id]/route");
let cookie;
const context = (id, messageId?) => ({ params: Promise.resolve({ id, messageId }) });
function request(path, method = "GET", body?) {
  return new NextRequest(`http://localhost${path}`, { method, headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function data(response, status = 200) {
  assert.equal(response.status, status);
  return (await response.json()).data;
}
async function missing(response) {
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "NOT_FOUND");
}
beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "info", () => {});
  cookie = localAccessCookie();
  await db.chat.deleteMany({});
  await db.memory.deleteMany({});
  await db.scheduledJob.deleteMany({});
  await db.knowledgeDocument.deleteMany({});
  await db.workspacePreference.deleteMany({});
  await seedTestModelPreferences(db);
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
  }
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

test("task CRUD validates atomic updates and schedules", async () => {
  const created = await data(await tasks.POST(request("/api/tasks", "POST", { title: " Task ", prompt: "Say hello.", cron: "30 8 * * 1-5", timeZone: "Asia/Shanghai" })), 201);
  const id = created.id;
  assert.equal(created.title, "Task");
  assert.equal(created.kind, "prompt");
  // Off unless asked for, so a form that forgets the switch starts nothing.
  assert.equal(created.enabled, false);
  assert.ok(new Date(created.nextRunAt).getTime() > Date.now());
  const invalid = await task.PATCH(request("/api/tasks", "PATCH", { title: "Must not persist", cron: "not a schedule" }), context(id));
  assert.equal(invalid.status, 400);
  assert.equal((await db.scheduledJob.findUnique({ where: { id } })).title, "Task");
  const updated = await data(await task.PATCH(request("/api/tasks", "PATCH", { prompt: "Say goodbye.", enabled: true }), context(id)));
  assert.equal(updated.prompt, "Say goodbye.");
  assert.equal(updated.enabled, true);
  assert.equal(updated.cron, "30 8 * * 1-5");
  assert.equal(updated.nextRunAt, created.nextRunAt, "a change that leaves the schedule alone does not move the next run");
  assert.equal((await data(await tasks.GET(request("/api/tasks")))).some(row => row.id === id), true);
  assert.equal((await task.DELETE(request("/api/tasks", "DELETE"), context(id))).status, 200);
  assert.equal(await db.scheduledJob.count({ where: { id } }), 0);
  await missing(await task.PATCH(request("/api/tasks", "PATCH", { title: "Gone" }), context(id)));
  await missing(await task.DELETE(request("/api/tasks", "DELETE"), context(id)));
});

test("a task created by the user or by the task tool is saved without leaving a memory suggestion", async () => {
  const future = new Date(Date.now() + 86_400_000).toISOString().slice(0, 16);
  const created = await data(await tasks.POST(request("/api/tasks", "POST", { title: " 复习泛型笔记 ", prompt: "提醒我复习泛型笔记。", runAt: future, timeZone: "UTC" })), 201);
  assert.equal(created.title, "复习泛型笔记");
  assert.equal(created.cron, null);
  // Neither a repeat nor a time: a task that runs only when started by hand.
  const manual = await data(await tasks.POST(request("/api/tasks", "POST", { title: "没有时间", prompt: "x", timeZone: "UTC" })), 201);
  assert.deepEqual([manual.cron, manual.nextRunAt], [null, null]);
  for (const invalid of [
    { title: "", prompt: "x", cron: "0 9 * * *", timeZone: "UTC" },
    { title: "两种时间", prompt: "x", cron: "0 9 * * *", runAt: future, timeZone: "UTC" },
    { title: "没有内容", cron: "0 9 * * *", timeZone: "UTC" },
    { title: "已经过去", prompt: "x", runAt: "2020-01-01T09:00", timeZone: "UTC" },
    { title: "永远不到", prompt: "x", cron: "0 0 31 2 *", timeZone: "UTC" },
    { title: "多余字段", prompt: "x", cron: "0 9 * * *", timeZone: "UTC", extra: true },
  ]) {
    assert.equal((await tasks.POST(request("/api/tasks", "POST", invalid))).status, 400, JSON.stringify(invalid));
  }
  assert.equal(await db.scheduledJob.count(), 2, "only the two valid tasks were saved");
  const made = await executeRegisteredTool(getToolDescriptor("createTask")!, { title: "工具创建的任务", prompt: "Do it.", cron: "0 9 * * *", timeZone: "UTC" }, { trigger: "manual" });
  assert.equal(await db.scheduledJob.count(), 3);
  // The user approved it as it stands, so it is created switched on.
  assert.equal((made.output as { enabled: boolean }).enabled, true);
  // The task list is where tasks are kept; neither path writes to memory.
  assert.equal(await db.memory.count(), 0);
});

test("knowledge upserts one row, and an inferred memory is listed and removable like any other", async () => {
  const entry = await data(await knowledge.POST(request("/api/knowledge", "POST", { key: " 数据库约定 ", value: " First " })), 201);
  const updated = await data(await knowledge.POST(request("/api/knowledge", "POST", { key: "数据库约定", value: "Updated", score: 0.7 })), 201);
  assert.equal(updated.id, entry.id);
  assert.equal(updated.value, "Updated");

  // What the assistant inferred used to be invisible here and undeletable. A
  // candidate the user cannot see or remove is not a candidate they can decide
  // about, so it is listed with its source and is removable.
  const inferred = await db.memory.create({ data: { key: "tool:private", value: "Tool record", source: "assistant", confirmed: false } });
  const listed = await data(await knowledge.GET(request("/api/knowledge?limit=100")));
  assert.deepEqual(new Set(listed.map((row) => row.id)), new Set([entry.id, inferred.id]));
  assert.equal(listed.find((row) => row.id === inferred.id).source, "assistant");
  assert.equal(listed.find((row) => row.id === inferred.id).confirmed, false);

  // The confirmed view is what the user has actually accepted.
  const confirmed = await data(await knowledge.GET(request("/api/knowledge?view=confirmed")));
  assert.deepEqual(confirmed.map((row) => row.id), [entry.id]);

  await data(await knowledgeEntry.DELETE(request("/api/knowledge", "DELETE"), context(inferred.id)), 200);
  assert.equal((await knowledgeEntry.DELETE(request("/api/knowledge", "DELETE"), context(entry.id))).status, 200);
  assert.deepEqual(await data(await knowledge.GET(request("/api/knowledge"))), []);
});
