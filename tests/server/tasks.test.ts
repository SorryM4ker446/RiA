import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { languageModel, providerState } from "../helpers/model-provider";
import { seedTestModelPreferences } from "../helpers/model-library";

const cleanup = createTestDatabase();
process.env.RIA_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const { nextCronOccurrence, parseCron, parseRunTime, presetOfCron, cronOfPreset } = await import("@/lib/scheduler/cron");
const { createTask, updateTask, deleteTask, listTasks, claimDueTask, completeTask, releaseInterruptedTasks } = await import("@/lib/scheduler/jobs");
const { runDueTask, startDueTask, startTaskNow, stopTask, startScheduler } = await import("@/lib/scheduler/runner");
const { claimNoticesToAnnounce } = await import("@/lib/scheduler/notices");
const { listScheduledRuns } = await import("@/lib/scheduler/history");
const { exclusiveDataOperation } = await import("@/lib/server/data-operations");
const { decodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
const runRoute = await import("@/app/api/tasks/[id]/run/route");
const stopRoute = await import("@/app/api/tasks/[id]/stop/route");
const runsRoute = await import("@/app/api/tasks/runs/route");
const notificationsRoute = await import("@/app/api/tasks/notifications/route");

const HOUR = 3_600_000;
let cookie: string;
const req = (path: string, method = "GET", authenticated = true) =>
  new NextRequest(`http://localhost${path}`, { method, headers: { host: "localhost", ...(authenticated ? { cookie } : {}) } });
const context = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  globalThis.__riaRateLimitStore?.clear();
  process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  process.env.APP_RUNTIME = "test";
  providerState.streamGate = undefined;
  providerState.streamError = false;
  cookie = localAccessCookie();
  await db.scheduledRun.deleteMany({});
  await db.scheduledJob.deleteMany({});
  await db.appNotice.deleteMany({});
  await db.agentRun.deleteMany({});
  await db.chat.deleteMany({});
  await db.workspacePreference.deleteMany({});
  await seedTestModelPreferences(db);
});
after(async () => { await db.$disconnect(); cleanup(); });

const daily = (overrides: Record<string, unknown> = {}) => ({ kind: "backupReminder" as const, title: "Reminder", enabled: true, cron: "0 9 * * *", timeZone: "UTC", ...overrides });
const prompt = (overrides: Record<string, unknown> = {}) => ({ kind: "prompt" as const, title: "Morning note", prompt: "Write the morning note.", enabled: true, cron: "0 9 * * *", timeZone: "UTC", ...overrides });
const makeDue = (id: string) => db.scheduledJob.update({ where: { id }, data: { nextRunAt: new Date(Date.now() - HOUR) } });
const iso = (value: Date | null) => value?.toISOString();

// --- when a task runs ---------------------------------------------------------

test("a cron expression names the next time in the task's own zone", () => {
  const from = new Date("2026-11-10T03:00:00Z"); // a Tuesday
  assert.equal(iso(nextCronOccurrence("0 9 * * *", "UTC", from)), "2026-11-10T09:00:00.000Z");
  assert.equal(iso(nextCronOccurrence("0 9 * * *", "Asia/Shanghai", from)), "2026-11-11T01:00:00.000Z", "09:00 in Shanghai has passed today");
  assert.equal(iso(nextCronOccurrence("30 8 * * 1-5", "UTC", new Date("2026-11-13T09:00:00Z"))), "2026-11-16T08:30:00.000Z", "Friday after the time waits for Monday");
  assert.equal(iso(nextCronOccurrence("*/15 * * * *", "UTC", new Date("2026-11-10T03:07:00Z"))), "2026-11-10T03:15:00.000Z");
  assert.equal(iso(nextCronOccurrence("0 9 1 * *", "UTC", from)), "2026-12-01T09:00:00.000Z");
  assert.equal(iso(nextCronOccurrence("0 0 29 2 *", "UTC", from)), "2028-02-29T00:00:00.000Z", "a leap day is found years ahead");
  assert.equal(iso(nextCronOccurrence("0 9 * * 7", "UTC", from)), "2026-11-15T09:00:00.000Z", "7 is Sunday too");
  // When both day fields name days, either is enough.
  assert.equal(iso(nextCronOccurrence("0 9 13 * 1", "UTC", from)), "2026-11-13T09:00:00.000Z");
  // An occurrence exactly at `from` counts; the caller asks from one millisecond later to move on.
  assert.equal(iso(nextCronOccurrence("0 9 * * *", "UTC", new Date("2026-11-10T09:00:00Z"))), "2026-11-10T09:00:00.000Z");
});

test("a schedule keeps its wall-clock hour across daylight saving, and a skipped hour costs one run", () => {
  // London springs forward on 29 March 2026 and falls back on 25 October.
  assert.equal(iso(nextCronOccurrence("0 9 * * *", "Europe/London", new Date("2026-03-28T12:00:00Z"))), "2026-03-29T08:00:00.000Z");
  assert.equal(iso(nextCronOccurrence("0 9 * * *", "Europe/London", new Date("2026-10-24T12:00:00Z"))), "2026-10-25T09:00:00.000Z");
  // 01:30 does not happen on the spring-forward day: that day is skipped, not nudged to another hour.
  assert.equal(iso(nextCronOccurrence("30 1 * * *", "Europe/London", new Date("2026-03-28T12:00:00Z"))), "2026-03-30T00:30:00.000Z");
  // 01:30 happens twice on the fall-back day: the task runs at the first and not again at the second.
  const first = nextCronOccurrence("30 1 * * *", "Europe/London", new Date("2026-10-24T12:00:00Z"))!;
  assert.equal(iso(first), "2026-10-25T00:30:00.000Z");
  assert.equal(iso(nextCronOccurrence("30 1 * * *", "Europe/London", new Date(first.getTime() + 1))), "2026-10-26T01:30:00.000Z");
});

test("expressions that are not schedules are refused, and ones that never occur have no next time", () => {
  for (const bad of ["", "0 9 * *", "0 9 * * * *", "60 9 * * *", "0 24 * * *", "0 9 0 * *", "0 9 * 13 *", "0 9 * * 8", "a b c d e", "5-1 * * * *", "*/0 * * * *", "*-5 * * * *"]) {
    assert.equal(parseCron(bad), null, `"${bad}" is not a schedule`);
  }
  assert.ok(parseCron("0,30 9-17/2 1,15 */3 1-5"));
  assert.equal(nextCronOccurrence("0 0 31 2 *", "UTC", new Date("2026-01-01T00:00:00Z")), null);
});

test("a time to run once is read in the task's zone, and a time that does not exist is refused", () => {
  assert.equal(iso(parseRunTime("2026-12-01T09:30", "Asia/Shanghai")), "2026-12-01T01:30:00.000Z");
  assert.equal(iso(parseRunTime("2026-12-01T09:30:00+02:00", "Asia/Shanghai")), "2026-12-01T07:30:00.000Z", "an offset names the instant itself");
  assert.equal(parseRunTime("2026-06-31T09:30", "UTC"), null);
  assert.equal(parseRunTime("2026-03-29T01:30", "Europe/London"), null, "the clocks jumped over it");
  assert.equal(parseRunTime("tomorrow", "UTC"), null);
});

test("a schedule chosen in the form opens as the same choice", () => {
  const presets = [
    { type: "hourly", minute: 5 }, { type: "daily", time: "09:00" }, { type: "weekdays", time: "18:30" },
    { type: "weekly", time: "07:05", dayOfWeek: 0 }, { type: "monthly", time: "09:00", dayOfMonth: 15 }, { type: "custom", cron: "0 9 1 1 *" },
  ] as const;
  for (const preset of presets) assert.deepEqual(presetOfCron(cronOfPreset(preset)), preset);
  assert.deepEqual(presetOfCron(null), { type: "once" });
});

// --- claiming and what a task owes ---------------------------------------------

test("a task that is off is never claimed, however overdue it is", async () => {
  const task = await createTask(daily({ enabled: false }));
  await makeDue(task.id);
  assert.equal(await claimDueTask(new Date()), null);
});

test("a due task is claimed once, so two polls cannot both run it", async () => {
  const task = await createTask(daily());
  await makeDue(task.id);
  const now = new Date();
  const claims = await Promise.all([claimDueTask(now), claimDueTask(now), claimDueTask(now)]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await db.scheduledRun.count(), 1, "the claim and its run record commit together");
  const [first, second] = await Promise.all([runDueTask(now), runDueTask(now)]);
  assert.equal([first, second].filter(Boolean).length, 0, "a task still marked running is not claimed again");
});

test("a machine that was asleep catches up once rather than replaying every occurrence", async () => {
  const task = await createTask(daily());
  await db.scheduledJob.update({ where: { id: task.id }, data: { nextRunAt: new Date(Date.now() - 7 * 24 * HOUR) } });
  assert.ok(await runDueTask(new Date()));
  assert.equal(await runDueTask(new Date()), null, "one run was owed, not seven");
  const [after_] = await listTasks();
  assert.ok(new Date(after_.nextRunAt) > new Date());
  assert.equal(after_.lastStatus, "done");
});

test("a task that runs once is switched off after it has run, and asks for a new time before it runs again", async () => {
  const task = await createTask(daily({ cron: null, runAt: new Date(Date.now() + HOUR).toISOString() }));
  assert.equal(task.cron, null);
  assert.equal(await claimDueTask(new Date()), null, "not before its time");
  await makeDue(task.id);
  assert.ok(await runDueTask(new Date()));
  const [ran] = await listTasks();
  assert.equal(ran.enabled, false);
  assert.equal(ran.lastStatus, "done");
  await assert.rejects(updateTask(task.id, { enabled: true }), /Choose a new time/);
  const again = await updateTask(task.id, { enabled: true, runAt: new Date(Date.now() + 2 * HOUR).toISOString() });
  assert.equal(again?.enabled, true);
  await assert.rejects(updateTask(task.id, { runAt: "2020-01-01T09:00" }), /already passed/);
});

test("editing the schedule changes what is owed, and pausing does not", async () => {
  const task = await createTask(daily());
  const paused = await updateTask(task.id, { enabled: false });
  const resumed = await updateTask(task.id, { enabled: true });
  assert.equal(paused?.nextRunAt, task.nextRunAt);
  assert.equal(resumed?.nextRunAt, task.nextRunAt);
  const moved = await updateTask(task.id, { cron: "0 21 * * *" });
  assert.notEqual(moved?.nextRunAt, task.nextRunAt);
  await assert.rejects(updateTask(task.id, { cron: null }), /needs a date and time/, "ending the repeat needs a time to run once");
  const once = await updateTask(task.id, { runAt: new Date(Date.now() + HOUR).toISOString() });
  assert.equal(once?.cron, null, "a time to run once ends the repeat");
  await assert.rejects(updateTask(task.id, { prompt: "Not for a built-in action" }), /takes no prompt/);
});

test("a backup task makes a real archive without a model, and its run says which", async () => {
  const task = await createTask(daily({ kind: "scheduledBackup", title: "Nightly backup" }));
  await makeDue(task.id);
  const run = await runDueTask(new Date());
  assert.equal(run?.outcome.status, "succeeded");
  assert.ok(run?.outcome.backupId);
  const [record] = await listScheduledRuns(task.id);
  assert.equal(record.backupId, run?.outcome.backupId); assert.equal(record.chatId, null);
  assert.equal(await db.chat.count(), 0, "a built-in action has no conversation");
  assert.equal(await db.modelRequest.count(), 0);
});

test("a kind this version does not know is skipped rather than guessed at", async () => {
  await db.scheduledJob.create({ data: { kind: "somethingNewer", title: "From a later version", enabled: true, cron: "0 9 * * *", timeZone: "UTC", nextRunAt: new Date(Date.now() - HOUR) } });
  const run = await runDueTask(new Date());
  assert.deepEqual(run?.outcome, { status: "failed", error: "UNSUPPORTED_KIND" });
  assert.equal(await runDueTask(new Date()), null, "and it is not picked up again on the next poll");
});

test("a run interrupted by the process going away is released once and not owed again", async () => {
  const repeating = await createTask(daily());
  const once = await createTask(daily({ title: "Once", cron: null, runAt: new Date(Date.now() + HOUR).toISOString() }));
  const untouched = await createTask(daily({ title: "Untouched" }));
  await db.scheduledJob.updateMany({ where: { id: { in: [repeating.id, once.id] } }, data: { nextRunAt: new Date(Date.now() - HOUR) } });
  assert.ok(await claimDueTask(new Date())); assert.ok(await claimDueTask(new Date()));
  assert.equal(await releaseInterruptedTasks(new Date()), 2);
  assert.equal(await releaseInterruptedTasks(new Date()), 0);
  const rows = new Map((await listTasks()).map(task => [task.id, task]));
  assert.equal(rows.get(repeating.id)?.lastStatus, "interrupted");
  assert.ok(new Date(rows.get(repeating.id)!.nextRunAt) > new Date());
  assert.equal(rows.get(once.id)?.enabled, false, "a task that runs once is not replayed after a restart");
  assert.equal(rows.get(untouched.id)?.nextRunAt, untouched.nextRunAt);
  assert.deepEqual((await db.scheduledRun.findMany()).map(run => run.status), ["interrupted", "interrupted"]);
  // A completion arriving late from the old process cannot overwrite the interruption.
  const stale = await db.scheduledRun.findFirstOrThrow();
  await completeTask(repeating.id, { status: "succeeded" }, new Date(), stale.id);
  assert.equal((await db.scheduledRun.findUniqueOrThrow({ where: { id: stale.id } })).status, "interrupted");
});

test("a restore in progress defers a due task without claiming it", async () => {
  const task = await createTask(daily());
  await makeDue(task.id);
  await exclusiveDataOperation(async () => { assert.equal(await startDueTask(new Date()), null); });
  assert.equal(await db.scheduledRun.count(), 0);
  assert.ok(await runDueTask(new Date()), "it runs once the restore is over");
});

test("the poller starts every task that is due and starts once per process", async () => {
  const first = await createTask(daily({ title: "First" }));
  const second = await createTask(daily({ title: "Second" }));
  await makeDue(first.id); await makeDue(second.id);
  const scheduler = startScheduler();
  await scheduler.tick();
  for (let attempt = 0; attempt < 200 && (await listTasks()).some(task => task.lastStatus !== "done"); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual((await listTasks()).map(task => task.lastStatus), ["done", "done"], "one look started both");
  await scheduler.tick();
  const other = startScheduler();
  scheduler.start(); other.start();
  try {
    assert.ok((globalThis as { schedulerTimer?: unknown }).schedulerTimer);
    other.stop();
    assert.ok((globalThis as { schedulerTimer?: unknown }).schedulerTimer, "a scheduler that did not start the timer cannot stop it");
  } finally { scheduler.stop(); }
  assert.equal((globalThis as { schedulerTimer?: unknown }).schedulerTimer, undefined);
});

// --- a prompt runs in the task's own conversation --------------------------------

test("every run of a task continues the same conversation", async () => {
  const task = await createTask(prompt());
  await makeDue(task.id);
  const first = await runDueTask(new Date());
  assert.equal(first?.outcome.status, "succeeded");
  const chatId = first!.outcome.chatId!;
  assert.equal((await db.chat.findUniqueOrThrow({ where: { id: chatId } })).title, "Morning note");
  await makeDue(task.id);
  const second = await runDueTask(new Date());
  assert.equal(second?.outcome.chatId, chatId);
  assert.equal(await db.chat.count(), 1, "a task does not leave a conversation behind for every run");
  const messages = await db.message.findMany({ where: { chatId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  assert.deepEqual(messages.map(message => message.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(messages[0].content, "Write the morning note.");
  assert.match(messages[1].content, /Generated answer/);
  assert.equal((await listTasks())[0].chatId, chatId);
  const runs = await listScheduledRuns(task.id);
  assert.deepEqual(runs.map(run => [run.status, run.chatId, run.title]), [["succeeded", chatId, "Morning note"], ["succeeded", chatId, "Morning note"]]);
});

test("the second run is sent what the first one said", async (t) => {
  const task = await createTask(prompt());
  await makeDue(task.id);
  await runDueTask(new Date());
  const prompts: string[] = [];
  const stream = languageModel.doStream;
  t.mock.method(languageModel, "doStream", async (options: Parameters<typeof stream>[0]) => { prompts.push(JSON.stringify(options.prompt)); return stream.call(languageModel, options); });
  await makeDue(task.id);
  await runDueTask(new Date());
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Generated answer/, "the earlier answer is part of the conversation the model continues");
  assert.equal(prompts[0].split("Write the morning note.").length - 1, 2);
});

test("a conversation the user deleted is replaced by a new one on the next run", async () => {
  const task = await createTask(prompt());
  await makeDue(task.id);
  const first = await runDueTask(new Date());
  await db.chat.delete({ where: { id: first!.outcome.chatId! } });
  assert.equal((await listTasks())[0].chatId, null);
  await makeDue(task.id);
  const second = await runDueTask(new Date());
  assert.equal(second?.outcome.status, "succeeded");
  assert.notEqual(second?.outcome.chatId, first?.outcome.chatId);
  assert.equal(await db.chat.count(), 1);
});

test("a provider failure fails the run, keeps the task, and says so once", async () => {
  const task = await createTask(prompt());
  await makeDue(task.id);
  providerState.streamError = true;
  const run = await runDueTask(new Date());
  assert.equal(run?.outcome.status, "failed");
  assert.ok(run?.outcome.error);
  const [row] = await listTasks();
  assert.equal(row.lastStatus, "failed"); assert.equal(row.enabled, true);
  providerState.streamError = false;
  await makeDue(task.id);
  assert.equal((await runDueTask(new Date()))?.outcome.status, "succeeded");
  const notices = await db.appNotice.findMany({ where: { kind: "taskRun" } });
  assert.equal(notices.length, 1, "one notice per task, refreshed by each run");
  assert.equal(notices[0].title, "task-finished");
  assert.equal(notices[0].href, `/chat?conversationId=${row.chatId}`);
});

test("a tool that asks first stops the run until the user answers, and later runs wait behind it", async (t) => {
  const task = await createTask(prompt());
  await makeDue(task.id);
  let calls = 0;
  t.mock.method(languageModel, "doStream", async () => {
    calls += 1;
    return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "tool-call", toolCallId: "ask-first", toolName: "createTask", input: JSON.stringify({ title: "Follow-up", prompt: "Follow up.", cron: "0 9 * * *", timeZone: "UTC" }) });
      controller.enqueue({ type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
      controller.close();
    } }) };
  });
  const run = await runDueTask(new Date());
  assert.equal(run?.outcome.status, "waiting_approval");
  assert.equal(await db.scheduledJob.count(), 1, "nothing was approved on the user's behalf");
  const saved = await db.message.findFirstOrThrow({ where: { chatId: run!.outcome.chatId!, role: "assistant" } });
  assert.equal(decodePersistedAssistantToolMessage(saved.content)?.tools[0].state, "approval-requested", "the request is in the conversation for the user to answer");
  assert.equal((await listTasks())[0].lastStatus, "waiting_approval");
  assert.equal((await db.appNotice.findFirstOrThrow({ where: { kind: "taskRun" } })).title, "task-needs-approval");

  await makeDue(task.id);
  const next = await runDueTask(new Date());
  assert.equal(next?.outcome.status, "waiting_approval");
  assert.equal(calls, 1, "the next run does not send another message past the open request");
  assert.equal(await db.message.count({ where: { chatId: run!.outcome.chatId! } }), 2);
});

test("a task can be run now whether or not it is on, and stopped while it runs", async () => {
  const task = await createTask(prompt({ enabled: false }));
  let release!: () => void;
  providerState.streamGate = new Promise<void>(resolve => { release = resolve; });
  try {
    const started = await runRoute.POST(req(`/api/tasks/${task.id}/run`, "POST"), context(task.id));
    assert.equal(started.status, 202);
    assert.equal((await listTasks())[0].lastStatus, "running");
    assert.equal((await runRoute.POST(req(`/api/tasks/${task.id}/run`, "POST"), context(task.id))).status, 409, "it is already running");
    await assert.rejects(deleteTask(task.id), /running/);
    assert.equal((await stopRoute.POST(req(`/api/tasks/${task.id}/stop`, "POST"), context(task.id))).status, 202);
  } finally { release(); }
  for (let attempt = 0; attempt < 300 && (await listTasks())[0].lastStatus === "running"; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
  const [row] = await listTasks();
  assert.equal(row.lastStatus, "failed"); assert.equal(row.lastError, "ABORTED");
  assert.equal(row.enabled, false, "running it by hand did not switch it on");
  const [record] = await listScheduledRuns(task.id);
  assert.equal(record.trigger, "manual"); assert.equal(record.status, "failed");
  assert.equal((await stopRoute.POST(req(`/api/tasks/${task.id}/stop`, "POST"), context(task.id))).status, 409);
  assert.equal(stopTask(task.id), false);
  assert.deepEqual(await deleteTask(task.id), { deleted: true });
  assert.equal(await db.chat.count(), 1, "deleting a task keeps its conversation");
  assert.equal((await listScheduledRuns())[0].title, null, "and its runs stay on record");
  await assert.rejects(startTaskNow(task.id), (error: { code?: string }) => error.code === "NOT_FOUND");
});

test("a run due while the user is getting an answer in its conversation waits for that answer, then runs", async () => {
  const { holdTurn, isTurnLive } = await import("@/lib/chat/live-turns");
  const task = await createTask(prompt());
  await (await startTaskNow(task.id)).finished;
  const chatId = (await db.scheduledJob.findUniqueOrThrow({ where: { id: task.id } })).chatId!;
  // The user's turn in that conversation, held open by the test.
  let end!: () => void;
  const yours = await holdTurn(chatId, async () => new Response(new ReadableStream({ start(controller) { end = () => controller.close(); } }), { headers: { "content-type": "text/event-stream" } }), { source: "chat" });
  const reading = new Response(yours.body).text();
  await makeDue(task.id);
  const started = await startDueTask(new Date());
  assert.ok(started);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await db.message.count({ where: { chatId, role: "assistant" } })), 1, "the run has not answered while the user's turn runs");
  assert.equal(isTurnLive(chatId), true);
  end();
  await reading;
  const outcome = await started!.finished;
  assert.equal(outcome.status, "succeeded", "it ran once the conversation was free, rather than failing");
  assert.equal(await db.message.count({ where: { chatId, role: "assistant" } }), 2);
});

// --- telling the user ----------------------------------------------------------

test("a notice is handed to the desktop once, and again only after the task runs again", async () => {
  const task = await createTask(prompt());
  await makeDue(task.id);
  await runDueTask(new Date());
  const [first, second] = await Promise.all([claimNoticesToAnnounce(), claimNoticesToAnnounce()]);
  assert.equal(first.length + second.length, 1);
  assert.deepEqual(await claimNoticesToAnnounce(), []);
  await makeDue(task.id);
  await runDueTask(new Date());
  assert.equal((await claimNoticesToAnnounce()).length, 1, "a new run is announced again");
  await db.appNotice.updateMany({ data: { notifiedAt: null, readAt: new Date() } });
  assert.deepEqual(await claimNoticesToAnnounce(), [], "a notice the user already read is not announced");
});

test("task routes need the local credential, and notifications are for the desktop alone", async () => {
  const task = await createTask(daily());
  for (const call of [
    () => runRoute.POST(req(`/api/tasks/${task.id}/run`, "POST", false), context(task.id)),
    () => stopRoute.POST(req(`/api/tasks/${task.id}/stop`, "POST", false), context(task.id)),
    () => runsRoute.GET(req("/api/tasks/runs", "GET", false)),
    () => notificationsRoute.POST(req("/api/tasks/notifications", "POST", false)),
  ]) assert.equal((await call()).status, 401);
  assert.equal((await notificationsRoute.POST(req("/api/tasks/notifications", "POST"))).status, 403);
  assert.equal((await runsRoute.GET(req("/api/tasks/runs?taskId=not%20an%20id"))).status, 400);
  // The desktop presents its own session, on the host its service listens on.
  Object.assign(process.env, { APP_RUNTIME: "desktop", DESKTOP_SERVER_HOST: "localhost", DESKTOP_SESSION_TOKEN: "desktop-session-placeholder" });
  try {
    const desktop = () => new NextRequest("http://localhost/api/tasks/notifications", { method: "POST", headers: { host: "localhost", cookie: "desktop_session=desktop-session-placeholder" } });
    assert.equal((await notificationsRoute.POST(req("/api/tasks/notifications", "POST"))).status, 403, "the browser credential is not the desktop's");
    await db.appNotice.create({ data: { kind: "taskRun", title: "task-finished", detail: "Reminder", href: "/chat", fingerprint: `task:${task.id}` } });
    const response = await notificationsRoute.POST(desktop());
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data.map((notice: { title: string; detail: string }) => [notice.title, notice.detail]), [["task-finished", "Reminder"]]);
    assert.deepEqual((await (await notificationsRoute.POST(desktop())).json()).data, []);
  } finally {
    process.env.APP_RUNTIME = "test"; delete process.env.DESKTOP_SERVER_HOST; delete process.env.DESKTOP_SESSION_TOKEN;
  }
});

test("running a one-off task by hand before its time leaves that time still to come", async () => {
  const at = new Date(Date.now() + 2 * HOUR);
  const task = await createTask(daily({ cron: null, runAt: at.toISOString() }));
  const started = await startTaskNow(task.id);
  assert.equal((await started.finished).status, "succeeded");
  const [row] = await listTasks();
  assert.equal(row.enabled, true, "it is still on");
  assert.equal(row.nextRunAt, at.toISOString(), "and still owed at the time it was set for");
  await db.scheduledJob.update({ where: { id: task.id }, data: { nextRunAt: new Date(Date.now() - 1000) } });
  assert.ok(await runDueTask(new Date()));
  assert.equal((await listTasks())[0].enabled, false, "the run at its own time uses it up");
});

// --- background limits ---------------------------------------------------------

const { getModelPreferences, saveModelPreferences } = await import("@/lib/models/preferences");
async function callLimits(patch: Record<string, number>) {
  const preferences = await getModelPreferences();
  await saveModelPreferences({ ...preferences, callLimits: { ...preferences.callLimits, ...patch } });
}

test("a run that starts on its own is billed as background work, one the user starts is not", async (t) => {
  const { modelCallSource } = await import("@/lib/models/call-context");
  const sources: string[] = [];
  const stream = languageModel.doStream;
  t.mock.method(languageModel, "doStream", async (options: Parameters<typeof stream>[0]) => { sources.push(modelCallSource()); return stream.call(languageModel, options); });
  const task = await createTask(prompt());
  await makeDue(task.id);
  await runDueTask(new Date());
  assert.deepEqual([...new Set(sources)], ["scheduled"]);
  sources.length = 0;
  await (await startTaskNow(task.id)).finished;
  assert.deepEqual([...new Set(sources)], ["chat"]);
});

test("past the day's run limit a run is skipped, says so, and sends nothing; a run by hand still goes", async () => {
  await db.modelCallDay.deleteMany({});
  await callLimits({ backgroundDailyCalls: 1 });
  const task = await createTask(prompt());
  await makeDue(task.id);
  assert.equal((await runDueTask(new Date()))?.outcome.status, "succeeded");
  const before = await db.message.count();
  await makeDue(task.id);
  const skipped = await runDueTask(new Date());
  assert.deepEqual(skipped?.outcome.status, "skipped");
  assert.equal(skipped?.outcome.error, "BACKGROUND_LIMIT");
  assert.equal(await db.message.count(), before, "nothing was sent");
  const [row] = await listTasks();
  assert.equal(row.lastStatus, "skipped"); assert.equal(row.enabled, true);
  assert.ok(new Date(row.nextRunAt) > new Date(), "the next run goes ahead as planned");
  assert.equal((await listScheduledRuns(task.id))[0].status, "skipped");
  assert.equal((await db.appNotice.findFirstOrThrow({ where: { kind: "taskRun" } })).title, "task-skipped");
  assert.equal((await (await startTaskNow(task.id)).finished).status, "succeeded", "the user's own run is not background work");
  await db.modelCallDay.deleteMany({});
});

test("a task's conversation starts with long-term memory off", async () => {
  const task = await createTask(prompt());
  await makeDue(task.id);
  const run = await runDueTask(new Date());
  assert.equal((await db.chat.findUniqueOrThrow({ where: { id: run!.outcome.chatId! } })).ephemeral, true);
});

test("prompts falling due together queue for the background places instead of being refused", async () => {
  await db.modelCallDay.deleteMany({});
  // Two call places leave one for background prompts.
  await callLimits({ maxConcurrent: 2 });
  const first = await createTask(prompt({ title: "First" }));
  const second = await createTask(prompt({ title: "Second" }));
  await makeDue(first.id); await makeDue(second.id);
  let release!: () => void;
  providerState.streamGate = new Promise<void>(resolve => { release = resolve; });
  const scheduler = startScheduler();
  scheduler.start();
  try {
    const states = async () => Object.fromEntries((await listTasks()).map(task => [task.title, task.lastStatus]));
    for (let attempt = 0; attempt < 200 && (await states()).First !== "running" && (await states()).Second !== "running"; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(Object.values(await states()).sort(), ["running", null].sort() as never, "only one prompt started");
    assert.equal(await claimDueTask(new Date(), { prompts: false }), null, "a due prompt is not taken when prompts are held back");
    release();
    for (let attempt = 0; attempt < 400 && Object.values(await states()).some(status => status !== "done"); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(Object.values(await states()), ["done", "done"], "the waiting one started when the place freed up, without waiting for the next poll");
    assert.equal(await db.modelRequest.count({ where: { errorCode: "CONFLICT" } }), 0);
  } finally { release(); scheduler.stop(); providerState.streamGate = undefined; await callLimits({ maxConcurrent: 4 }); }
});

test("a run waiting for the user's answer gives its background place to other due tasks meanwhile", async () => {
  const { holdTurn } = await import("@/lib/chat/live-turns");
  await db.modelCallDay.deleteMany({});
  // Two call places leave one for background prompts.
  await callLimits({ maxConcurrent: 2 });
  const waiting = await createTask(prompt({ title: "Waiting" }));
  await (await startTaskNow(waiting.id)).finished;
  const chatId = (await db.scheduledJob.findUniqueOrThrow({ where: { id: waiting.id } })).chatId!;
  let end!: () => void, ended = false;
  const yours = await holdTurn(chatId, async () => new Response(new ReadableStream({ start(controller) { end = () => { if (!ended) { ended = true; controller.close(); } }; } }), { headers: { "content-type": "text/event-stream" } }), { source: "chat" });
  const reading = new Response(yours.body).text();
  try {
    await makeDue(waiting.id);
    const started = await startDueTask(new Date(), { prompts: true });
    assert.ok(started);
    await new Promise(resolve => setTimeout(resolve, 50));
    // Another task falls due while the first waits: the place is free for it.
    const other = await createTask(prompt({ title: "Other" }));
    await makeDue(other.id);
    const scheduler = startScheduler();
    await scheduler.tick();
    for (let attempt = 0; attempt < 300 && (await db.scheduledJob.findUniqueOrThrow({ where: { id: other.id } })).lastStatus !== "done"; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await db.scheduledJob.findUniqueOrThrow({ where: { id: other.id } })).lastStatus, "done", "the other task ran while the first waited");
    assert.equal((await db.scheduledJob.findUniqueOrThrow({ where: { id: waiting.id } })).lastStatus, "running", "the first is still waiting for the user's answer");
    end();
    await reading;
    assert.equal((await started!.finished).status, "succeeded", "it took a place again and ran once the answer ended");
  } finally { end(); await callLimits({ maxConcurrent: 4 }); }
});

// --- answered approvals, stale pages, missed times, wording ---------------------

const chatRoute = await import("@/app/api/chat/route");
const tasksRoute = await import("@/app/api/tasks/route");
const declineRoute = await import("@/app/api/conversations/[id]/messages/[messageId]/decline/route");
const conversationRoute = await import("@/app/api/conversations/[id]/route");
const localeRoute = await import("@/app/api/interface-locale/route");
const putJson = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method: "PUT", headers: { host: "localhost", cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const { zhCN } = await import("@/lib/locale/zh-CN");
const { enUS } = await import("@/lib/locale/en-US");
const jsonRequest = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method: "POST", headers: { host: "localhost", cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
function askFirst(t: TestContext) {
  t.mock.method(languageModel, "doStream", async () => ({ stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
    controller.enqueue({ type: "stream-start", warnings: [] });
    controller.enqueue({ type: "tool-call", toolCallId: "ask-first", toolName: "createTask", input: JSON.stringify({ title: "Follow-up", prompt: "Follow up.", cron: "0 9 * * *", timeZone: "UTC" }) });
    controller.enqueue({ type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
    controller.close();
  } }) }));
}

test("a task stops saying it needs approval once the request is answered in its conversation", async (t) => {
  askFirst(t);
  const task = await createTask(prompt());
  await makeDue(task.id);
  const run = await runDueTask(new Date());
  t.mock.restoreAll();
  const chatId = run!.outcome.chatId!;
  const pending = await db.message.findFirstOrThrow({ where: { chatId, role: "assistant" } });
  const messageId = pending.clientMessageId ?? pending.id;
  // Giving the request up in the conversation.
  const declined = await declineRoute.POST(jsonRequest(`/api/conversations/${chatId}/messages/${messageId}/decline`, {}), { params: Promise.resolve({ id: chatId, messageId }) });
  assert.equal(declined.status, 200, await declined.clone().text());
  assert.equal((await listTasks())[0].lastStatus, "done");
  assert.ok((await db.appNotice.findFirstOrThrow({ where: { fingerprint: `task:${task.id}` } })).readAt, "its notice is no longer outstanding");

  // Moving on with another message settles it too, the next time the list is read.
  askFirst(t);
  await makeDue(task.id);
  await runDueTask(new Date());
  t.mock.restoreAll();
  assert.equal((await listTasks())[0].lastStatus, "waiting_approval");
  await db.message.create({ data: { chatId, role: "user", content: "Never mind, carry on.", status: "success" } });
  assert.equal((await tasksRoute.GET(req("/api/tasks"))).status, 200);
  assert.equal((await listTasks())[0].lastStatus, "done");
});

test("a message sent from a page that missed a task's run is answered with that run in view", async (t) => {
  const task = await createTask(prompt());
  await makeDue(task.id);
  const first = await runDueTask(new Date());
  const chatId = first!.outcome.chatId!;
  const loaded = await db.message.findMany({ where: { chatId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  // The task runs again while the page still shows the first run.
  await db.message.create({ data: { chatId, role: "user", content: "Second run prompt", status: "success", createdAt: new Date(Date.now() + 1000) } });
  await db.message.create({ data: { chatId, role: "assistant", content: "WHAT THE SECOND RUN SAID", status: "success", createdAt: new Date(Date.now() + 2000) } });
  const prompts: string[] = [];
  const stream = languageModel.doStream;
  t.mock.method(languageModel, "doStream", async (options: Parameters<typeof stream>[0]) => { prompts.push(JSON.stringify(options.prompt)); return stream.call(languageModel, options); });
  const stale = loaded.map(row => ({ id: row.clientMessageId ?? row.id, role: row.role, parts: [{ type: "text", text: row.content }] }));
  const response = await chatRoute.POST(new NextRequest("http://localhost/api/chat", { method: "POST", headers: { host: "localhost", cookie, "content-type": "application/json" },
    body: JSON.stringify({ chatId, messages: [...stale, { id: "from-the-stale-page", role: "user", parts: [{ type: "text", text: "What did it say just now?" }] }] }) }));
  assert.equal(response.status, 200, await response.clone().text());
  await response.text();
  assert.match(prompts[0], /WHAT THE SECOND RUN SAID/);
  assert.ok(prompts[0].indexOf("WHAT THE SECOND RUN SAID") < prompts[0].indexOf("What did it say just now?"), "in order, before the new message");
  // The conversation says a task writes into it, so an open page knows to look.
  assert.equal((await (await conversationRoute.GET(req(`/api/conversations/${chatId}`), context(chatId))).json()).data.task?.id, task.id);
});

test("a late run says when it was due and counts the times it stands in for", async (t) => {
  const prompts: string[] = [];
  const stream = languageModel.doStream;
  t.mock.method(languageModel, "doStream", async (options: Parameters<typeof stream>[0]) => { prompts.push(JSON.stringify(options.prompt)); return stream.call(languageModel, options); });
  const task = await createTask(prompt({ cron: "0 * * * *" }));
  const due = new Date(Date.now() - 3 * HOUR);
  await db.scheduledJob.update({ where: { id: task.id }, data: { nextRunAt: due } });
  assert.equal((await runDueTask(new Date()))?.outcome.status, "succeeded");
  assert.match(prompts[0], /was due at .* and is starting about 1[78]\d minutes late/);
  assert.match(prompts[0], /later scheduled time\(s\) of this task also passed/);
  const [run] = await listScheduledRuns(task.id);
  assert.equal(run.scheduledFor, due.toISOString());
  assert.equal(run.late, true);
  assert.ok(run.missedCount >= 2 && run.missedCount <= 3, `the hours in between are counted (${run.missedCount})`);
  // The note is reference data for the model, not part of the conversation.
  assert.equal(await db.message.count({ where: { content: { contains: "starting about" } } }), 0);
  // On time, nothing is said.
  prompts.length = 0;
  await db.scheduledJob.update({ where: { id: task.id }, data: { nextRunAt: new Date(Date.now() - 60_000) } });
  await runDueTask(new Date());
  // The first run keeps its note as it was sent; the new message carries none.
  const latest = (JSON.parse(prompts[0]) as Array<{ role: string; content: unknown }>).filter(message => message.role === "user").at(-1);
  assert.doesNotMatch(JSON.stringify(latest), /starting about/);
});

test("a task set not to catch up records a late time as missed and waits for the next", async () => {
  const task = await createTask(prompt({ catchUp: false }));
  assert.equal(task.catchUp, false);
  await makeDue(task.id);
  const run = await runDueTask(new Date());
  assert.equal(run?.outcome.status, "missed");
  assert.equal(await db.message.count(), 0, "nothing was sent");
  const [row] = await listTasks();
  assert.equal(row.lastStatus, "missed"); assert.equal(row.enabled, true);
  assert.ok(new Date(row.nextRunAt) > new Date());
  assert.equal((await listScheduledRuns(task.id))[0].status, "missed");
  assert.equal((await db.appNotice.findFirstOrThrow({ where: { fingerprint: `task:${task.id}` } })).title, "task-missed");
  // A run on time still goes.
  await db.scheduledJob.update({ where: { id: task.id }, data: { nextRunAt: new Date(Date.now() - 60_000) } });
  assert.equal((await runDueTask(new Date()))?.outcome.status, "succeeded");
  assert.equal((await updateTask(task.id, { catchUp: true }))?.catchUp, true);
});

test("a task made from a template is worded in the interface language each time it runs, until rewritten", async (t) => {
  const zh = (key: string) => (zhCN as Record<string, string>)[key], en = (key: string) => (enUS as Record<string, string>)[key];
  const prompts: string[] = [];
  const stream = languageModel.doStream;
  t.mock.method(languageModel, "doStream", async (options: Parameters<typeof stream>[0]) => { prompts.push(JSON.stringify(options.prompt)); return stream.call(languageModel, options); });
  const latestUser = () => JSON.stringify((JSON.parse(prompts.at(-1)!) as Array<{ role: string }>).filter(message => message.role === "user").at(-1));
  await db.interfacePreference.deleteMany({});
  const brief = await createTask({ kind: "prompt", template: "dailyBrief", title: "", enabled: true, cron: "0 9 * * *", timeZone: "UTC" });
  assert.deepEqual([brief.template, brief.title, brief.prompt], ["dailyBrief", "", null], "nothing of the wording is stored");

  assert.equal((await localeRoute.PUT(putJson("/api/interface-locale", { locale: "en-US" }))).status, 200);
  await makeDue(brief.id);
  await runDueTask(new Date());
  assert.ok(latestUser().includes(en("tasks.template.dailyBrief.prompt").slice(0, 40)), "worded in English");
  assert.equal((await db.chat.findUniqueOrThrow({ where: { id: (await listTasks())[0].chatId! } })).title, en("tasks.template.dailyBrief.title"));
  assert.equal((await listScheduledRuns(brief.id))[0].title, en("tasks.template.dailyBrief.title"));

  assert.equal((await localeRoute.PUT(putJson("/api/interface-locale", { locale: "zh-CN" }))).status, 200);
  await makeDue(brief.id);
  await runDueTask(new Date());
  assert.ok(latestUser().includes(zh("tasks.template.dailyBrief.prompt").slice(0, 20)), "the same task, now worded in Chinese");
  assert.equal((await listScheduledRuns(brief.id))[0].title, zh("tasks.template.dailyBrief.title"));

  // Rewritten, it stays as written; handed back, it follows the template again.
  await updateTask(brief.id, { prompt: "只看文档变化。" });
  await makeDue(brief.id);
  await runDueTask(new Date());
  assert.match(latestUser(), /只看文档变化/);
  assert.equal((await updateTask(brief.id, { prompt: null }))?.prompt, null);
  assert.equal((await localeRoute.PUT(putJson("/api/interface-locale", { locale: "fr-FR" }))).status, 400);
});

test("only a task made from a template can leave its name or prompt to it", async () => {
  await assert.rejects(createTask({ kind: "prompt", title: "", prompt: "Do it.", enabled: true, cron: "0 9 * * *", timeZone: "UTC" }), /needs a name/);
  await assert.rejects(createTask({ kind: "prompt", title: "No prompt", enabled: true, cron: "0 9 * * *", timeZone: "UTC" }), /needs a prompt/);
  await assert.rejects(createTask({ kind: "scheduledBackup", template: "dailyBrief", title: "x", cron: "0 9 * * *", timeZone: "UTC" }), /wording template/);
  const own = await createTask(prompt());
  await assert.rejects(updateTask(own.id, { title: "" }), /needs a name/);
  await assert.rejects(updateTask(own.id, { prompt: null }), /needs a prompt/);
});

test("without a language chosen in the app, the one the desktop passed at start is used", async () => {
  const { interfaceLocale } = await import("@/lib/scheduler/task-wording");
  await db.interfacePreference.deleteMany({});
  process.env.RIA_INTERFACE_LOCALE = "en-US";
  try {
    assert.equal(await interfaceLocale(), "en-US");
    await db.interfacePreference.create({ data: { id: "local", locale: "zh-CN" } });
    assert.equal(await interfaceLocale(), "zh-CN", "a language chosen in the app wins");
  } finally { delete process.env.RIA_INTERFACE_LOCALE; await db.interfacePreference.deleteMany({}); }
});

test("a task's conversation has what a general-assistant conversation has, apart from the memory it starts without", async (t) => {
  const offered: string[][] = [];
  const stream = languageModel.doStream;
  t.mock.method(languageModel, "doStream", async (options: Parameters<typeof stream>[0]) => {
    offered.push((options.tools ?? []).map(tool => tool.name).sort());
    return stream.call(languageModel, options);
  });
  // A conversation the user starts with no template: the general assistant.
  const general = await db.chat.create({ data: { title: "General" } });
  const response = await chatRoute.POST(new NextRequest("http://localhost/api/chat", { method: "POST", headers: { host: "localhost", cookie, "content-type": "application/json" },
    body: JSON.stringify({ chatId: general.id, messages: [{ id: "general-question", role: "user", parts: [{ type: "text", text: "Hello" }] }] }) }));
  assert.equal(response.status, 200, await response.clone().text());
  await response.text();
  const task = await createTask(prompt());
  await makeDue(task.id);
  const run = await runDueTask(new Date());
  const taskChat = await db.chat.findUniqueOrThrow({ where: { id: run!.outcome.chatId! } });
  // The same template (none), so the same whole library, and the same folder (none until the user picks one).
  assert.deepEqual([taskChat.assistantConfig, taskChat.workspaceGrantId], [general.assistantConfig, general.workspaceGrantId]);
  const [generalTools, taskTools] = offered;
  assert.ok(generalTools.includes("createTask") && generalTools.includes("extractMemory"));
  // Long-term memory is off in a task's conversation, so the tool that writes it is the one difference.
  assert.deepEqual(taskTools, generalTools.filter(name => name !== "extractMemory"));
  // Turning memory on for the task gives its conversation everything a general conversation has.
  await updateTask(task.id, { usesMemory: true });
  await makeDue(task.id);
  await runDueTask(new Date());
  assert.deepEqual(offered[2], generalTools);
});

// --- what a task decides for its conversation ---------------------------------

const TASK_MODEL = { providerId: "openrouter", modelId: "deepseek/deepseek-v4-pro" };
const chatPost = (chatId: string, text: string, model?: { providerId: string; modelId: string }) => chatRoute.POST(new NextRequest("http://localhost/api/chat", {
  method: "POST", headers: { host: "localhost", cookie, "content-type": "application/json" },
  body: JSON.stringify({ chatId, ...(model ? { model } : {}), messages: [{ id: `typed-${text.replace(/\W/g, "")}`, role: "user", parts: [{ type: "text", text }] }] }),
}));
const typedModel = async (chatId: string, text: string) => {
  const response = await chatPost(chatId, text);
  assert.equal(response.status, 200, await response.clone().text());
  await response.text();
  return response.headers.get("x-model-id");
};

test("a task's model decides every turn in its conversation, run or typed, and the default chat model stands in without one", async () => {
  const { CHAT_MODEL_REF } = await import("../helpers/model-library");
  const { parseChatRequest } = await import("@/lib/chat/request");
  // What a run sends: the conversation and the prompt, with no model named.
  const runRequest = (chatId: string) => parseChatRequest({ chatId, messages: [{ id: "run-prompt", role: "user", parts: [{ type: "text", text: "Write the morning note." }] }] });
  const task = await createTask(prompt({ model: TASK_MODEL }));
  assert.deepEqual(task.model, TASK_MODEL);
  await makeDue(task.id);
  const run = await runDueTask(new Date());
  assert.equal(run?.outcome.status, "succeeded");
  const chatId = run!.outcome.chatId!;
  assert.deepEqual((await runRequest(chatId)).modelRef, TASK_MODEL);
  // A message typed into the task's conversation names no model and still uses the task's.
  assert.equal(await typedModel(chatId, "And tomorrow?"), TASK_MODEL.modelId);
  // A page that names another model is told the model belongs to the task.
  const other = await chatPost(chatId, "Use another", CHAT_MODEL_REF);
  assert.equal(other.status, 400);
  assert.match(await other.text(), /uses the task's model/);
  // A template applied before this version no longer decides it either.
  await db.chat.update({ where: { id: chatId }, data: { assistantConfig: { templateId: "builtin_writing", templateRevision: 1, name: "Writing", model: CHAT_MODEL_REF, tools: [] } } });
  assert.deepEqual((await runRequest(chatId)).modelRef, TASK_MODEL);
  assert.equal((await runRequest(chatId)).assistant, null);
  await db.chat.update({ where: { id: chatId }, data: { assistantConfig: Prisma.DbNull } });
  // Handed back to the default, both follow the default chat model.
  assert.equal((await updateTask(task.id, { model: null }))?.model, null);
  assert.deepEqual((await runRequest(chatId)).modelRef, CHAT_MODEL_REF);
  assert.equal(await typedModel(chatId, "And now?"), CHAT_MODEL_REF.modelId);
});

test("a task's model must be one added for chat, and a built-in action takes no model or folder", async () => {
  await assert.rejects(createTask(prompt({ model: { providerId: "openrouter", modelId: "not/added" } })), /added for chat/);
  await assert.rejects(createTask(prompt({ model: { providerId: "openrouter", modelId: "google/gemini-2.5-flash-image" } })), /added for chat/, "an image model is not a chat model");
  await assert.rejects(createTask(daily({ model: TASK_MODEL })), /uses no model/);
  const grant = await db.directoryGrant.create({ data: { label: "Notes", path: "fixture/notes", realPath: "fixture/task-notes" } });
  try {
    await assert.rejects(createTask(daily({ workspaceGrantId: grant.id })), /uses no folder/);
    await assert.rejects(createTask(prompt({ workspaceGrantId: "not-a-grant" })), /尚未授权/);
  } finally { await db.directoryGrant.delete({ where: { id: grant.id } }); }
});

test("a task's conversation works in the task's folder and takes no assistant template", async () => {
  const { conversationWorkspace } = await import("@/lib/local-files/workspace");
  const { updateConversation } = await import("@/lib/conversations/mutations");
  const conversationRoute = await import("@/app/api/conversations/[id]/route");
  const grant = await db.directoryGrant.create({ data: { label: "Notes", path: "fixture/notes", realPath: "fixture/task-folder" } });
  try {
    const task = await createTask(prompt({ workspaceGrantId: grant.id }));
    await makeDue(task.id);
    const chatId = (await runDueTask(new Date()))!.outcome.chatId!;
    // The first run already works in the folder the task chose.
    assert.equal((await conversationWorkspace(chatId))?.id, grant.id);
    assert.equal((await db.chat.findUniqueOrThrow({ where: { id: chatId } })).workspaceGrantId, null, "the folder is kept on the task alone");
    const summary = await (await conversationRoute.GET(req(`/api/conversations/${chatId}`), context(chatId))).json();
    assert.deepEqual([summary.data.task?.id, summary.data.workspaceGrantId, summary.data.assistantConfig], [task.id, grant.id, null]);
    // The conversation's own controls do not change what belongs to the task.
    await assert.rejects(updateConversation(chatId, { assistantTemplateId: "builtin_writing" }), /general assistant/);
    await assert.rejects(updateConversation(chatId, { workspaceGrantId: null }), /task's folder/);
    // Changed on the task, the folder follows; cleared, there is none.
    await updateTask(task.id, { workspaceGrantId: null });
    assert.equal(await conversationWorkspace(chatId), null);
    // Once the task is gone the conversation is an ordinary one again.
    await deleteTask(task.id);
    const ordinary = await updateConversation(chatId, { workspaceGrantId: grant.id });
    assert.deepEqual([ordinary.task, ordinary.workspaceGrantId], [null, grant.id]);
  } finally { await db.chat.updateMany({ data: { workspaceGrantId: null } }); await db.directoryGrant.delete({ where: { id: grant.id } }); }
});

test("saving a task with its schedule unchanged leaves what it owes alone", async () => {
  const task = await createTask(daily());
  await makeDue(task.id);
  const due = (await db.scheduledJob.findUniqueOrThrow({ where: { id: task.id } })).nextRunAt.toISOString();
  // The form sends the whole task back, schedule included, when only the name changed.
  const renamed = await updateTask(task.id, { title: "Renamed", cron: "0 9 * * *", timeZone: "UTC" });
  assert.equal(renamed?.nextRunAt, due, "an overdue run is still owed");
  const zoned = await updateTask(task.id, { timeZone: "Asia/Shanghai" });
  assert.notEqual(zoned?.nextRunAt, due, "a new time zone moves a repeating task");
  const runAt = new Date(Date.now() + 2 * HOUR).toISOString();
  const once = await updateTask(task.id, { runAt });
  const again = await updateTask(task.id, { title: "Once", runAt });
  assert.equal(again?.nextRunAt, once?.nextRunAt);
});

// --- what else a task decides for its runs ------------------------------------

test("a task with neither a repeat nor a time runs only when started by hand", async () => {
  const task = await createTask(prompt({ cron: null }));
  assert.equal(task.nextRunAt, null);
  assert.equal(await claimDueTask(new Date(Date.now() + 365 * 24 * HOUR)), null, "never due, however far ahead");
  const run = await (await startTaskNow(task.id)).finished;
  assert.equal(run.status, "succeeded");
  const after = (await listTasks())[0];
  assert.deepEqual([after.nextRunAt, after.cron], [null, null], "running it by hand owes nothing afterwards");
  // A repeating task can become one run by hand, and back.
  const repeating = await createTask(prompt({ title: "Repeating" }));
  assert.equal((await updateTask(repeating.id, { cron: null, runAt: null }))?.nextRunAt, null);
  assert.ok((await updateTask(repeating.id, { cron: "0 9 * * *" }))?.nextRunAt);
  // A built-in action may run only by hand too.
  assert.equal((await createTask(daily({ cron: null }))).nextRunAt, null);
});

test("a task's memory switch is what its conversation uses, and turning it on reads nothing said while it was off", async () => {
  const { parseChatRequest } = await import("@/lib/chat/request");
  const task = await createTask(prompt());
  assert.equal(task.usesMemory, false);
  await makeDue(task.id);
  const chatId = (await runDueTask(new Date()))!.outcome.chatId!;
  const request = () => parseChatRequest({ chatId, messages: [{ id: "memory-check", role: "user", parts: [{ type: "text", text: "Hi" }] }] });
  assert.equal((await request()).conversationPolicy?.ephemeral, true);
  await db.chat.update({ where: { id: chatId }, data: { ephemeral: false } });
  assert.equal((await request()).conversationPolicy?.ephemeral, true, "the conversation's own switch does not decide it");
  const before = Date.now();
  await updateTask(task.id, { usesMemory: true });
  assert.equal((await request()).conversationPolicy?.ephemeral, false);
  assert.ok((await db.chat.findUniqueOrThrow({ where: { id: chatId } })).memoryResumedAt!.getTime() >= before - 1000);
});

test("a task's effort decides how hard its turns reason, and without one the app's setting stands", async () => {
  const { parseChatRequest } = await import("@/lib/chat/request");
  const task = await createTask(prompt());
  await makeDue(task.id);
  const chatId = (await runDueTask(new Date()))!.outcome.chatId!;
  const reasoning = async () => (await parseChatRequest({ chatId, messages: [{ id: "effort-check", role: "user", parts: [{ type: "text", text: "Hi" }] }] })).reasoning;
  assert.deepEqual(await reasoning(), { enabled: true, effort: null });
  await updateTask(task.id, { reasoningEffort: "off" });
  assert.deepEqual(await reasoning(), { enabled: false, effort: null });
  await updateTask(task.id, { reasoningEffort: "high" });
  assert.deepEqual(await reasoning(), { enabled: true, effort: "high" });
});

test("a task's notification choice decides what reaches the screen; the notice in the app is raised either way", async () => {
  const important = await createTask(prompt({ notify: "important" }));
  await makeDue(important.id);
  await runDueTask(new Date());
  assert.equal(await db.appNotice.count({ where: { fingerprint: `task:${important.id}` } }), 1);
  assert.deepEqual(await claimNoticesToAnnounce(), [], "a run that simply finished is not important");
  providerState.streamError = true;
  await makeDue(important.id);
  await runDueTask(new Date());
  assert.equal((await claimNoticesToAnnounce()).length, 1, "a failure is");
  providerState.streamError = false;
  const quiet = await createTask(prompt({ title: "Quiet", notify: "off" }));
  providerState.streamError = true;
  await makeDue(quiet.id);
  await runDueTask(new Date());
  providerState.streamError = false;
  assert.equal(await db.appNotice.count({ where: { fingerprint: `task:${quiet.id}`, readAt: null } }), 1);
  assert.deepEqual(await claimNoticesToAnnounce(), []);
});

test("a built-in action takes none of the settings that belong to a conversation", async () => {
  for (const setting of [{ approvalRule: "full" }, { usesMemory: true }, { notify: "off" }, { reasoningEffort: "high" }]) {
    await assert.rejects(createTask(daily(setting)), /no conversation/);
  }
  const reminder = await createTask(daily());
  await assert.rejects(updateTask(reminder.id, { approvalRule: "acceptEdits" }), /no conversation/);
  assert.equal((await updateTask(reminder.id, { approvalRule: "ask" }))?.approvalRule, "ask", "the default is no setting at all");
});
