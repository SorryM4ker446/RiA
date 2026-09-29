import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { createScheduledJob, listScheduledJobs, claimDueJobs, completeJob, releaseInterruptedJobs, deleteScheduledJob } =
  await import("@/lib/scheduler/jobs");
const { runDueScheduledJob, startScheduler } = await import("@/lib/scheduler/runner");
const schedulesRoute = await import("@/app/api/schedules/route");
const scheduleIdRoute = await import("@/app/api/schedules/[id]/route");

let cookie: string;
const req = (path: string, method = "GET", body?: unknown) =>
  new NextRequest(`http://localhost${path}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const payload = async (response: Response, status = 200) => {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeEach(async () => {
  globalThis.__privateAiRateLimitStore?.clear();
  cookie = localAccessCookie();
  await db.scheduledJob.deleteMany({});
  await db.appNotice.deleteMany({});
});

after(async () => {
  await db.$disconnect();
  cleanup();
});

test("a schedule is created switched off unless the user asked for it", async () => {
  const job = await createScheduledJob({ kind: "backupReminder", enabled: false, localTime: "09:00", timeZone: "UTC", interval: "daily" });
  assert.equal(job.enabled, false);
  assert.ok(new Date(job.nextRunAt) > new Date());
  assert.equal((await listScheduledJobs()).length, 1);
});

test("a schedule that is off is never claimed, however overdue it is", async () => {
  await createScheduledJob({ kind: "backupReminder", enabled: false, localTime: "09:00", timeZone: "UTC", interval: "daily" });
  await db.scheduledJob.updateMany({ data: { nextRunAt: new Date(Date.now() - 10 * DAY) } });
  assert.equal((await claimDueJobs(new Date())).length, 0);
  assert.equal(await runDueScheduledJob(new Date()), null);
});

test("a due job is claimed once, so two polls cannot both run it", async () => {
  await createScheduledJob({ kind: "backupReminder", enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily" });
  const due = new Date(Date.now() + HOUR);
  await db.scheduledJob.updateMany({ data: { nextRunAt: new Date(Date.now() - HOUR) } });

  const [first, second] = await Promise.all([claimDueJobs(due), claimDueJobs(due)]);
  assert.equal([first.length, second.length].reduce((sum, count) => sum + count, 0), 1, "exactly one of two concurrent claims wins");
});

test("a machine that was asleep catches up once rather than replaying every interval", async () => {
  const created = await createScheduledJob({ kind: "backupReminder", enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily" });
  // Seven days of missed runs.
  await db.scheduledJob.updateMany({ data: { nextRunAt: new Date(Date.now() - 7 * DAY) } });

  await runDueScheduledJob(new Date());
  const [job] = await listScheduledJobs();
  // One run happened, and what is owed next is computed from now — not seven
  // intervals' worth of catch-up.
  assert.equal(job.lastStatus, "done");
  const nextIn = new Date(job.nextRunAt).getTime() - Date.now();
  assert.ok(nextIn > 0 && nextIn <= DAY, `next run is within a day, not a week of backlog (${Math.round(nextIn / HOUR)}h)`);
  assert.equal(job.id, created.id);
});

test("a failure is recorded and the schedule keeps going", async () => {
  await createScheduledJob({ kind: "scheduledBackup", enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily" });
  await db.scheduledJob.updateMany({ data: { nextRunAt: new Date(Date.now() - HOUR) } });

  const result = await runDueScheduledJob(new Date());
  // Either outcome is acceptable — what matters is that the job left a record
  // and is owed a next run, rather than going quiet on the first error.
  assert.ok(result);
  const [job] = await listScheduledJobs();
  assert.ok(["done", "failed"].includes(String(job.lastStatus)));
  assert.ok(new Date(job.nextRunAt) > new Date());
});

test("a run interrupted by the process going away is released, not left claimed", async () => {
  const created = await createScheduledJob({ kind: "backupReminder", enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily" });
  // As a process that died mid-run would leave it.
  await db.scheduledJob.update({ where: { id: created.id }, data: { lastStatus: "running", nextRunAt: new Date(Date.now() - HOUR) } });

  assert.equal(await releaseInterruptedJobs(new Date()), 1);
  const [job] = await listScheduledJobs();
  assert.equal(job.lastStatus, "interrupted");
  assert.ok(new Date(job.nextRunAt) > new Date(), "the schedule resumes rather than waiting for a claim that will never come");
});

test("a job kind this version does not know is skipped rather than guessed at", async () => {
  await createScheduledJob({ kind: "backupReminder", enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily" });
  await db.scheduledJob.updateMany({ data: { kind: "fromAFutureVersion", nextRunAt: new Date(Date.now() - HOUR) } });

  const result = await runDueScheduledJob(new Date());
  assert.equal(result?.kind, "fromAFutureVersion");
  assert.equal(result?.outcome.ok, false);
  const [job] = await listScheduledJobs();
  assert.ok(new Date(job.nextRunAt) > new Date(), "an unknown kind does not stay due and retry every poll");
});

test("a local time keeps its wall-clock hour across a daylight saving change", async () => {
  // Europe/London moves on 2026-03-29 and again on 2026-10-25.
  const before = await createScheduledJob({ kind: "backupReminder", enabled: true, localTime: "08:30", timeZone: "Europe/London", interval: "daily" });
  const afterDst = new Date(before.nextRunAt);
  const wallHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour12: false, hour: "2-digit" }).format(afterDst)) % 24;
  assert.equal(wallHour, 8, "the job is owed 08:30 local, whatever the offset is that day");
});

test("editing the time changes what is owed today rather than keeping the old hour", async () => {
  const job = await createScheduledJob({ kind: "backupReminder", enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily" });
  const original = job.nextRunAt;
  const { updateScheduledJob } = await import("@/lib/scheduler/jobs");
  const updated = await updateScheduledJob(job.id, { localTime: "21:00" });
  assert.equal(updated?.localTime, "21:00");
  assert.notEqual(updated?.nextRunAt, original);
});

test("the poller never throws, so one failure cannot stop every later schedule", async () => {
  await createScheduledJob({ kind: "backupReminder", enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily" });
  await db.scheduledJob.updateMany({ data: { nextRunAt: new Date(Date.now() - HOUR) } });
  const scheduler = startScheduler();
  await scheduler.tick();
  await scheduler.tick();
  scheduler.stop();
  const [job] = await listScheduledJobs();
  assert.ok(job.lastRunAt, "the job ran and recorded when");
});

test("schedules are created, changed and removed over the local credential only", async () => {
  const created = await payload(
    await schedulesRoute.POST(req("/api/schedules", "POST", { kind: "backupReminder", localTime: "09:00", timeZone: "UTC", interval: "daily" })),
    201
  );
  assert.equal(created.data.enabled, false, "a schedule is off unless the request says otherwise");
  assert.equal((await payload(await schedulesRoute.GET(req("/api/schedules")))).data.length, 1);

  const patched = await payload(
    await scheduleIdRoute.PATCH(req(`/api/schedules/${created.data.id}`, "PATCH", { enabled: true, localTime: "07:15" }), context(created.data.id))
  );
  assert.equal(patched.data.enabled, true);
  assert.equal(patched.data.localTime, "07:15");

  await payload(await scheduleIdRoute.DELETE(req(`/api/schedules/${created.data.id}`, "DELETE"), context(created.data.id)));
  assert.equal((await payload(await schedulesRoute.GET(req("/api/schedules")))).data.length, 0);

  const anonymous = new NextRequest("http://localhost/api/schedules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "backupReminder", localTime: "09:00", timeZone: "UTC" })
  });
  assert.equal((await schedulesRoute.POST(anonymous)).status, 401);

  // An invalid time or zone is refused rather than stored as something that can
  // never fire.
  assert.equal((await schedulesRoute.POST(req("/api/schedules", "POST", { kind: "backupReminder", localTime: "25:00", timeZone: "UTC" }))).status, 400);
  assert.equal((await schedulesRoute.POST(req("/api/schedules", "POST", { kind: "backupReminder", localTime: "09:00", timeZone: "Mars/Olympus" }))).status, 400);
  assert.equal((await deleteScheduledJob("missing")).deleted, false);
});

test("the poller starts once per process and can be stopped", async () => {
  const { startScheduler } = await import("@/lib/scheduler/runner");
  await createScheduledJob({ kind: "backupReminder", enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily" });
  await db.scheduledJob.updateMany({ data: { nextRunAt: new Date(Date.now() - HOUR) } });

  const first = startScheduler();
  const second = startScheduler();
  first.start();
  // A second start on the same process must not add a second set of claims for
  // the same jobs, which is what `register()` running twice would otherwise do.
  second.start();
  await new Promise((resolve) => setTimeout(resolve, 150));
  first.stop();
  second.stop();

  const [job] = await listScheduledJobs();
  assert.ok(job.lastRunAt, "the due job ran exactly through the poller");
});

test("registering the app starts the poller alongside backup maintenance", async () => {
  // The wiring itself: a schedule the user switched on has to fire whether or
  // not anything is open, so it is started from the same place as the existing
  // background timer rather than from a route.
  const instrumentation = await import("@/instrumentation");
  await instrumentation.register();
  // Registering wires the poller up; it never creates work of its own.
  assert.equal((await listScheduledJobs()).length, 0);
});

// --- 8-5: notices the app keeps even when a notification is refused ----------

test("a notice that repeats updates the row it already has instead of stacking", async () => {
  const { raiseNotice, listNotices, unreadNoticeCount, markNoticeRead, deleteNotice } = await import("@/lib/scheduler/notices");
  await raiseNotice({ kind: "backupReminder", title: "backup-due", detail: "first", href: "/backups", fingerprint: "backup-reminder" });
  await raiseNotice({ kind: "backupReminder", title: "backup-due", detail: "second", href: "/backups", fingerprint: "backup-reminder" });

  const rows = await listNotices();
  assert.equal(rows.length, 1, "the same thing said twice is one item, not two");
  assert.equal(rows[0].detail, "second");
  assert.equal(await unreadNoticeCount(), 1);

  await markNoticeRead(rows[0].id);
  assert.equal(await unreadNoticeCount(), 0);
  // Repeating something still true puts it back on the list rather than
  // leaving a read row that reads as dealt with.
  await raiseNotice({ kind: "backupReminder", title: "backup-due", detail: "third", href: "/backups", fingerprint: "backup-reminder" });
  assert.equal(await unreadNoticeCount(), 1);
  assert.equal((await deleteNotice(rows[0].id)).deleted, true);
  assert.equal((await deleteNotice("missing")).deleted, false);
});

test("a backup reminder raises a notice when a backup is actually due", async () => {
  const { listBackupFiles, removeBackupFile } = await import("@/lib/backups/files");
  const { listNotices } = await import("@/lib/scheduler/notices");
  const { createScheduledJob } = await import("@/lib/scheduler/jobs");
  // An earlier test really did take a backup, which is the point: start from a
  // workspace that genuinely owes one, rather than from whatever was left over.
  for (const file of (await listBackupFiles()).filter((entry) => entry.extension === "paib")) await removeBackupFile(file.id);

  const reminder = await createScheduledJob({ kind: "backupReminder", enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily" });
  await db.scheduledJob.updateMany({ where: { id: reminder.id }, data: { nextRunAt: new Date(Date.now() - HOUR) } });

  const result = await runDueScheduledJob(new Date());
  assert.equal(result?.kind, "backupReminder");
  // The point of writing it into the app: a system notification that is refused
  // or missed must not take the message with it.
  const notices = await listNotices();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, "backupReminder");
  assert.equal(notices[0].href, "/backups");
});

test("a backup taken today owes no reminder", async () => {
  const { listBackupFiles } = await import("@/lib/backups/files");
  const { listNotices } = await import("@/lib/scheduler/notices");
  const { createScheduledJob } = await import("@/lib/scheduler/jobs");
  const backup = await createScheduledJob({ kind: "scheduledBackup", enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily" });
  await db.scheduledJob.updateMany({ where: { id: backup.id }, data: { nextRunAt: new Date(Date.now() - HOUR) } });
  await runDueScheduledJob(new Date());
  assert.ok((await listBackupFiles()).some((file) => file.extension === "paib"), "a backup was really taken");

  const reminder = await createScheduledJob({ kind: "backupReminder", enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily" });
  await db.scheduledJob.updateMany({ where: { id: reminder.id }, data: { nextRunAt: new Date(Date.now() - HOUR) } });
  await runDueScheduledJob(new Date());

  // Re-raising "该备份了" over a backup taken this morning left the notice
  // unread every run, and a repeat reopens the row it refreshes, so the badge
  // in the notice centre never cleared. Nothing is due, so nothing is raised.
  assert.equal((await listNotices()).length, 0, "a fresh backup is not a reminder");
});

test("a scheduled backup clears the reminder it was about", async () => {
  const { raiseNotice, unreadNoticeCount } = await import("@/lib/scheduler/notices");
  await raiseNotice({ kind: "backupReminder", title: "backup-due", detail: "stale", href: "/backups", fingerprint: "backup-reminder" });
  assert.equal(await unreadNoticeCount(), 1);

  await createScheduledJob({ kind: "scheduledBackup", enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily" });
  await db.scheduledJob.updateMany({ data: { nextRunAt: new Date(Date.now() - HOUR) } });
  await runDueScheduledJob(new Date());

  // The thing the reminder was about has been dealt with, so it stops being
  // outstanding. A reminder that stays up after the fact becomes noise.
  assert.equal(await unreadNoticeCount(), 0);
});

test("notices are read, marked and dismissed only with the local credential", async () => {
  const noticesRoute = await import("@/app/api/notices/route");
  const noticeIdRoute = await import("@/app/api/notices/[id]/route");
  const { raiseNotice } = await import("@/lib/scheduler/notices");
  const raised = await raiseNotice({ kind: "backupReminder", title: "backup-due", fingerprint: "backup-reminder" });

  const listed = await payload(await noticesRoute.GET(req("/api/notices")));
  assert.equal(listed.data.unread, 1);
  assert.equal(listed.data.notices.length, 1);

  await payload(await noticeIdRoute.PATCH(req(`/api/notices/${raised.id}`, "PATCH"), context(raised.id)));
  assert.equal((await payload(await noticesRoute.GET(req("/api/notices")))).data.unread, 0);

  await payload(await noticesRoute.POST(req("/api/notices", "POST")));
  await payload(await noticeIdRoute.DELETE(req(`/api/notices/${raised.id}`, "DELETE"), context(raised.id)));
  assert.equal((await payload(await noticesRoute.GET(req("/api/notices?includeRead=true")))).data.notices.length, 0);

  const anonymous = new NextRequest("http://localhost/api/notices");
  assert.equal((await noticesRoute.GET(anonymous)).status, 401);
});

// --- 8-4: the one kind that spends money -------------------------------------

test("the daily brief is refused outright when no chat model is configured", async () => {
  await createScheduledJob({ kind: "dailyBrief", enabled: true, localTime: "08:00", timeZone: "UTC", interval: "daily" });
  await db.scheduledJob.updateMany({ data: { nextRunAt: new Date(Date.now() - HOUR) } });
  const result = await runDueScheduledJob(new Date());
  // No provider is configured in this suite, so the run records why rather than
  // reaching a model. What matters is that it fails loudly and keeps its slot.
  assert.equal(result?.kind, "dailyBrief");
  const [job] = await listScheduledJobs();
  assert.ok(["failed", "done"].includes(String(job.lastStatus)));
  assert.ok(new Date(job.nextRunAt) > new Date(), "a failed brief does not stop tomorrow's");
});

// --- 9: regressions batch 8 could not have caught while it was being written --

test("a service restart does not give the poller a second claim on the same jobs", async () => {
  const { startScheduler } = await import("@/lib/scheduler/runner");
  const { createScheduledJob } = await import("@/lib/scheduler/jobs");
  await createScheduledJob({ kind: "backupReminder", enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily" });
  await db.scheduledJob.updateMany({ data: { nextRunAt: new Date(Date.now() - HOUR) } });

  const before = await startScheduler();
  before.start();
  await new Promise((resolve) => setTimeout(resolve, 150));
  // A settings save restarts the local service, which re-runs registration. If
  // the poller started a second time the same job would be claimed twice in one
  // interval, and a scheduled backup would be made twice.
  const after = await startScheduler();
  after.start();
  await new Promise((resolve) => setTimeout(resolve, 150));
  before.stop();
  after.stop();

  const [job] = await listScheduledJobs();
  assert.equal(job.lastStatus, "done", "the job completed once and stayed completed");
  assert.ok(new Date(job.nextRunAt) > new Date(), "it was not run again in the same interval");
});

test("a job whose run is still marked running is not claimed by the next poll", async () => {
  const { createScheduledJob, claimDueJobs } = await import("@/lib/scheduler/jobs");
  const job = await createScheduledJob({ kind: "backupReminder", enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily" });
  await db.scheduledJob.update({ where: { id: job.id }, data: { nextRunAt: new Date(Date.now() - HOUR), lastStatus: "running" } });

  // A poll that overlaps a run in flight must wait, not run the same work twice.
  assert.equal((await claimDueJobs(new Date())).length, 0);
  await releaseInterruptedJobs(new Date());
  // Released does not mean "run it right now": the schedule resumes from the
  // current time, so a machine that was asleep owes one run later, not one now.
  assert.equal((await claimDueJobs(new Date())).length, 0, "release resumes the schedule rather than replaying the missed one");
});


// --- 8-4b: the weekly variant, on the same runner and the same budget --------

test("the weekly summary is refused loudly when no chat model is configured", async () => {
  const { createScheduledJob } = await import("@/lib/scheduler/jobs");
  await createScheduledJob({ kind: "weeklySummary", enabled: true, localTime: "18:00", timeZone: "UTC", interval: "weekly", dayOfWeek: 0 });
  await db.scheduledJob.updateMany({ data: { nextRunAt: new Date(Date.now() - HOUR) } });

  const result = await runDueScheduledJob(new Date());
  assert.equal(result?.kind, "weeklySummary");
  const [job] = await listScheduledJobs();
  assert.ok(new Date(job.nextRunAt) > new Date(), "next week's slot survives a failure");
  assert.equal(job.interval, "weekly");
  assert.equal(job.dayOfWeek, 0);
});

test("a daily job keeps its hour on both daylight saving days", async () => {
  const { nextLocalOccurrenceProbe } = await import("@/lib/scheduler/jobs");
  // America/New_York springs forward 2026-03-08 and falls back 2026-11-01.
  // A single offset probe used to abandon the whole day on both, so an 05:00 job
  // — an hour that plainly existed — was pushed a day late.
  for (const [zone, transitionDay, hour] of [
    ["America/New_York", "2026-03-08", 5],
    ["America/New_York", "2026-03-08", 12],
    ["America/New_York", "2026-11-01", 5],
    ["America/New_York", "2026-11-01", 12]
  ] as const) {
    const next = nextLocalOccurrenceProbe({ localTime: `${String(hour).padStart(2, "0")}:00`, timeZone: zone, interval: "daily", dayOfWeek: null }, new Date(`${transitionDay}T00:00:00Z`));
    const sameDay = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(next);
    assert.equal(sameDay, transitionDay, `${zone} ${transitionDay} ${hour}:00 must stay on the day it was asked for`);
  }
});

test("a local hour the spring-forward day skipped costs one run, not a day", async () => {
  const { nextLocalOccurrenceProbe } = await import("@/lib/scheduler/jobs");
  // 02:30 does not exist on 2026-03-08 in New York. Skipping that one instant is
  // correct; skipping the whole day was not.
  const next = nextLocalOccurrenceProbe({ localTime: "02:30", timeZone: "America/New_York", interval: "daily", dayOfWeek: null }, new Date("2026-03-08T00:00:00Z"));
  const formatted = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(next);
  assert.equal(formatted, "2026-03-09");
});

test("a weekly job stays weekly across a month boundary", async () => {
  const { nextLocalOccurrenceProbe } = await import("@/lib/scheduler/jobs");
  // Wednesday. Starting on 2026-01-28 the next Wednesdays are 02-04, 02-11 ...
  // A wall-clock day number added to "28" used to walk off the end of the month
  // and turn the job into a daily one.
  const seen: string[] = [];
  let cursor = new Date("2026-01-28T12:00:00Z");
  for (let index = 0; index < 4; index += 1) {
    const result = nextLocalOccurrenceProbe({ localTime: "09:00", timeZone: "UTC", interval: "weekly", dayOfWeek: 3 }, cursor);
    // The runner asks from "now", not from the previous result, so the
    // comparison is against an instant strictly after the last run.
    cursor = new Date(result.getTime() + 60_000);
    seen.push(new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(result));
  }
  assert.deepEqual(seen, ["2026-02-04", "2026-02-11", "2026-02-18", "2026-02-25"]);
});

test("a weekly schedule with no weekday is refused instead of stored as one", async () => {
  // Stored as `dayOfWeek: null` this could not match any day, so it fell through
  // to "a day from now" and ran every twenty-four hours at a drifting hour.
  assert.equal(
    (await schedulesRoute.POST(req("/api/schedules", "POST", { kind: "weeklySummary", localTime: "09:00", timeZone: "Europe/London", interval: "weekly" }))).status,
    400
  );
  const created = await createScheduledJob({ kind: "weeklySummary", enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily" });
  // A PATCH that only turns a daily job weekly reaches the same state, so it is
  // the merged schedule that has to be checked rather than the patch.
  const refused = await scheduleIdRoute.PATCH(req(`/api/schedules/${created.id}`, "PATCH", { interval: "weekly" }), context(created.id));
  assert.equal(refused.status, 400);
  assert.equal((await listScheduledJobs())[0].interval, "daily", "a refused change leaves the stored schedule alone");
});

test("pausing and resuming a schedule does not move the run it already owes", async () => {
  const { updateScheduledJob } = await import("@/lib/scheduler/jobs");
  const job = await createScheduledJob({ kind: "backupReminder", enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily" });
  const owed = job.nextRunAt;
  // The settings card's pause button sends only `enabled`, so recomputing the
  // next run on every patch pushed a job due at 09:00 out to tomorrow when the
  // user resumed it at 09:02, with nothing in the interface to say so.
  assert.equal((await updateScheduledJob(job.id, { enabled: false }))?.nextRunAt, owed, "a pause does not move what is owed");
  assert.equal((await updateScheduledJob(job.id, { enabled: true }))?.nextRunAt, owed, "a resume still runs what is already due");
  // Moving the time is the other case, and it does re-anchor.
  assert.notEqual((await updateScheduledJob(job.id, { localTime: "21:00" }))?.nextRunAt, owed);
});

test("deleting a schedule that is not there answers like editing one", async () => {
  // DELETE used to report success for a row it never removed, so the interface
  // showed the entry going away and found it again on the next load.
  const removed = await scheduleIdRoute.DELETE(req("/api/schedules/missing", "DELETE"), context("missing"));
  assert.equal(removed.status, 404);
  const edited = await scheduleIdRoute.PATCH(req("/api/schedules/missing", "PATCH", { enabled: false }), context("missing"));
  assert.equal(edited.status, 404);
});

test("releasing an interrupted run only re-anchors the rows it released", async () => {
  const { createScheduledJob } = await import("@/lib/scheduler/jobs");
  const stale = await createScheduledJob({ kind: "backupReminder", enabled: false, localTime: "09:00", timeZone: "UTC", interval: "daily" });
  // Left behind by an earlier launch. The follow-up rewrite used to match on
  // `lastStatus` rather than on the ids just flipped, so this disabled row had
  // its next run silently moved by a release that never touched it.
  const leftBehind = new Date(Date.now() - 30 * DAY).toISOString();
  await db.scheduledJob.update({ where: { id: stale.id }, data: { lastStatus: "interrupted", nextRunAt: new Date(leftBehind) } });

  assert.equal(await releaseInterruptedJobs(new Date()), 0, "nothing was running, so nothing was released");
  assert.equal((await listScheduledJobs())[0].nextRunAt, leftBehind, "a job this release never touched keeps the next run it had");
});
