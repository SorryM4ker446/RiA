import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database.mjs";
import { isTaskTimeZone, parseTaskDueDate, nextTaskDueDate, taskLocalInput } from "@/lib/tasks/schedule";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { createSession } = await import("@/lib/auth/session");
const { createTask, createTaskInputSchema } = await import("@/tools/definitions/create-task");
const { claimTaskReminders, updateTask } = await import("@/lib/tasks/service");
const reminders = await import("@/app/api/tasks/reminders/route");
const taskRoute = await import("@/app/api/tasks/[id]/route");
let user, other, cookie;
const date = value => new Date(value);
const now = date("2026-08-30T10:00:00Z");
const due = "2026-08-30T09:00:00Z";
function request(path, body, headers = {}) {
  return new NextRequest(`http://localhost/api/${path}`, { method: path === "tasks/reminders" ? "POST" : "PATCH", headers: {
    host: "localhost", cookie, "content-type": "application/json", ...headers,
  }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function makeTask(input = {}, owner = user) {
  return createTask(owner.id, createTaskInputSchema.parse({ title: "Task reminder", dueDate: due, timeZone: "UTC", reminderEnabled: true, ...input }));
}
async function settled(promises) {
  const results = await Promise.allSettled(promises);
  for (const result of results) if (result.status === "rejected") throw result.reason;
  return results.map(result => result.value);
}
beforeEach(async t => {
  t.mock.method(console, "error", () => {});
  process.env.APP_RUNTIME = "test";
  process.env.AUTH_DISABLED = "0";
  process.env.DESKTOP_SERVER_HOST = "localhost";
  process.env.DESKTOP_SESSION_TOKEN = randomUUID();
  globalThis.__privateAiRateLimitStore?.clear();
  user = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  other = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  cookie = `app_session=${await createSession(user.id)}; desktop_session=${process.env.DESKTOP_SESSION_TOKEN}`;
});
after(async () => { await db.$disconnect(); cleanup(); });

test("task dates use explicit zones and reject invalid calendars and DST gaps", () => {
  assert.equal(parseTaskDueDate("2026-09-01T08:30", "Asia/Shanghai").toISOString(), "2026-09-01T00:30:00.000Z");
  assert.equal(parseTaskDueDate("2026-09-01T08:30:01.123+08:00", "America/New_York").toISOString(), "2026-09-01T00:30:01.123Z");
  assert.equal(parseTaskDueDate("2026-09-01", "Asia/Shanghai").toISOString(), "2026-08-31T16:00:00.000Z");
  assert.equal(parseTaskDueDate("2026-11-01T01:30", "America/New_York").toISOString(), "2026-11-01T05:30:00.000Z");
  assert.equal(taskLocalInput("2026-09-01T00:30:00Z", "Asia/Shanghai"), "2026-09-01T08:30");
  for (const value of ["2026-02-30", "2026-13-01", "2026-03-08T02:30", "September 1 2026", "2026-01-01T24:00", "2026-01-01T01:00+25:00"]) {
    assert.throws(() => parseTaskDueDate(value, "America/New_York"));
  }
  for (const zone of ["", "Invalid/Zone", "+08:00"]) assert.equal(isTaskTimeZone(zone), false);
});

test("daily and weekly recurrence retain local wall time across DST and skip missed occurrences", () => {
  const anchor = date("2026-03-07T14:00:00Z");
  assert.equal(nextTaskDueDate(anchor, anchor, "daily", "America/New_York", anchor).toISOString(), "2026-03-08T13:00:00.000Z");
  assert.equal(nextTaskDueDate(anchor, anchor, "weekly", "America/New_York", anchor).toISOString(), "2026-03-14T13:00:00.000Z");
  assert.equal(nextTaskDueDate(anchor, anchor, "daily", "America/New_York", date("2026-09-20T20:00:00Z")).toISOString(), "2026-09-21T13:00:00.000Z");
  const gapAnchor = date("2026-03-07T07:30:00Z");
  const gapDay = nextTaskDueDate(gapAnchor, gapAnchor, "daily", "America/New_York", gapAnchor);
  assert.equal(gapDay.toISOString(), "2026-03-08T07:30:00.000Z");
  assert.equal(nextTaskDueDate(gapAnchor, gapDay, "daily", "America/New_York", gapDay).toISOString(), "2026-03-09T06:30:00.000Z");
  const rollback = date("2026-10-31T05:30:00Z");
  assert.equal(nextTaskDueDate(rollback, rollback, "daily", "America/New_York", rollback).toISOString(), "2026-11-01T05:30:00.000Z");
});

test("monthly recurrence restores the anchor day after short months including leap years", () => {
  const anchor = date("2028-01-31T01:00:00Z");
  const february = nextTaskDueDate(anchor, anchor, "monthly", "Asia/Shanghai", anchor);
  assert.equal(february.toISOString(), "2028-02-29T01:00:00.000Z");
  assert.equal(nextTaskDueDate(anchor, february, "monthly", "Asia/Shanghai", february).toISOString(), "2028-03-31T01:00:00.000Z");
  assert.equal(nextTaskDueDate(anchor, anchor, "monthly", "Asia/Shanghai", date("2029-02-01T00:00:00Z")).toISOString(), "2029-02-28T01:00:00.000Z");
});

test("task creation and updates validate reminder requirements atomically", async () => {
  for (const input of [{ reminderEnabled: true }, { repeatRule: "daily" }, { dueDate: "2026-02-30" }, { timeZone: "bad" }, { repeatRule: "hourly" }, { reminderEnabled: "true" }]) {
    assert.equal(createTaskInputSchema.safeParse({ title: "Invalid", ...input }).success, false);
  }
  const created = await makeTask();
  for (const input of [{ dueDate: null }, { timeZone: "Bad/Zone" }, { repeatRule: "hourly" }, { remindedAt: null }, { repeatGenerated: false }]) {
    const response = await taskRoute.PATCH(request("tasks/id", { title: "Must roll back", ...input }), { params: Promise.resolve({ id: created.taskId }) });
    assert.equal(response.status, 400);
    assert.equal((await db.task.findUnique({ where: { id: created.taskId } })).title, "Task reminder");
  }
  const cleared = await updateTask(user.id, created.taskId, { dueDate: null, reminderEnabled: false, repeatRule: "none" }, now);
  assert.equal(cleared.data.dueDate, null);
});

test("concurrent completion creates exactly one future task and survives reconnect and successor deletion", async () => {
  const created = await makeTask({ repeatRule: "daily", timeZone: "Asia/Shanghai" });
  const results = await settled(Array.from({ length: 12 }, () => updateTask(user.id, created.taskId, { status: "done" }, now)));
  const successors = results.flatMap(result => result.nextTask ? [result.nextTask] : []);
  assert.equal(successors.length, 1);
  assert.equal(successors[0].dueDate.toISOString(), "2026-08-31T09:00:00.000Z");
  assert.equal(successors[0].reminderEnabled, true);
  assert.equal(successors[0].status, "todo");
  await db.$disconnect();
  await db.task.delete({ where: { id: successors[0].id } });
  await updateTask(user.id, created.taskId, { status: "todo" }, now);
  assert.equal((await updateTask(user.id, created.taskId, { status: "done" }, now)).nextTask, null);
  assert.equal(await db.task.count({ where: { userId: user.id } }), 1);
});

test("recurrence calculation failures roll back completion and disabling repeat stops successors", async () => {
  const impossible = await makeTask({ dueDate: "9999-12-31T23:59:00Z", repeatRule: "daily" });
  await assert.rejects(updateTask(user.id, impossible.taskId, { status: "done", title: "Must roll back" }), error => error.code === "VALIDATION_ERROR");
  const row = await db.task.findUnique({ where: { id: impossible.taskId } });
  assert.equal(row.status, "todo");
  assert.equal(row.title, "Task reminder");
  assert.equal(row.repeatGenerated, false);
  const normal = await makeTask({ repeatRule: "monthly" });
  assert.equal((await updateTask(user.id, normal.taskId, { status: "done", repeatRule: "none" })).nextTask, null);
});

test("reminder claims are bounded, owned, persistent and exclusive under concurrent polling", async () => {
  for (let i = 0; i < 13; i++) await makeTask({ title: `Due ${i}` });
  await makeTask({}, other);
  await makeTask({ reminderEnabled: false });
  await makeTask({ dueDate: "2099-01-01T00:00:00Z" });
  const done = await makeTask();
  await updateTask(user.id, done.taskId, { status: "done" }, now);
  const results = await settled(Array.from({ length: 4 }, () => claimTaskReminders(user.id, now)));
  assert.ok(results.every(items => items.length <= 10));
  const ids = results.flat().map(item => item.id);
  assert.equal(ids.length, 13);
  assert.equal(new Set(ids).size, 13);
  await db.$disconnect();
  assert.deepEqual(await claimTaskReminders(user.id, now), []);
  assert.equal((await claimTaskReminders(other.id, now)).length, 1);
});

test("reminder toggles and reopen do not replay a claim, but rescheduling creates a new reminder", async () => {
  const created = await makeTask();
  assert.equal((await claimTaskReminders(user.id, now)).length, 1);
  await updateTask(user.id, created.taskId, { reminderEnabled: false, status: "done" }, now);
  await updateTask(user.id, created.taskId, { reminderEnabled: true, status: "todo" }, now);
  assert.deepEqual(await claimTaskReminders(user.id, now), []);
  await updateTask(user.id, created.taskId, { dueDate: "2026-08-30T09:30:00Z" }, now);
  assert.equal((await claimTaskReminders(user.id, now)).length, 1);
});

test("reminder HTTP boundary enforces desktop cookie, Host, Origin, ownership and quotas", async () => {
  const created = await makeTask({ dueDate: "2000-01-01T00:00:00Z" });
  assert.equal((await reminders.POST(request("tasks/reminders", undefined, { cookie: "" }))).status, 401);
  assert.equal((await reminders.POST(request("tasks/reminders"))).status, 403);
  process.env.APP_RUNTIME = "desktop";
  for (const headers of [{ cookie: "" }, { host: "attacker.invalid" }, { origin: "https://attacker.invalid" }]) {
    assert.equal((await reminders.POST(request("tasks/reminders", undefined, headers))).status, 403);
  }
  assert.equal((await reminders.POST(request("tasks/reminders", { userId: other.id }))).status, 400);
  assert.equal((await db.task.findUnique({ where: { id: created.taskId } })).remindedAt, null);
  const response = await reminders.POST(request("tasks/reminders"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.map(task => task.id), [created.taskId]);
  for (let i = 0; i < 8; i++) assert.equal((await reminders.POST(request("tasks/reminders"))).status, 200);
  const limited = await reminders.POST(request("tasks/reminders"));
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
});

test("schedule mutations cannot reach foreign tasks or use expired sessions", async () => {
  const foreign = await makeTask({}, other);
  assert.equal((await taskRoute.PATCH(request("tasks/id", { reminderEnabled: false }), { params: Promise.resolve({ id: foreign.taskId }) })).status, 404);
  await db.session.updateMany({ where: { userId: user.id }, data: { expiresAt: date("2000-01-01T00:00:00Z") } });
  const owned = await makeTask();
  assert.equal((await taskRoute.PATCH(request("tasks/id", { repeatRule: "daily" }), { params: Promise.resolve({ id: owned.taskId }) })).status, 401);
  process.env.APP_RUNTIME = "desktop";
  assert.equal((await reminders.POST(request("tasks/reminders"))).status, 401);
  assert.equal((await db.task.findUnique({ where: { id: owned.taskId } })).remindedAt, null);
});
