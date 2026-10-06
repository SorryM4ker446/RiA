import { z } from "zod";
import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";
import { isTaskTimeZone } from "@/lib/tasks/schedule";
import { randomUUID } from "node:crypto";
import { dataRequestContext } from "@/lib/server/data-operations";
import { pruneScheduledHistory } from "@/lib/scheduler/history";

/*
 * Work the user asked to happen without being present.
 *
 * The first version keeps the cost of a schedule bounded and visible: a
 * reminder that a backup is due and a backup to be created cost nothing at all,
 * and the daily brief and the weekly summary each make exactly one model call
 * per run, no matter what the model asks for. A schedule the user cannot
 * reason about the cost of is not one they can safely leave switched on.
 *
 * Three rules shape everything here:
 *
 * - Nothing is scheduled until it is switched on. A background process that
 *   starts on its own is one the user did not ask for.
 * - A due job is claimed, not merely seen. One local process runs these, and
 *   two of them firing together would make two backups or two reminders.
 * - A machine that was asleep catches up **once**. The next run is recomputed
 *   from the current time rather than advanced interval by interval, so a laptop
 *   open once after a week owes one run, not seven.
 */

export const SCHEDULE_LIMITS = {
  /** Jobs in the workspace. A handful of reminders, not a task queue. */
  jobs: 20,
  /** How often the poller looks. */
  pollIntervalMs: 60_000,
} as const;

export const ScheduledJobKind = ["backupReminder", "scheduledBackup", "dailyBrief", "weeklySummary"] as const;
export type ScheduledJobKindValue = (typeof ScheduledJobKind)[number];

export const localTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM");

const scheduleFields = z.strictObject({
  kind: z.enum(ScheduledJobKind),
  enabled: z.boolean().default(false),
  useModel: z.boolean().default(false),
  localTime: localTimeSchema,
  timeZone: z.string().min(1).max(100).refine(isTaskTimeZone, "Invalid IANA time zone"),
  interval: z.enum(["daily", "weekly"]).default("daily"),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional()
});

/**
 * A weekly schedule with no weekday has nothing to fire on.
 *
 * Left unconstrained it was stored as `dayOfWeek: null`, which the converter
 * could not match against any day, so the job fell through to "a day from now"
 * and ran every twenty-four hours at a drifting hour — a weekly summary
 * answering six extra times a month. The request is refused here instead, so
 * the caller finds out rather than the bill does.
 */
export const scheduleInputSchema = scheduleFields.superRefine((value, ctx) => {
  if (value.interval === "weekly" && (value.dayOfWeek === undefined || value.dayOfWeek === null)) {
    ctx.addIssue({ code: "custom", path: ["dayOfWeek"], message: "A weekly schedule needs a day of the week" });
  }
});

/** Every field optional: a PATCH may change one thing about a schedule. Whether
 * the result is coherent depends on the stored row, so `updateScheduledJob`
 * checks the merged schedule rather than the patch. */
export const schedulePatchSchema = scheduleFields.partial();

export type ScheduleInput = Omit<z.infer<typeof scheduleInputSchema>, "useModel"> & { useModel?: boolean };

export type ScheduledJobView = {
  id: string;
  kind: string;
  enabled: boolean;
  useModel: boolean;
  localTime: string;
  timeZone: string;
  interval: string;
  dayOfWeek: number | null;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
};

const jobViewSelect = {
  id: true,
  kind: true,
  enabled: true,
  useModel: true,
  localTime: true,
  timeZone: true,
  interval: true,
  dayOfWeek: true,
  nextRunAt: true,
  lastRunAt: true,
  lastStatus: true,
  lastError: true
} as const;

function toView(row: {
  id: string;
  kind: string;
  enabled: boolean;
  useModel: boolean;
  localTime: string;
  timeZone: string;
  interval: string;
  dayOfWeek: number | null;
  nextRunAt: Date;
  lastRunAt: Date | null;
  lastStatus: string | null;
  lastError: string | null;
}): ScheduledJobView {
  return {
    ...row,
    nextRunAt: row.nextRunAt.toISOString(),
    lastRunAt: row.lastRunAt?.toISOString() ?? null
  };
}

/** The wall-clock parts of an instant in a zone, which is what a schedule is written in. */
function wallClockParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short"
  }).formatToParts(instant);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as const;
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    // Intl renders midnight as 24 in some ICU versions.
    hour: Number(value("hour")) % 24,
    minute: Number(value("minute")),
    weekday: weekdays[value("weekday") as keyof typeof weekdays] ?? 0
  };
}

/**
 * The local calendar date `days` after the given one.
 *
 * Written out rather than adding to a day-of-month, because "the 31st plus
 * three days" is not a date. A monthly rollover is exactly where a wall-clock
 * day number falls apart, and it is the reason a weekly job used to degrade
 * into running every day for the rest of a month.
 */
function addCalendarDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/**
 * The first instant at or after `from` that is the given local time.
 *
 * For each candidate day, the zone's offset is *solved* for rather than probed
 * once. A single probe at a guessed instant puts the guess and the answer on
 * opposite sides of a transition, the round trip fails, and the whole day is
 * abandoned — which on a spring-forward day skipped hours that plainly existed.
 * Walking the offset in fifteen-minute steps finds the instant that really is
 * the local time the user asked for, and a local time that did not happen that
 * day is still skipped rather than nudged into an hour nobody asked for.
 */
function nextLocalOccurrence(
  schedule: { localTime: string; timeZone: string; interval: string; dayOfWeek: number | null },
  from: Date
): Date {
  const [hour, minute] = schedule.localTime.split(":").map(Number);
  const start = wallClockParts(from, schedule.timeZone);

  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const day = addCalendarDays(start.year, start.month, start.day, dayOffset);
    if (schedule.interval === "weekly") {
      const weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
      // No weekday to match is no day at all, rather than every day. The
      // boundary refuses a weekly schedule without one, so reaching this is a
      // stored row the schema could not have written.
      if (weekday !== schedule.dayOfWeek) continue;
    }

    const naive = Date.UTC(day.year, day.month - 1, day.day, hour, minute);
    let resolved: Date | null = null;
    // Offsets move in whole or half hours, so a quarter-hour sweep covers every
    // zone that exists. Two days of it on either side is more than any real
    // transition.
    for (let step = -96; step <= 96 && !resolved; step += 1) {
      const candidate = new Date(naive - step * 15 * 60 * 1000);
      const actual = wallClockParts(candidate, schedule.timeZone);
      if (actual.year !== day.year || actual.month !== day.month || actual.day !== day.day) continue;
      if (actual.hour !== hour || actual.minute !== minute) continue;
      resolved = candidate;
    }
    // No local time on this day matched: the clock jumped over it. That is the
    // honest answer, and it costs one run, not a whole day.
    if (!resolved) continue;
    if (resolved.getTime() >= from.getTime()) return resolved;
  }
  // Unreachable for a schedule the schema accepts: a daily time happens on some
  // day within the horizon, and nine days covers every weekday. It is a bound
  // rather than an answer, so a job never sits due forever waiting for a day
  // that will not be found.
  return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}

/** Exposed for the daylight saving and calendar cases, which need to call the
 * conversion directly rather than through a stored row. */
export const nextLocalOccurrenceProbe = nextLocalOccurrence;

export async function listScheduledJobs(): Promise<ScheduledJobView[]> {
  const rows = await db.scheduledJob.findMany({ orderBy: [{ kind: "asc" }, { id: "asc" }], select: jobViewSelect });
  return rows.map(toView);
}

export async function createScheduledJob(input: ScheduleInput): Promise<ScheduledJobView> {
  const count = await db.scheduledJob.count();
  if (count >= SCHEDULE_LIMITS.jobs) {
    throw new Error("too-many-jobs");
  }
  // A disabled job still needs a next run; it is simply never claimed.
  const nextRunAt = nextLocalOccurrence({ ...input, dayOfWeek: input.dayOfWeek ?? null }, new Date());
  const row = await db.scheduledJob.create({
    data: {
      kind: input.kind,
      enabled: input.enabled,
      useModel: input.useModel ?? false,
      localTime: input.localTime,
      timeZone: input.timeZone,
      interval: input.interval,
      dayOfWeek: input.interval === "weekly" ? input.dayOfWeek ?? null : null,
      nextRunAt
    },
    select: jobViewSelect
  });
  return toView(row);
}

export async function updateScheduledJob(id: string, patch: Partial<ScheduleInput>): Promise<ScheduledJobView | null> {
  const existing = await db.scheduledJob.findUnique({ where: { id }, select: { id: true, localTime: true, timeZone: true, interval: true, dayOfWeek: true } });
  if (!existing) return null;
  const merged = {
    localTime: patch.localTime ?? existing.localTime,
    timeZone: patch.timeZone ?? existing.timeZone,
    interval: patch.interval ?? existing.interval,
    dayOfWeek: patch.dayOfWeek === undefined ? existing.dayOfWeek : patch.dayOfWeek
  };
  // A patch is judged against the schedule it produces, not against itself: a
  // daily job switched to weekly arrives with no weekday of its own, and the
  // stored null would turn it into the drifting every-24-hours job.
  if (merged.interval === "weekly" && merged.dayOfWeek === null) {
    throw new ApiError({ code: "VALIDATION_ERROR", message: "A weekly schedule needs a day of the week" });
  }
  // Only a change to *when* it fires re-anchors what is owed. A pause or a
  // resume does not: recomputing on `enabled` alone pushed a run that was
  // already due today out to tomorrow, with nothing in the interface to say so.
  const movedInTime =
    patch.localTime !== undefined || patch.timeZone !== undefined || patch.interval !== undefined || patch.dayOfWeek !== undefined;
  const row = await db.scheduledJob.update({
    where: { id },
    data: {
      ...(patch.kind ? { kind: patch.kind } : {}),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.useModel === undefined ? {} : { useModel: patch.useModel }),
      localTime: merged.localTime,
      timeZone: merged.timeZone,
      interval: merged.interval,
      dayOfWeek: merged.interval === "weekly" ? merged.dayOfWeek : null,
      // Only a change to when it fires re-anchors what is owed; otherwise a job
      // edited from 09:00 to 21:00 would still run at the old hour today.
      ...(movedInTime ? { nextRunAt: nextLocalOccurrence(merged, new Date()) } : {})
    },
    select: jobViewSelect
  });
  return toView(row);
}

export async function deleteScheduledJob(id: string): Promise<{ deleted: boolean }> {
  const existing = await db.scheduledJob.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return { deleted: false };
  await db.scheduledJob.delete({ where: { id } });
  return { deleted: true };
}

/**
 * Take the jobs that are due, once each.
 *
 * The claim and the read are in one transaction, and the update repeats the
 * same condition the read used, so a second caller that arrives between them
 * updates nothing and claims nothing. That is what makes two backups at 08:00
 * impossible rather than unlikely.
 */
export type ClaimedJob = { id: string; kind: string; runId: string; requestId: string; timeZone: string; useModel: boolean };

export async function claimDueJobs(now = new Date()): Promise<ClaimedJob[]> {
  return db.$transaction(async (tx) => {
    if (await tx.scheduledJob.count({ where: { lastStatus: "running" } }) || await tx.scheduledRun.count({ where: { status: "running" } })) return [];
    const due = await tx.scheduledJob.findMany({
      // `lastStatus` is part of the claim condition, not just a note afterwards:
      // it is the field the claim itself changes, so a second caller that
      // arrives mid-transaction matches nothing. Guarding on `nextRunAt` alone
      // would let two callers both claim, because claiming does not move it.
      // The null branch is explicit because SQLite treats `!= NULL` as unknown,
      // so a job that has never run would otherwise match no claim at all.
      where: { enabled: true, nextRunAt: { lte: now }, OR: [{ lastStatus: null }, { lastStatus: { not: "running" } }] },
      orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
      take: 1,
      select: { id: true, kind: true, timeZone: true, useModel: true }
    });
    if (due.length === 0) return [];
    const claimed = await tx.scheduledJob.updateMany({
      where: { id: due[0].id, enabled: true, nextRunAt: { lte: now }, OR: [{ lastStatus: null }, { lastStatus: { not: "running" } }] },
      data: { lastStatus: "running", lastRunAt: now, lastError: null }
    });
    if (claimed.count !== 1) return [];
    const run = await tx.scheduledRun.create({ data: { jobId: due[0].id, kind: due[0].kind, startedAt: now, requestId: dataRequestContext()?.requestId ?? randomUUID() } });
    return [{ ...due[0], runId: run.id, requestId: run.requestId }];
  });
}

export async function claimScheduledRetry(jobId: string, previousRunId: string, now = new Date()): Promise<ClaimedJob> {
  return db.$transaction(async tx => {
    const job = await tx.scheduledJob.findUnique({ where: { id: jobId } });
    if (!job) throw new ApiError({ code: "NOT_FOUND", message: "定时任务不存在。" });
    if (!job.enabled) throw new ApiError({ code: "CONFLICT", message: "请先启用定时任务，再发起新的执行。" });
    if (await tx.scheduledJob.count({ where: { lastStatus: "running" } }) || await tx.scheduledRun.count({ where: { status: "running" } })) throw new ApiError({ code: "CONFLICT", message: "已有定时任务正在执行，请等待完成。" });
    const latest = await tx.scheduledRun.findFirst({ where: { jobId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
    if (!latest || latest.id !== previousRunId || latest.status !== "failed" || latest.chatId || latest.backupId || latest.kind !== job.kind) {
      throw new ApiError({ code: "CONFLICT", message: "该记录不能重试，请刷新并核对已有结果。" });
    }
    if (await tx.scheduledRun.findUnique({ where: { retryOf: previousRunId } })) throw new ApiError({ code: "CONFLICT", message: "该重试已经发起，请刷新执行记录。" });
    await tx.scheduledJob.update({ where: { id: jobId }, data: { lastStatus: "running", lastRunAt: now, lastError: null } });
    const run = await tx.scheduledRun.create({ data: { jobId, kind: job.kind, trigger: "manual", retryOf: previousRunId, requestId: dataRequestContext()?.requestId ?? randomUUID(), startedAt: now } });
    return { id: jobId, kind: job.kind, runId: run.id, requestId: run.requestId, timeZone: job.timeZone, useModel: job.useModel };
  });
}

/**
 * Record what happened and what the job now owes.
 *
 * The next run is recomputed from now rather than advanced by one interval, so
 * a machine that was asleep for a week runs once and then resumes. `take: 1`
 * above is what keeps this to one job at a time.
 */
export async function completeJob(id: string, outcome: { ok: boolean; error?: string; chatId?: string; backupId?: string }, now = new Date(), runId?: string): Promise<void> {
  await db.$transaction(async tx => {
    if (runId) {
      const closed = await tx.scheduledRun.updateMany({ where: { id: runId, status: "running" }, data: {
        status: outcome.ok ? "succeeded" : "failed", errorCode: outcome.error ?? (outcome.ok ? null : "INTERNAL_ERROR"),
        chatId: outcome.chatId ?? null, backupId: outcome.backupId ?? null, finishedAt: now,
      } });
      if (!closed.count) return;
    }
    const job = await tx.scheduledJob.findUnique({ where: { id }, select: { localTime: true, timeZone: true, interval: true, dayOfWeek: true, nextRunAt: true } });
    if (job) await tx.scheduledJob.update({ where: { id }, data: {
      lastStatus: outcome.ok ? "done" : "failed",
      lastError: outcome.error?.slice(0, 500) ?? (outcome.ok ? null : "INTERNAL_ERROR"),
      // Strictly after completion: an execution finishing exactly at its wall
      // clock minute must not leave that occurrence due a second time.
      nextRunAt: nextLocalOccurrence(job, new Date(now.getTime() + 1))
    } });
    await pruneScheduledHistory(tx, now);
  });
}

/**
 * Release jobs a process left in flight.
 *
 * A run that was interrupted by the process going away is not owed again: it is
 * marked so the next poll does not wait for a claim that will never come, and
 * the schedule resumes from the current time.
 *
 * Only the rows this call actually released are re-anchored. Matching the
 * follow-up rewrite on `lastStatus` instead of on the ids just flipped also
 * moved every job some earlier launch had interrupted — including disabled ones
 * this launch never looked at — and returned a count that did not describe what
 * was written. The read, the flip and the rewrite share one transaction, so a
 * failure part-way cannot leave the rest holding their old next run.
 */
export async function releaseInterruptedJobs(now = new Date()): Promise<number> {
  return db.$transaction(async (tx) => {
    await tx.workspaceReview.updateMany({ where: { modelStatus: "pending" }, data: { modelStatus: "interrupted", modelError: "INTERRUPTED" } });
    await tx.scheduledRun.updateMany({ where: { status: "running" }, data: { status: "interrupted", errorCode: "INTERRUPTED", finishedAt: now } });
    await pruneScheduledHistory(tx, now);
    const running = await tx.scheduledJob.findMany({
      where: { lastStatus: "running" },
      select: { id: true, localTime: true, timeZone: true, interval: true, dayOfWeek: true }
    });
    if (running.length === 0) return 0;
    const result = await tx.scheduledJob.updateMany({
      where: { id: { in: running.map((job) => job.id) }, lastStatus: "running" },
      data: { lastStatus: "interrupted", lastError: "INTERRUPTED" }
    });
    for (const job of running) {
      await tx.scheduledJob.update({ where: { id: job.id }, data: { nextRunAt: nextLocalOccurrence(job, new Date(now.getTime() + 1)) } });
    }
    return result.count;
  });
}
