import { db } from "@/db";
import { createAccountBackup } from "@/lib/backups/archive";
import { listBackupFiles } from "@/lib/backups/files";
import {
  claimDueJobs,
  claimScheduledRetry,
  completeJob,
  releaseInterruptedJobs,
  SCHEDULE_LIMITS,
  type ScheduledJobKindValue,
  type ClaimedJob,
} from "@/lib/scheduler/jobs";
import { raiseNotice } from "@/lib/scheduler/notices";
import { runBackgroundDataOperation } from "@/lib/server/data-operations";
import { ApiError } from "@/lib/server/api-error";
import { scheduledErrorCode } from "@/lib/scheduler/history";

// Scheduled work is claimed once. Period reviews always retain local facts;
// model commentary is optional and never retried for an existing period.

export type JobOutcome = { ok: true; detail: string; chatId?: string; backupId?: string; error?: string } | { ok: false; error: string };

/** How stale a backup may get before a reminder is worth raising. */
export const BACKUP_REMINDER_AFTER_DAYS = 7;

async function runBackupReminder(now: Date): Promise<JobOutcome> {
  // The reminder is about backups this workspace created, which are files on
  // disk. A backup the user downloaded and keeps elsewhere does not age here,
  // and counting it would silence a reminder the workspace still needs.
  const backups = (await listBackupFiles()).filter((file) => file.extension === "paib");
  const newest = backups[0];
  const ageDays = newest ? (now.getTime() - Date.parse(newest.createdAt)) / (24 * 60 * 60 * 1000) : Infinity;
  const overdue = !Number.isFinite(ageDays) || ageDays > BACKUP_REMINDER_AFTER_DAYS;
  const detail = Number.isFinite(ageDays)
    ? overdue
      ? `No backup for ${Math.floor(ageDays)} days.`
      : `A backup exists from ${Math.floor(ageDays)} day(s) ago.`
    : "No backup has been created yet.";
  // Raised when a backup is actually due. Raising it on every run left an unread
  // "该备份了" standing over a backup taken the day before, and because a repeat
  // reopens the row it refreshes, the badge in the notice centre never cleared.
  if (!overdue) return { ok: true, detail };
  // Raised into the app rather than only onto the screen, so a notification the
  // system refuses still leaves the message somewhere the user can find it.
  await raiseNotice({ kind: "backupReminder", title: "backup-due", detail, href: "/backups", fingerprint: "backup-reminder" });
  return { ok: true, detail };
}

async function runScheduledBackup(): Promise<JobOutcome> {
  try {
    // The local service has one database and one media store, and a backup reads
    // both for as long as it takes. It holds the read gate rather than the
    // exclusive one so a conversation in progress cannot cost the user a
    // scheduled backup, and a restore can still neither overlap it nor begin
    // while it runs.
    const created = await createAccountBackup();
    // A successful backup clears the reminder rather than replacing it. Raising
    // a confirmation on the reminder's own fingerprint would only produce a
    // notice this next line immediately marks read, and would let the following
    // reminder run overwrite the reminder's own wording with a backup id.
    await db.appNotice.updateMany({ where: { fingerprint: "backup-reminder" }, data: { readAt: new Date() } }).catch(() => { console.error("scheduler.notice.update_failed"); });
    return { ok: true, detail: "Backup created.", backupId: created.id };
  } catch (error) {
    // A failure is recorded and the schedule continues. A job that stops itself
    // on the first error would go quiet exactly when the user most needs to know
    // backups are failing.
    await raiseNotice({
      kind: "backupReminder",
      title: "backup-failed",
      detail: scheduledErrorCode(error),
      href: "/backups",
      fingerprint: "backup-reminder"
    }).catch(() => { console.error("scheduler.notice.write_failed"); });
    return { ok: false, error: scheduledErrorCode(error) };
  }
}

async function runPeriodReview(claim: ClaimedJob, now: Date): Promise<JobOutcome> {
  const { generateWorkspaceReview } = await import("@/lib/activity/reviews");
  const { review } = await generateWorkspaceReview(claim.kind === "weeklySummary" ? "weekly" : "daily", claim.timeZone, claim.useModel, now);
  await raiseNotice({ kind: claim.kind,
    title: claim.kind === "weeklySummary" ? "weekly-summary-ready" : "daily-brief-ready",
    detail: `${review.timeZone}: ${review.startAt.toISOString()} — ${review.endAt.toISOString()}`,
    href: `/chat?conversationId=${review.chatId}`, fingerprint: `review:${review.id}`,
  }).catch(() => { console.error("scheduler.notice.write_failed"); });
  return { ok: true, detail: "Period review available.", chatId: review.chatId ?? undefined, error: review.modelError ?? undefined };
}

const RUNNERS: Record<string, (context: { now: Date; claim: ClaimedJob }) => Promise<JobOutcome>> = {
  backupReminder: (context) => runBackupReminder(context.now),
  scheduledBackup: runScheduledBackup,
  dailyBrief: (context) => runPeriodReview(context.claim, context.now),
  weeklySummary: (context) => runPeriodReview(context.claim, context.now)
};

/**
 * Run at most one due job.
 *
 * `take: 1` in the claim is what enforces "one at a time": a poll that finds
 * three due jobs runs the first and leaves the others for the next tick, so
 * creating a backup never competes with a brief.
 */
export async function runDueScheduledJob(now = new Date()): Promise<{ id: string; kind: string; outcome: JobOutcome } | null> {
  try {
    return await runBackgroundDataOperation(() => executeDueScheduledJob(now));
  } catch (error) {
    // Leave due jobs unclaimed while restore owns the workspace. The next poll
    // re-reads permissions, including schedules paused by that restore.
    if (error instanceof ApiError && error.code === "SERVICE_UNAVAILABLE") return null;
    throw error;
  }
}

async function executeDueScheduledJob(now: Date) {
  const [claimed] = await claimDueJobs(now);
  if (!claimed) return null;
  return executeClaimedJob(claimed, now);
}

export async function retryScheduledJob(jobId: string, previousRunId: string, now = new Date()) {
  return runBackgroundDataOperation(async () => executeClaimedJob(await claimScheduledRetry(jobId, previousRunId, now), now));
}

async function executeClaimedJob(claimed: ClaimedJob, now: Date) {
  const started = Date.now();
  const runner = RUNNERS[claimed.kind];
  if (!runner) {
    // A kind this version does not know is skipped, not guessed at. It is
    // marked done so it is not retried on every poll forever.
    const outcome: JobOutcome = { ok: false, error: "UNSUPPORTED_KIND" };
    await completeJob(claimed.id, outcome, now, claimed.runId);
    return { ...claimed, outcome };
  }
  let outcome: JobOutcome;
  try {
    outcome = await runner({ now, claim: claimed });
  } catch (error) {
    outcome = { ok: false, error: scheduledErrorCode(error) };
  }
  await completeJob(claimed.id, outcome, new Date(now.getTime() + Math.max(0, Date.now() - started)), claimed.runId);
  return { ...claimed, outcome };
}

/**
 * The poller the desktop shell and the test suite both drive.
 *
 * A no-op unless something is due, and it never throws: a background timer that
 * dies on the first error stops every later schedule silently.
 */
export function startScheduler(options: { now?: () => Date } = {}) {
  const readNow = options.now ?? (() => new Date());
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    async tick(): Promise<void> {
      if (running) return;
      running = true;
      try {
        await runDueScheduledJob(readNow());
      } catch {
        // Swallowed on purpose: the next tick is the retry, and an unhandled
        // rejection here would take the process with it.
      } finally {
        running = false;
      }
    },
    start(): void {
      if (timer) return;
      // Process-wide, because `register()` can run more than once in a process
      // and two schedulers would be two sets of claims for the same jobs. The
      // live timer itself is the marker, not a flag: a flag reset at module
      // scope is cleared by the next evaluation of this module — a second server
      // bundle in one process, or a dev reload — while the first timer is still
      // running, and the next start would add a second one.
      if (shared.schedulerTimer) return;
      // The release runs before the first tick, never alongside it. They were
      // both fire-and-forget, so a claim that committed in between was marked
      // interrupted and had its next run rewritten by the very launch that had
      // just claimed it. The tick itself is immediate because a schedule that
      // only fired on the next poll could be up to a minute late, which is long
      // enough for a reminder about backups to arrive after the person asked.
      void runBackgroundDataOperation(() => releaseInterruptedJobs(readNow()))
        .catch(() => 0)
        .then(() => this.tick());
      timer = setInterval(() => void this.tick(), SCHEDULE_LIMITS.pollIntervalMs);
      shared.schedulerTimer = timer;
      // The timer must not be what keeps the process alive. A service that is
      // shutting down should be able to exit with a schedule pending.
      timer.unref?.();
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      shared.schedulerTimer = undefined;
    }
  };
}

const shared = globalThis as typeof globalThis & { schedulerTimer?: ReturnType<typeof setInterval> };

export { ScheduledJobKindValue };
