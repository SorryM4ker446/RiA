import { db } from "@/db";
import { settingsHref } from "@/lib/settings/sections";
import { createAccountBackup } from "@/lib/backups/archive";
import { isArchiveExtension, listBackupFiles } from "@/lib/backups/files";
import { claimDueTask, claimTaskNow, completeTask, releaseInterruptedTasks, TASK_LIMITS, type ClaimedTask, type TaskOutcome } from "@/lib/scheduler/jobs";
import { raiseNotice } from "@/lib/scheduler/notices";
import { runBackgroundDataOperation } from "@/lib/server/data-operations";
import { ApiError } from "@/lib/server/api-error";
import { scheduledErrorCode } from "@/lib/scheduler/history";
import { createChat } from "@/lib/chat/store";
import { awaitsApproval, runUnattendedTurn } from "@/lib/chat/unattended";
import { admitBackgroundRun } from "@/lib/models/call-controls";
import { getModelPreferences } from "@/lib/models/preferences";
import { interfaceLocale, wordTask } from "@/lib/scheduler/task-wording";
import { taskNotifies } from "@/lib/scheduler/task-settings";
import { announceConversationsChanged } from "@/lib/conversations/events";

/*
 * Carrying out a task that is due.
 *
 * A prompt is one turn in the task's own conversation, with the tools and
 * permissions that conversation has. Every run continues the same conversation,
 * so what the task did last time is there for it to read, and the user finds
 * all of it in one place. The built-in actions involve no model.
 */

/** How stale a backup may get before a reminder is worth raising. */
export const BACKUP_REMINDER_AFTER_DAYS = 7;

async function runBackupReminder(now: Date): Promise<TaskOutcome> {
  // The reminder is about backups this workspace created, which are files on
  // disk. A backup the user downloaded and keeps elsewhere does not age here,
  // and counting it would silence a reminder the workspace still needs.
  const backups = (await listBackupFiles()).filter((file) => isArchiveExtension(file.extension));
  const newest = backups[0];
  const ageDays = newest ? (now.getTime() - Date.parse(newest.createdAt)) / (24 * 60 * 60 * 1000) : Infinity;
  // Raised when a backup is actually due. Raising it on every run would leave an
  // unread reminder standing over a backup taken the day before.
  if (Number.isFinite(ageDays) && ageDays <= BACKUP_REMINDER_AFTER_DAYS) return { status: "succeeded" };
  const detail = Number.isFinite(ageDays) ? `No backup for ${Math.floor(ageDays)} days.` : "No backup has been created yet.";
  // Raised into the app rather than only onto the screen, so a notification the
  // system refuses still leaves the message somewhere the user can find it.
  await raiseNotice({ kind: "backupReminder", title: "backup-due", detail, href: settingsHref("backups"), fingerprint: "backup-reminder" });
  return { status: "succeeded" };
}

async function runScheduledBackup(): Promise<TaskOutcome> {
  try {
    // A backup reads the one database and media store for as long as it takes.
    // It holds the read gate rather than the exclusive one, so a conversation in
    // progress cannot cost the user a backup, and a restore can neither overlap
    // it nor begin while it runs.
    const created = await createAccountBackup();
    // A successful backup clears the reminder rather than replacing it.
    await db.appNotice.updateMany({ where: { fingerprint: "backup-reminder" }, data: { readAt: new Date() } }).catch(() => { console.error("scheduler.notice.update_failed"); });
    return { status: "succeeded", backupId: created.id };
  } catch (error) {
    // A failure is recorded and the task continues. One that stopped itself on
    // the first error would go quiet exactly when the user most needs to know
    // backups are failing.
    await raiseNotice({ kind: "backupReminder", title: "backup-failed", detail: scheduledErrorCode(error), href: settingsHref("backups"), fingerprint: "backup-reminder" })
      .catch(() => { console.error("scheduler.notice.write_failed"); });
    return { status: "failed", error: scheduledErrorCode(error) };
  }
}

/**
 * The task's one conversation, started the first time it is needed or after the
 * user deleted it.
 *
 * Whether it uses long-term memory is the task's choice, off unless the user
 * turned it on: a task repeats the same instruction on its own, and what it
 * says is not something the user said about themselves.
 */
async function taskConversation(task: ClaimedTask): Promise<string> {
  const current = await db.scheduledJob.findUnique({ where: { id: task.id }, select: { chatId: true } });
  if (current?.chatId) return current.chatId;
  // The task's memory switch decides its turns; the conversation keeps it too, for after the task is gone.
  const chat = await createChat({ title: task.title, ephemeral: !task.usesMemory });
  // Kept only while the task still has none, so two runs cannot each leave one behind.
  const kept = await db.scheduledJob.updateMany({ where: { id: task.id, chatId: null }, data: { chatId: chat.id } });
  if (kept.count === 1) return chat.id;
  await db.chat.delete({ where: { id: chat.id } }).catch(() => null);
  const winner = await db.scheduledJob.findUnique({ where: { id: task.id }, select: { chatId: true } });
  if (!winner?.chatId) throw new ApiError({ code: "NOT_FOUND", message: "Task not found" });
  return winner.chatId;
}

const NOTICE_TITLES = { succeeded: "task-finished", failed: "task-failed", waiting_approval: "task-needs-approval", skipped: "task-skipped", missed: "task-missed" } as const;

/**
 * What a late run is told, with the request's other reference data: when it
 * was due, how late it is, and how many later times passed. A brief written
 * three hours late, or after a week away, can then say so and cover the gap
 * rather than describe the day as if it were still morning.
 */
export function lateRunNote(task: ClaimedTask, now = new Date()): string | null {
  if (!task.late || !task.scheduledFor) return null;
  const due = new Intl.DateTimeFormat("en-CA", { timeZone: task.timeZone, dateStyle: "short", timeStyle: "short", hourCycle: "h23" }).format(task.scheduledFor);
  const minutes = Math.round((now.getTime() - task.scheduledFor.getTime()) / 60_000);
  const missed = task.missedBefore ? ` ${task.missedBefore} later scheduled time(s) of this task also passed; they will not run separately, so this run stands in for them.` : "";
  return `Scheduled task run: this run was due at ${due} (${task.timeZone}) and is starting about ${minutes} minutes late, because RiA was not running or the task could not start at the time.${missed}`;
}

/**
 * One notice per task, raised again each run, so the list shows where each task
 * stands rather than a row for every run. The task's notification choice
 * decides only whether the desktop also puts it on screen.
 */
async function announce(task: ClaimedTask, status: keyof typeof NOTICE_TITLES, chatId: string | null) {
  await raiseNotice({
    kind: "taskRun", title: NOTICE_TITLES[status], detail: task.title,
    href: chatId ? `/chat?conversationId=${chatId}` : "/tasks", fingerprint: `task:${task.id}`,
    announce: taskNotifies(task.notify, NOTICE_TITLES[status]),
  }).catch(() => { console.error("scheduler.notice.write_failed"); });
}

async function runPrompt(task: ClaimedTask, signal: AbortSignal, place: BackgroundPlace | null): Promise<TaskOutcome> {
  if (!task.prompt) return { status: "failed", error: "VALIDATION_ERROR" };
  const note = lateRunNote(task);
  const existing = (await db.scheduledJob.findUnique({ where: { id: task.id }, select: { chatId: true } }))?.chatId ?? null;
  // An approval still open from the last run is the user's to answer. Sending
  // another message past it would leave that request unanswered in the middle
  // of the conversation, so this run says it is waiting and does nothing else.
  if (existing && await awaitsApproval(existing)) {
    await announce(task, "waiting_approval", existing);
    return { status: "waiting_approval", chatId: existing };
  }
  // A run that started on its own takes a place in the day's background
  // allowance before anything is sent; one the user started is theirs to pay for.
  const background = task.trigger === "scheduled";
  if (background && !(await admitBackgroundRun()).admitted) {
    await announce(task, "skipped", existing);
    return { status: "skipped", error: "BACKGROUND_LIMIT", ...(existing ? { chatId: existing } : {}) };
  }
  const chatId = existing ?? await taskConversation(task);
  const outcome = await runUnattendedTurn({ chatId, text: task.prompt, signal, callSource: background ? "scheduled" : "chat", ...(note ? { requestNote: note } : {}), ...(place ? { place } : {}) });
  await announce(task, outcome.status, chatId);
  return { status: outcome.status, chatId, ...(outcome.status === "failed" ? { error: outcome.errorCode ?? "INTERNAL_ERROR" } : {}) };
}

/**
 * Tasks that stopped for an approval the user has since answered.
 *
 * The conversation is the record of whether a request is still open: the user
 * answers it there, or gives it up, or moves on with another message. A task
 * left saying "needs approval" after that would be describing a conversation
 * that is no longer in that state, and its notice would stay unread for nothing.
 */
export async function settleAnsweredApprovals(chatId?: string): Promise<void> {
  const waiting = await db.scheduledJob.findMany({ where: { lastStatus: "waiting_approval", chatId: chatId ?? { not: null } }, select: { id: true, chatId: true } });
  for (const task of waiting) {
    if (task.chatId && await awaitsApproval(task.chatId)) continue;
    // Guarded on the state read, so a run that has just stopped for a new approval keeps it.
    const settled = await db.scheduledJob.updateMany({ where: { id: task.id, lastStatus: "waiting_approval" }, data: { lastStatus: "done", lastError: null } });
    if (settled.count) await db.appNotice.updateMany({ where: { fingerprint: `task:${task.id}`, title: "task-needs-approval", readAt: null }, data: { readAt: new Date() } });
  }
}

const shared = globalThis as typeof globalThis & {
  schedulerTimer?: ReturnType<typeof setInterval>;
  /** Looks for due tasks again, when a place for a waiting prompt has freed up. */
  schedulerWake?: () => void;
  /** Prompt runs that started on their own and hold a background place now. */
  backgroundPrompts?: number;
  /** Runs waiting to take a background place again, woken when one is given back. */
  placeWaiters?: Set<() => void>;
  /** What stops each task that is running, by task id. */
  taskRuns?: Map<string, AbortController>;
  /** The built-in actions run one after another: two backups at once would be two archives of the same thing. */
  builtInQueue?: Promise<unknown>;
};
const running = () => shared.taskRuns ??= new Map<string, AbortController>();

function queued<T>(work: () => Promise<T>): Promise<T> {
  const next = (shared.builtInQueue ?? Promise.resolve()).then(work, work);
  shared.builtInQueue = next.catch(() => undefined);
  return next;
}

/**
 * A scheduled prompt's background place. It is given back while the run waits
 * for the user's answer in its conversation, so other due tasks are not held up
 * by a run that is calling no model, and taken again, waiting if need be,
 * before the run sends anything. Giving back twice gives back one place.
 */
export type BackgroundPlace = { give(): void; take(signal: AbortSignal): Promise<void> };

function backgroundPlace(): BackgroundPlace {
  let held = true;
  shared.backgroundPrompts = (shared.backgroundPrompts ?? 0) + 1;
  const waiters = shared.placeWaiters ??= new Set();
  return {
    give() {
      if (!held) return;
      held = false;
      shared.backgroundPrompts = Math.max(0, (shared.backgroundPrompts ?? 1) - 1);
      for (const wake of [...waiters]) wake();
      // A prompt that waited for this place should not also wait for the next poll.
      shared.schedulerWake?.();
    },
    async take(signal) {
      while (!held) {
        signal.throwIfAborted();
        const places = await backgroundPromptPlaces();
        if ((shared.backgroundPrompts ?? 0) < places) {
          held = true;
          shared.backgroundPrompts = (shared.backgroundPrompts ?? 0) + 1;
          return;
        }
        await new Promise<void>(resolve => {
          const wake = () => { waiters.delete(wake); signal.removeEventListener("abort", wake); resolve(); };
          waiters.add(wake);
          signal.addEventListener("abort", wake, { once: true });
        });
      }
    },
  };
}

/** Runs a claimed task to its end and records the result. Never throws. */
async function execute(claimed: ClaimedTask, now: Date): Promise<TaskOutcome> {
  const started = Date.now();
  const controller = new AbortController();
  running().set(claimed.id, controller);
  // Counted before the first wait, so a poll that started this one sees its place taken.
  const place = claimed.kind === "prompt" && claimed.trigger === "scheduled" ? backgroundPlace() : null;
  let task = claimed;
  let outcome: TaskOutcome;
  try {
    // Worded once, in the interface language as it is now: its name for the
    // conversation and the notice, its prompt for the model.
    task = wordTask(claimed, await interfaceLocale());
    // A late run of a task set not to catch up does nothing: its time has
    // passed, and it waits for the next one. The user is told it was missed.
    if (task.late && !task.catchUp) {
      const chatId = (await db.scheduledJob.findUnique({ where: { id: task.id }, select: { chatId: true } }))?.chatId ?? null;
      await announce(task, "missed", chatId);
      outcome = { status: "missed" };
    } else outcome = task.kind === "prompt" ? await runPrompt(task, controller.signal, place)
      : task.kind === "scheduledBackup" ? await queued(runScheduledBackup)
      : task.kind === "backupReminder" ? await queued(() => runBackupReminder(now))
      // A kind this version does not know is skipped, not guessed at, and is
      // recorded so it is not picked up again on every poll.
      : { status: "failed", error: "UNSUPPORTED_KIND" };
  } catch (error) {
    outcome = { status: "failed", error: controller.signal.aborted ? "ABORTED" : scheduledErrorCode(error) };
  } finally {
    running().delete(task.id);
  }
  await completeTask(task.id, outcome, new Date(now.getTime() + Math.max(0, Date.now() - started)), task.runId)
    .catch(() => { console.error("scheduler.complete.failed"); });
  announceConversationsChanged();
  place?.give();
  return outcome;
}

type Started = { task: ClaimedTask; finished: Promise<TaskOutcome> };

/**
 * Claims a task and starts it, answering as soon as it has started.
 *
 * The run holds the workspace's read gate until it ends, so a restore can
 * neither overlap it nor begin while it is saving an answer.
 */
function start(claim: () => Promise<ClaimedTask | null>, now: Date): Promise<Started | null> {
  return new Promise((resolve, reject) => {
    runBackgroundDataOperation(async () => {
      const task = await claim();
      if (!task) { resolve(null); return; }
      announceConversationsChanged();
      const finished = execute(task, now);
      resolve({ task, finished });
      await finished;
    }).catch(reject);
  });
}

/**
 * How many prompts that started on their own may run at once.
 *
 * Half the model call places: a few tasks falling due together queue behind
 * each other instead of being refused by the concurrency limit, and the user's
 * own conversation still has room while they run.
 */
export async function backgroundPromptPlaces(): Promise<number> {
  return Math.max(1, Math.floor((await getModelPreferences()).callLimits.maxConcurrent / 2));
}

/**
 * Starts one task that is due, if any. With `prompts: false` only built-in
 * actions are taken and due prompts stay due. Null while a restore owns the
 * workspace: the next poll looks again.
 */
export async function startDueTask(now = new Date(), options: { prompts?: boolean } = {}): Promise<Started | null> {
  try {
    return await start(() => claimDueTask(now, options), now);
  } catch (error) {
    if (error instanceof ApiError && error.code === "SERVICE_UNAVAILABLE") return null;
    throw error;
  }
}

/** Runs one task that is due to its end. */
export async function runDueTask(now = new Date()): Promise<{ task: ClaimedTask; outcome: TaskOutcome } | null> {
  const started = await startDueTask(now);
  return started ? { task: started.task, outcome: await started.finished } : null;
}

/** Starts a task now because the user asked. It takes no background place: the user is there. */
export async function startTaskNow(id: string, now = new Date()): Promise<Started> {
  return (await start(() => claimTaskNow(id, now), now))!;
}

/** Stops a task that is running. Its run is recorded as stopped; what it had already done stays done. */
export function stopTask(id: string): boolean {
  const controller = running().get(id);
  controller?.abort();
  return Boolean(controller);
}

/**
 * The poller the desktop service runs.
 *
 * Each look starts every task that has come due, up to the places background
 * prompts may take, and waits for none of them: a prompt can take minutes, and
 * a backup due meanwhile should not wait behind it. Prompts beyond those places
 * stay due and start as places free up. It never throws, because a background
 * timer that dies on the first error stops every later task silently.
 */
export function startScheduler(options: { now?: () => Date } = {}) {
  const readNow = options.now ?? (() => new Date());
  let looking = false;
  // A wake that arrives mid-look is not lost: the look goes round once more.
  let again = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    async tick(): Promise<void> {
      if (looking) { again = true; return; }
      looking = true;
      try {
        do {
          again = false;
          const places = await backgroundPromptPlaces();
          while (await startDueTask(readNow(), { prompts: (shared.backgroundPrompts ?? 0) < places }));
        } while (again);
      } catch {
        // Swallowed on purpose: the next look is the retry, and an unhandled
        // rejection here would take the process with it.
      } finally {
        looking = false;
      }
    },
    start(): void {
      if (timer) return;
      // Process-wide, because `register()` can run more than once in a process
      // and two schedulers would be two sets of claims for the same tasks. The
      // live timer itself is the marker, not a flag: a flag at module scope is
      // cleared by the next evaluation of this module while the first timer is
      // still running, and the next start would add a second one.
      if (shared.schedulerTimer) return;
      // The release runs before the first look, never alongside it: a claim
      // committed in between would be marked interrupted by the very launch
      // that had just made it. The first look is immediate, because a task due
      // at launch should not wait a minute for the next poll.
      void runBackgroundDataOperation(() => releaseInterruptedTasks(readNow()))
        .catch(() => 0)
        .then(() => this.tick());
      timer = setInterval(() => void this.tick(), TASK_LIMITS.pollIntervalMs);
      shared.schedulerTimer = timer;
      shared.schedulerWake = () => void this.tick();
      // The timer must not be what keeps the process alive. A service that is
      // shutting down should be able to exit with a task pending.
      timer.unref?.();
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      shared.schedulerTimer = undefined;
      shared.schedulerWake = undefined;
    }
  };
}
