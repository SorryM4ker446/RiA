import { db } from "@/db";
import { createAccountBackup } from "@/lib/backups/archive";
import { listBackupFiles } from "@/lib/backups/files";
import {
  claimDueJobs,
  completeJob,
  releaseInterruptedJobs,
  SCHEDULE_LIMITS,
  type ScheduledJobKindValue
} from "@/lib/scheduler/jobs";
import { raiseNotice } from "@/lib/scheduler/notices";
import { retainDataOperation } from "@/lib/server/data-operations";
import { ApiError } from "@/lib/server/api-error";

/*
 * The one place scheduled work is executed.
 *
 * One job at a time, and only work the user switched on.
 *
 * Two of the four kinds cost nothing. The brief and the weekly summary do call a
 * model, and the cost is bounded twice over: they are off until the user turns
 * them on, and they make exactly one call per run no matter what the model asks
 * for. A schedule that can decide to spend more is not a schedule the user can
 * reason about the cost of.
 */

export type JobOutcome = { ok: true; detail: string } | { ok: false; error: string };

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

/** How long a scheduled backup waits for a restore in flight before giving up. */
const BACKUP_GATE_WAIT_MS = 30_000;
const BACKUP_GATE_STEP_MS = 250;

/**
 * Take the workspace for the length of a read.
 *
 * A backup needs the workspace not to be *replaced* under it, not the workspace
 * to be idle. `retainDataOperation` is that gate: it refuses while a restore
 * holds the exclusive lock, and it keeps a restore from starting part-way
 * through, which is the whole of what a backup depends on.
 *
 * Asking for the exclusive lock instead meant a backup needed nothing else to
 * be happening at all, and `protectDataOperation` holds that read for the whole
 * of a streaming chat turn. So a daily backup was lost whenever the user
 * happened to be mid-conversation at the scheduled minute, and because a
 * failed run is marked done until its next turn, the backup was then a day away
 * with a "backup-failed" notice the user could do nothing about.
 *
 * A restore in flight is the one case left, and it is both rare and short, so
 * it is waited out rather than dropped. Past the window the run is given up and
 * the failure is reported as what it is.
 */
async function withBackupWorkspace<T>(operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + BACKUP_GATE_WAIT_MS;
  for (;;) {
    let release: (() => void) | null = null;
    try {
      release = retainDataOperation();
    } catch (error) {
      const restoring = error instanceof ApiError && error.code === "SERVICE_UNAVAILABLE";
      if (!restoring || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, BACKUP_GATE_STEP_MS));
      continue;
    }
    try { return await operation(); } finally { release(); }
  }
}

async function runScheduledBackup(): Promise<JobOutcome> {
  try {
    // The local service has one database and one media store, and a backup reads
    // both for as long as it takes. It holds the read gate rather than the
    // exclusive one so a conversation in progress cannot cost the user a
    // scheduled backup, and a restore can still neither overlap it nor begin
    // while it runs.
    const created = await withBackupWorkspace(() => createAccountBackup());
    // A successful backup clears the reminder rather than replacing it. Raising
    // a confirmation on the reminder's own fingerprint would only produce a
    // notice this next line immediately marks read, and would let the following
    // reminder run overwrite the reminder's own wording with a backup id.
    await db.appNotice.updateMany({ where: { fingerprint: "backup-reminder" }, data: { readAt: new Date() } });
    return { ok: true, detail: `Created backup ${created.id}.` };
  } catch (error) {
    // A failure is recorded and the schedule continues. A job that stops itself
    // on the first error would go quiet exactly when the user most needs to know
    // backups are failing.
    await raiseNotice({
      kind: "backupReminder",
      title: "backup-failed",
      detail: error instanceof Error ? error.message : "unknown",
      href: "/backups",
      fingerprint: "backup-reminder"
    });
    return { ok: false, error: error instanceof Error ? error.message : "unknown" };
  }
}

/**
 * The one model call this version of a schedule is allowed to make.
 *
 * It summarises the workspace into a conversation the user can read and reply
 * to, rather than posting a system notification carrying model output. The
 * prompt is fixed and the call is never retried, so a run costs exactly one
 * request whatever the provider decides to do with it.
 *
 * The daily and weekly forms are the same function with a different window and
 * a different fingerprint, so there is one place where the cost rule lives.
 */
async function runBrief(options: { now: Date; span: string; fingerprint: string; kind: string }): Promise<JobOutcome> {
  const { now, span, fingerprint, kind } = options;
  const { preferredModel } = await import("@/lib/models/preferences");
  const { generateText } = await import("ai");
  const { getChatModel } = await import("@/lib/ai/client");

  // `preferredModel` refuses a missing or unlisted model by throwing, so the
  // absence is named here. Without this it was recorded as whatever sentence the
  // provider settings happened to carry, and the one string worth grepping for
  // was never written. Anything else it throws is a real failure and is left
  // alone.
  let modelRef: Awaited<ReturnType<typeof preferredModel>>;
  try {
    modelRef = await preferredModel("chat");
  } catch (error) {
    if (error instanceof ApiError && error.code === "CONFIGURATION_ERROR") return { ok: false, error: "no-chat-model" };
    throw error;
  }

  const open = await db.task.count({ where: { status: { not: "done" } } });
  const done = await db.task.count({ where: { status: "done" } });
  const documents = await db.knowledgeDocument.count();
  const memories = await db.memory.count();

  const text = await generateText({
    model: getChatModel(modelRef),
    maxRetries: 0,
    system: "You write a short note for one person. No preamble, no headings beyond one line. Two or three sentences at most. Match the language of the numbers you are given.",
    prompt: `Over ${span}: ${open} task(s) open, ${done} done, ${documents} knowledge document(s), ${memories} remembered fact(s). Write the note.`
  });

  const conversation = await db.chat.create({ data: { title: kind === "weeklySummary" ? "Weekly summary" : "Daily brief" } });
  await db.message.create({
    data: {
      chatId: conversation.id,
      role: "user",
      content: `${kind === "weeklySummary" ? "Weekly summary" : "Daily brief"} for ${now.toISOString().slice(0, 10)}`,
      status: "success"
    }
  });
  await db.message.create({
    data: {
      chatId: conversation.id,
      role: "assistant",
      content: text.text,
      status: "success",
    }
  });

  await raiseNotice({
    kind,
    title: kind === "weeklySummary" ? "weekly-summary-ready" : "daily-brief-ready",
    detail: now.toISOString().slice(0, 10),
    href: `/chat?conversationId=${conversation.id}`,
    fingerprint: `${kind}:${fingerprint}`
  });
  return { ok: true, detail: `Wrote a ${kind} for ${now.toISOString().slice(0, 10)}.` };
}

async function runDailyBrief(now: Date): Promise<JobOutcome> {
  return runBrief({ now, span: "today", fingerprint: now.toISOString().slice(0, 10), kind: "dailyBrief" });
}

async function runWeeklySummary(now: Date): Promise<JobOutcome> {
  return runBrief({ now, span: "the past week", fingerprint: now.toISOString().slice(0, 10), kind: "weeklySummary" });
}

const RUNNERS: Record<string, (context: { now: Date }) => Promise<JobOutcome>> = {
  backupReminder: (context) => runBackupReminder(context.now),
  scheduledBackup: runScheduledBackup,
  dailyBrief: (context) => runDailyBrief(context.now),
  weeklySummary: (context) => runWeeklySummary(context.now)
};

/**
 * Run at most one due job.
 *
 * `take: 1` in the claim is what enforces "one at a time": a poll that finds
 * three due jobs runs the first and leaves the others for the next tick, so
 * creating a backup never competes with a brief.
 */
export async function runDueScheduledJob(now = new Date()): Promise<{ id: string; kind: string; outcome: JobOutcome } | null> {
  const [claimed] = await claimDueJobs(now);
  if (!claimed) return null;
  const runner = RUNNERS[claimed.kind];
  if (!runner) {
    // A kind this version does not know is skipped, not guessed at. It is
    // marked done so it is not retried on every poll forever.
    const outcome: JobOutcome = { ok: false, error: `unsupported-kind:${claimed.kind}` };
    await completeJob(claimed.id, outcome, now);
    return { ...claimed, outcome };
  }
  let outcome: JobOutcome;
  try {
    outcome = await runner({ now });
  } catch (error) {
    outcome = { ok: false, error: error instanceof Error ? error.message : "unknown" };
  }
  await completeJob(claimed.id, outcome, now);
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
      void releaseInterruptedJobs(readNow())
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

export type Scheduler = ReturnType<typeof startScheduler>;
export { ScheduledJobKindValue };
