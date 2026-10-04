import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { createScheduledJob, listScheduledJobs } = await import("@/lib/scheduler/jobs");
const { runDueScheduledJob } = await import("@/lib/scheduler/runner");
const { raiseNotice, listNotices, unreadNoticeCount, NOTICE_LIMITS } = await import("@/lib/scheduler/notices");
const { RATE_LIMIT_POLICIES } = await import("@/lib/server/rate-limit");
const schedulesRoute = await import("@/app/api/schedules/route");
const scheduleIdRoute = await import("@/app/api/schedules/[id]/route");
const noticesRoute = await import("@/app/api/notices/route");
const noticeIdRoute = await import("@/app/api/notices/[id]/route");

const HOUR = 60 * 60 * 1000;

let cookie: string;
const req = (path: string, method = "GET", body?: unknown) =>
  new NextRequest(`http://localhost${path}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
const context = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(async () => {
  globalThis.__privateAiRateLimitStore?.clear();
  cookie = localAccessCookie();
  await db.scheduledRun.deleteMany({});
  await db.scheduledJob.deleteMany({});
  await db.appNotice.deleteMany({});
});

after(async () => {
  await db.$disconnect();
  cleanup();
});

const dueNow = async (input: { kind: string; interval?: "daily" | "weekly" }) => {
  const job = await createScheduledJob({
    kind: input.kind as "backupReminder",
    enabled: true,
    localTime: "09:00",
    timeZone: "UTC",
    interval: input.interval ?? "daily"
  });
  await db.scheduledJob.update({ where: { id: job.id }, data: { nextRunAt: new Date(Date.now() - HOUR) } });
  return job;
};

// --- the notice centre stays bounded -----------------------------------------

test("raising more notices than the list can show keeps the newest, and the unread badge still matches the list", async () => {
  // A brief writes one notice per day and nothing ever removed it, so the table
  // outgrew the list: the badge reported more unread than the list returned,
  // and the oldest rows stayed forever.
  const total = NOTICE_LIMITS.kept + 20;
  for (let index = 0; index < total; index += 1) {
    await raiseNotice({ kind: "dailyBrief", title: "daily-brief-ready", detail: String(index), fingerprint: `dailyBrief:${index}` });
  }

  assert.equal(await db.appNotice.count(), NOTICE_LIMITS.kept, "the notices that no longer fit are removed, not just hidden");
  const rows = await listNotices();
  assert.equal(rows.length, NOTICE_LIMITS.kept);
  assert.equal(rows[0].detail, String(total - 1), "the newest notice survives");
  assert.ok(!rows.some((row) => row.detail === "0"), "the oldest notice is the one that goes");
  assert.equal(await unreadNoticeCount(), rows.length, "the badge counts exactly what the list shows");
});

test("a notice that repeats is refreshed in place and is not displaced by the bound", async () => {
  for (let index = 0; index < NOTICE_LIMITS.kept + 5; index += 1) {
    await raiseNotice({ kind: "dailyBrief", title: "daily-brief-ready", detail: String(index), fingerprint: `dailyBrief:${index}` });
  }
  await raiseNotice({ kind: "backupReminder", title: "backup-due", detail: "overdue", href: "/backups", fingerprint: "backup-reminder" });
  const rows = await listNotices();
  assert.equal(rows.filter((row) => row.kind === "backupReminder").length, 1, "one row, and it is still on the list");
  assert.equal(await unreadNoticeCount(), rows.length);
});

// --- a scheduled job is claimed once and is never left stuck ------------------

test("two polls racing the same due job run it once", async () => {
  await dueNow({ kind: "backupReminder" });
  const now = new Date();

  const [first, second] = await Promise.all([runDueScheduledJob(now), runDueScheduledJob(now)]);

  assert.equal([first, second].filter(Boolean).length, 1, "exactly one of two concurrent polls executed the job");
  const [job] = await listScheduledJobs();
  assert.notEqual(job.lastStatus, "running", "the claim was released when the run finished");
});

test("a run that fails leaves the job owed a next run rather than stuck as running", async () => {
  // No chat model is configured in this suite, so the brief fails before it
  // spends anything. What matters is that the failure is recorded and the slot
  // is still owed, not that it succeeded.
  const job = await dueNow({ kind: "dailyBrief" });

  const result = await runDueScheduledJob(new Date());
  assert.equal(result?.kind, "dailyBrief");
  assert.equal(result?.outcome.ok, false);

  const [row] = await listScheduledJobs();
  assert.equal(row.id, job.id);
  assert.equal(row.lastStatus, "failed");
  assert.ok(new Date(row.nextRunAt) > new Date(), "a failed run is not left claimable on every poll");

  // And it is claimable again when it falls due, rather than being stuck either way.
  await db.scheduledJob.update({ where: { id: job.id }, data: { nextRunAt: new Date(Date.now() - HOUR) } });
  const again = await runDueScheduledJob(new Date());
  assert.ok(again, "the next occurrence still runs");
});

// --- a scheduled backup only reports success for a backup that exists ---------

test("a half-written backup is never something a restore accepts", async () => {
  // The archive is written to a `.partial` file and renamed once it is complete,
  // so an interrupted run leaves a file the restore path cannot open.
  const { backupFile, listBackupFiles, removeBackupFile } = await import("@/lib/backups/files");
  const { inspectAccountBackup } = await import("@/lib/backups/archive");
  const id = randomUUID();
  const partial = await backupFile(id, "partial");
  await writeFile(partial, Buffer.from("PAIB0001 truncated"));
  try {
    assert.ok((await listBackupFiles()).some((file) => file.id === id && file.extension === "partial"), "the half-written file is on disk");
    await assert.rejects(
      () => inspectAccountBackup(id),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === "NOT_FOUND",
      "the restore path opens `.paib`, so a `.partial` file is not an archive it will accept"
    );
  } finally {
    await removeBackupFile(id, "partial");
  }
});

test("a scheduled backup that succeeded leaves a real archive and a recorded run", async () => {
  const { listBackupFiles } = await import("@/lib/backups/files");
  const before = new Set((await listBackupFiles()).filter((file) => file.extension === "paib").map((file) => file.id));
  await dueNow({ kind: "scheduledBackup" });

  const result = await runDueScheduledJob(new Date());
  const after_ = (await listBackupFiles()).filter((file) => file.extension === "paib");
  assert.equal(after_.some((file) => !before.has(file.id)), true, "a real archive exists for the run that reported success");
  assert.equal(result?.outcome.ok, true, `a successful run reports success: ${JSON.stringify(result?.outcome)}`);
  const [job] = await listScheduledJobs();
  assert.equal(job.lastStatus, "done");
  assert.ok(new Date(job.nextRunAt) > new Date());
});

// --- the schedule and notice mutation routes are metered ----------------------

test("every schedule and notice mutation is rate limited", async () => {
  const notice = await raiseNotice({ kind: "backupReminder", title: "backup-due", href: "/backups", fingerprint: "backup-reminder" });
  const schedule = await createScheduledJob({ kind: "backupReminder", enabled: false, localTime: "09:00", timeZone: "UTC", interval: "daily" });

  const body = { kind: "backupReminder", localTime: "09:00", timeZone: "UTC", interval: "daily" };
  const calls: { call: () => Promise<Response>; policy: "backups" | "reminders" }[] = [
    { call: () => schedulesRoute.POST(req("/api/schedules", "POST", body)), policy: "backups" },
    { call: () => scheduleIdRoute.PATCH(req(`/api/schedules/${schedule.id}`, "PATCH", { enabled: true }), context(schedule.id)), policy: "backups" },
    { call: () => scheduleIdRoute.DELETE(req(`/api/schedules/${schedule.id}`, "DELETE"), context(schedule.id)), policy: "backups" },
    { call: () => noticesRoute.POST(req("/api/notices", "POST")), policy: "reminders" },
    { call: () => noticeIdRoute.PATCH(req(`/api/notices/${notice.id}`, "PATCH"), context(notice.id)), policy: "reminders" },
    { call: () => noticeIdRoute.DELETE(req(`/api/notices/${notice.id}`, "DELETE"), context(notice.id)), policy: "reminders" }
  ];

  for (const { call, policy } of calls) {
    // Each route is exercised on its own quota, so the answer below is about
    // that route and not about what the route before it spent.
    globalThis.__privateAiRateLimitStore?.clear();
    const budget = RATE_LIMIT_POLICIES[policy].limit;
    const responses = [];
    for (let attempt = 0; attempt <= budget; attempt += 1) responses.push(await call());
    assert.ok(
      responses.slice(0, budget).every((response) => response.status !== 429),
      "a metered route answers normally inside its quota"
    );
    assert.equal(responses[budget].status, 429, `and refuses the ${policy} request past it`);
  }
});
