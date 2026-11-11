import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";
import { dataRequestContext } from "@/lib/server/data-operations";
import { LATE_AFTER_MS, pruneScheduledHistory } from "@/lib/scheduler/history";
import { isTimeZone, nextCronOccurrence, parseCron, parseRunTime } from "@/lib/scheduler/cron";
import { isWordedTemplate, WORDED_TEMPLATES } from "@/lib/scheduler/task-wording";
import { modelRefSchema, type ModelRef } from "@/lib/models/preferences-schema";
import { modelInLibrary } from "@/lib/models/preferences";
import { assertSelectableWorkspace } from "@/lib/local-files/workspace";
import { approvalRuleSchema, readApprovalRule, type ApprovalRule } from "@/lib/approvals/rules";
import { readTaskEffort, readTaskNotify, taskEffortSchema, taskNotifySchema, type TaskEffort, type TaskNotify } from "@/lib/scheduler/task-settings";

/*
 * Tasks: work the user asked to happen at a time, without being present.
 *
 * A task is a prompt the model carries out in the task's own conversation, or
 * one of the built-in actions that involve no model at all (a backup, a
 * reminder that one is due). It runs once at a chosen time, or repeats on a
 * cron expression read in the task's time zone.
 *
 * Three rules shape everything here:
 *
 * - Nothing runs until it is switched on. A background process that starts on
 *   its own is one the user did not ask for.
 * - A due task is claimed, not merely seen. The claim changes the row it
 *   matched on, so the same task cannot be running twice.
 * - A machine that was asleep catches up **once**. The next run is recomputed
 *   from the current time rather than advanced occurrence by occurrence, so a
 *   laptop opened after a week owes one run, not seven.
 */

export const TASK_LIMITS = {
  /** Tasks in the workspace. */
  tasks: 200,
  /** How often the poller looks. */
  pollIntervalMs: 60_000,
  lateAfterMs: LATE_AFTER_MS,
  /** Missed times counted for one run; a task due every minute for a week would otherwise be counted ten thousand times over. */
  missedCountLimit: 1000,
} as const;

export const TASK_KINDS = ["prompt", "scheduledBackup", "backupReminder"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

const titleSchema = z.string().trim().min(1).max(120);
// Empty means "the template's name", for a task made from one.
const templateTitleSchema = z.string().trim().max(120);
const promptSchema = z.string().trim().min(1).max(20_000);
const cronSchema = z.string().trim().min(1).max(200).refine(value => parseCron(value) !== null, "Invalid cron expression");
const timeZoneSchema = z.string().min(1).max(100).refine(isTimeZone, "Invalid IANA time zone");
const runAtSchema = z.string().trim().min(1).max(40);
/** Null follows the default chat model at the time of each turn. */
const taskModelSchema = modelRefSchema.nullable();
const workspaceSchema = z.string().trim().min(1).max(200).nullable();

/** Creation. A task repeats on `cron`, runs once at `runAt`, or, with neither, runs only when started by hand. */
export const taskInputSchema = z.strictObject({
  kind: z.enum(TASK_KINDS).default("prompt"),
  /** The template a prompt task was made from; its empty name and missing prompt are worded from it. */
  template: z.enum(WORDED_TEMPLATES).optional(),
  title: templateTitleSchema,
  prompt: promptSchema.nullable().optional(),
  // Off unless the caller says otherwise, so a form that forgets the switch
  // makes a task that does nothing rather than one that starts on its own.
  enabled: z.boolean().default(false),
  cron: cronSchema.nullable().optional(),
  runAt: runAtSchema.nullable().optional(),
  timeZone: timeZoneSchema,
  // A time that passed while RiA could not run it still runs once, unless the user says otherwise.
  catchUp: z.boolean().default(true),
  // What every turn in the task's conversation uses. A built-in action has neither.
  model: taskModelSchema.default(null),
  workspaceGrantId: workspaceSchema.default(null),
  // What the turns may do in the folder without asking; a run stops at the first approval under "ask".
  approvalRule: approvalRuleSchema.default("ask"),
  // A task repeats an instruction by itself, which is not something the user said about themselves.
  usesMemory: z.boolean().default(false),
  notify: taskNotifySchema.default("all"),
  reasoningEffort: taskEffortSchema.default(null),
});

/** Every field optional: a change may touch one thing about a task. Whether the
 * result is coherent depends on the stored row, so `updateTask` checks the
 * merged task rather than the patch. */
export const taskPatchSchema = z.strictObject({
  title: templateTitleSchema.optional(),
  /** Null hands the prompt back to the task's template. */
  prompt: promptSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  cron: cronSchema.nullable().optional(),
  runAt: runAtSchema.nullable().optional(),
  timeZone: timeZoneSchema.optional(),
  catchUp: z.boolean().optional(),
  model: taskModelSchema.optional(),
  workspaceGrantId: workspaceSchema.optional(),
  approvalRule: approvalRuleSchema.optional(),
  usesMemory: z.boolean().optional(),
  notify: taskNotifySchema.optional(),
  reasoningEffort: taskEffortSchema.optional(),
}).refine(value => Object.keys(value).length > 0, "At least one field is required");

export type TaskInput = z.input<typeof taskInputSchema>;
export type TaskPatch = z.infer<typeof taskPatchSchema>;

export type TaskView = {
  id: string;
  kind: string;
  /** Empty while the task uses its template's name. */
  title: string;
  /** Null while the task uses its template's prompt. */
  prompt: string | null;
  template: string | null;
  enabled: boolean;
  cron: string | null;
  timeZone: string;
  chatId: string | null;
  /** Null for a task that runs only when started by hand. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  catchUp: boolean;
  /** The model the task's turns use; null follows the default chat model. */
  model: ModelRef | null;
  /** The folder the task's turns work in; null for none. */
  workspaceGrantId: string | null;
  approvalRule: ApprovalRule;
  usesMemory: boolean;
  notify: TaskNotify;
  /** Null follows the app's reasoning setting. */
  reasoningEffort: TaskEffort | null;
};

const taskSelect = {
  id: true, kind: true, title: true, prompt: true, template: true, enabled: true, cron: true, timeZone: true, chatId: true, catchUp: true,
  nextRunAt: true, lastRunAt: true, lastStatus: true, lastError: true, modelProvider: true, modelId: true, workspaceGrantId: true,
  approvalRule: true, usesMemory: true, notify: true, reasoningEffort: true,
} as const;

type TaskRow = Prisma.ScheduledJobGetPayload<{ select: typeof taskSelect }>;

/** A stored model reference, or null when either half is missing. */
export function taskModel(row: { modelProvider: string | null; modelId: string | null }): ModelRef | null {
  const parsed = row.modelProvider && row.modelId ? modelRefSchema.safeParse({ providerId: row.modelProvider, modelId: row.modelId }) : null;
  return parsed?.success ? parsed.data : null;
}

function toView({ modelProvider, modelId, ...row }: TaskRow): TaskView {
  return {
    ...row, model: taskModel({ modelProvider, modelId }), nextRunAt: row.nextRunAt?.toISOString() ?? null, lastRunAt: row.lastRunAt?.toISOString() ?? null,
    approvalRule: readApprovalRule(row.approvalRule), notify: readTaskNotify(row.notify), reasoningEffort: readTaskEffort(row.reasoningEffort),
  };
}

type TurnSettings = { model?: ModelRef | null; workspaceGrantId?: string | null; approvalRule?: ApprovalRule; usesMemory?: boolean; notify?: TaskNotify; reasoningEffort?: TaskEffort | null };

/**
 * What a task decides about its turns, stored once checked. A model must be
 * one added for chat, and a folder one that is granted, so a task cannot be
 * saved pointing at something its first run would be refused. A built-in
 * action has no turns, so it takes none of these beyond their defaults.
 */
async function turnSettings(kind: string, patch: TurnSettings) {
  const data: { modelProvider?: string | null; modelId?: string | null; workspaceGrantId?: string | null; approvalRule?: string; usesMemory?: boolean; notify?: string; reasoningEffort?: string | null } = {};
  const builtIn = kind !== "prompt";
  if (builtIn && ((patch.approvalRule && patch.approvalRule !== "ask") || patch.usesMemory || (patch.notify && patch.notify !== "all") || patch.reasoningEffort)) {
    throw invalid("A built-in action has no conversation to set this for");
  }
  if (patch.approvalRule !== undefined) data.approvalRule = patch.approvalRule;
  if (patch.usesMemory !== undefined) data.usesMemory = patch.usesMemory;
  if (patch.notify !== undefined) data.notify = patch.notify;
  if (patch.reasoningEffort !== undefined) data.reasoningEffort = patch.reasoningEffort;
  if (patch.model !== undefined) {
    if (patch.model && kind !== "prompt") throw invalid("A built-in action uses no model");
    if (patch.model && !(await modelInLibrary("chat", patch.model))?.modes.includes("chat")) throw invalid("Choose a model added for chat");
    data.modelProvider = patch.model?.providerId ?? null;
    data.modelId = patch.model?.modelId ?? null;
  }
  if (patch.workspaceGrantId !== undefined) {
    if (patch.workspaceGrantId && kind !== "prompt") throw invalid("A built-in action uses no folder");
    await assertSelectableWorkspace(patch.workspaceGrantId);
    data.workspaceGrantId = patch.workspaceGrantId;
  }
  return data;
}

const invalid = (message: string) => new ApiError({ code: "VALIDATION_ERROR", message });

/**
 * When a schedule next fires.
 *
 * A request that names no time that will ever come is refused here, where the
 * caller can be told, rather than stored as a task that silently never runs.
 */
function firstRun(schedule: { cron: string | null; runAt?: string | null; timeZone: string }, now: Date): Date {
  // Callers ask only for a schedule that names a time; a task run only by hand has none.
  if (schedule.cron) {
    const next = nextCronOccurrence(schedule.cron, schedule.timeZone, now);
    if (!next) throw invalid("This schedule never occurs");
    return next;
  }
  const at = schedule.runAt ? parseRunTime(schedule.runAt, schedule.timeZone) : null;
  if (!at) throw invalid("A task that runs once needs a date and time that exists in its time zone");
  return at;
}

export async function listTasks(): Promise<TaskView[]> {
  const rows = await db.scheduledJob.findMany({ orderBy: [{ createdAt: "desc" }, { id: "asc" }], select: taskSelect });
  return rows.map(toView);
}

export async function getTask(id: string): Promise<TaskView | null> {
  const row = await db.scheduledJob.findUnique({ where: { id }, select: taskSelect });
  return row ? toView(row) : null;
}

export async function createTask(raw: TaskInput, now = new Date()): Promise<TaskView> {
  const input = taskInputSchema.parse(raw);
  const template = input.kind === "prompt" && input.template ? input.template : null;
  if (input.kind !== "prompt" && input.template) throw invalid("Only a prompt task is made from a wording template");
  if (input.kind === "prompt" && !input.prompt && !template) throw invalid("A task needs a prompt");
  if (input.kind !== "prompt" && input.prompt) throw invalid("A built-in action takes no prompt");
  if (!input.title && !template) throw invalid("A task needs a name");
  if (input.cron && input.runAt) throw invalid("Give either a repeating schedule or a time to run once");
  if (await db.scheduledJob.count() >= TASK_LIMITS.tasks) throw new ApiError({ code: "VALIDATION_ERROR", message: "There are too many tasks; delete one you no longer need" });
  // With neither a repeat nor a time, the task runs only when started by hand.
  const manual = !input.cron && !input.runAt;
  const nextRunAt = manual ? null : firstRun({ cron: input.cron ?? null, runAt: input.runAt, timeZone: input.timeZone }, now);
  // A time already gone would run the moment the task is saved, which is not
  // what choosing a time means.
  if (!input.cron && nextRunAt && nextRunAt.getTime() < now.getTime()) throw invalid("The time to run has already passed");
  const settings = await turnSettings(input.kind, input);
  const row = await db.scheduledJob.create({
    data: {
      kind: input.kind, title: input.title, template, prompt: input.kind === "prompt" ? input.prompt ?? null : null,
      enabled: input.enabled, cron: input.cron ?? null, timeZone: input.timeZone, nextRunAt, catchUp: input.catchUp, ...settings,
    },
    select: taskSelect,
  });
  return toView(row);
}

export async function updateTask(id: string, patch: TaskPatch, now = new Date()): Promise<TaskView | null> {
  const existing = await db.scheduledJob.findUnique({ where: { id }, select: taskSelect });
  if (!existing) return null;
  if (patch.prompt !== undefined && existing.kind !== "prompt") throw invalid("A built-in action takes no prompt");
  // Only a task made from a template can hand its name or prompt back to it.
  if (patch.title === "" && !isWordedTemplate(existing.template)) throw invalid("A task needs a name");
  if (patch.prompt === null && !isWordedTemplate(existing.template)) throw invalid("A task needs a prompt");
  if (patch.cron && patch.runAt) throw invalid("Give either a repeating schedule or a time to run once");
  // Naming a time to run once ends a repeat, and a repeat replaces a single
  // time. Clearing both says the task runs only when started by hand.
  const manual = patch.cron === null && patch.runAt === null;
  const cron = patch.runAt || manual ? null : patch.cron === undefined ? existing.cron : patch.cron;
  const timeZone = patch.timeZone ?? existing.timeZone;
  // Only a change to *when* it fires re-anchors what is owed. A pause, a
  // resume, or an edit that sends the same schedule back does not: recomputing
  // then would push a run that was already due out to its next time, with
  // nothing in the interface to say so.
  const onceAt = patch.runAt ? firstRun({ cron: null, runAt: patch.runAt, timeZone }, now) : null;
  const movedInTime = manual ? existing.nextRunAt !== null : cron !== existing.cron || (cron !== null && timeZone !== existing.timeZone)
    || (onceAt !== null && (existing.cron !== null || onceAt.getTime() !== existing.nextRunAt?.getTime()));
  let nextRunAt = existing.nextRunAt;
  if (movedInTime) {
    nextRunAt = manual ? null : onceAt ?? firstRun({ cron, timeZone }, now);
    if (!cron && nextRunAt && nextRunAt.getTime() < now.getTime()) throw invalid("The time to run has already passed");
  }
  // A task that already ran once has no time left to run at. Switching it back
  // on without choosing one would run it at once, unasked.
  if (patch.enabled === true && !existing.enabled && !cron && nextRunAt && nextRunAt.getTime() < now.getTime()) {
    throw invalid("Choose a new time before switching this task on");
  }
  const settings = await turnSettings(existing.kind, patch);
  // Memory switched back on reads nothing said while it was off, as in any conversation.
  if (patch.usesMemory === true && !existing.usesMemory && existing.chatId) {
    await db.chat.updateMany({ where: { id: existing.chatId }, data: { memoryResumedAt: now } });
  }
  const row = await db.scheduledJob.update({
    where: { id },
    data: {
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.prompt === undefined ? {} : { prompt: patch.prompt }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.catchUp === undefined ? {} : { catchUp: patch.catchUp }),
      ...settings,
      cron, timeZone, nextRunAt,
    },
    select: taskSelect,
  });
  return toView(row);
}

export async function deleteTask(id: string): Promise<{ deleted: boolean }> {
  // The conversation is kept: what the task did there is the user's to read or delete.
  const removed = await db.scheduledJob.deleteMany({ where: { id, OR: [{ lastStatus: null }, { lastStatus: { not: "running" } }] } });
  if (removed.count) return { deleted: true };
  if (await db.scheduledJob.findUnique({ where: { id }, select: { id: true } })) {
    throw new ApiError({ code: "CONFLICT", message: "The task is running; stop it first" });
  }
  return { deleted: false };
}

export type ClaimedTask = {
  id: string; kind: string; title: string; prompt: string | null; template: string | null; timeZone: string; runId: string; requestId: string; trigger: "scheduled" | "manual";
  /** For a run that started on its own: the time it was due, and whether it starts too long after it. */
  scheduledFor: Date | null;
  late: boolean;
  /** Later times of the same task that passed before this run could start. */
  missedBefore: number;
  catchUp: boolean;
  /** Whether a conversation started for the task begins with memory on. */
  usesMemory: boolean;
  notify: TaskNotify;
};

/**
 * How many times a schedule names after `after` and up to `until`: the times
 * that passed without a run of their own. Counted up to a bound.
 */
export function countOccurrences(cron: string | null, timeZone: string, after: Date, until: Date): number {
  if (!cron) return 0;
  let count = 0;
  let next = nextCronOccurrence(cron, timeZone, new Date(after.getTime() + 1));
  while (next && next.getTime() <= until.getTime() && count < TASK_LIMITS.missedCountLimit) {
    count += 1;
    next = nextCronOccurrence(cron, timeZone, new Date(next.getTime() + 1));
  }
  return count;
}

type ClaimSource = { id: string; kind: string; title: string; prompt: string | null; template: string | null; timeZone: string; cron: string | null; nextRunAt: Date | null; catchUp: boolean; usesMemory: boolean; notify: string };
const claimSelect = { id: true, kind: true, title: true, prompt: true, template: true, timeZone: true, cron: true, nextRunAt: true, catchUp: true, usesMemory: true, notify: true } as const;

// The null branch is explicit because SQLite treats `!= NULL` as unknown, so a
// task that has never run would otherwise match no claim at all.
const notRunning = { OR: [{ lastStatus: null }, { lastStatus: { not: "running" } }] };

async function openRun(tx: Prisma.TransactionClient, task: ClaimSource, trigger: "scheduled" | "manual", now: Date): Promise<ClaimedTask> {
  const scheduledFor = trigger === "scheduled" ? task.nextRunAt : null;
  const missedBefore = scheduledFor ? countOccurrences(task.cron, task.timeZone, scheduledFor, now) : 0;
  const run = await tx.scheduledRun.create({ data: {
    jobId: task.id, kind: task.kind, trigger, startedAt: now, requestId: dataRequestContext()?.requestId ?? randomUUID(),
    scheduledFor, missedCount: missedBefore,
  } });
  return {
    id: task.id, kind: task.kind, title: task.title, prompt: task.prompt, template: task.template, timeZone: task.timeZone, catchUp: task.catchUp,
    usesMemory: task.usesMemory, notify: readTaskNotify(task.notify),
    runId: run.id, requestId: run.requestId, trigger, scheduledFor, missedBefore,
    late: scheduledFor !== null && now.getTime() - scheduledFor.getTime() > TASK_LIMITS.lateAfterMs,
  };
}

/**
 * Take one task that is due, once.
 *
 * The claim and the read are in one transaction, and the update repeats the
 * condition the read used. `lastStatus` is part of that condition because it is
 * the field the claim itself changes: a second caller arriving in between
 * matches nothing. Guarding on `nextRunAt` alone would let two callers both
 * claim, because claiming does not move it.
 */
export async function claimDueTask(now = new Date(), options: { prompts?: boolean } = {}): Promise<ClaimedTask | null> {
  // With `prompts: false` only built-in actions are taken; due prompts stay due
  // until a place frees up, rather than being claimed and left waiting.
  const kind = options.prompts === false ? { kind: { not: "prompt" } } : {};
  return db.$transaction(async tx => {
    const due = await tx.scheduledJob.findFirst({
      where: { enabled: true, nextRunAt: { lte: now }, ...notRunning, ...kind },
      orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
      select: claimSelect,
    });
    if (!due) return null;
    const claimed = await tx.scheduledJob.updateMany({
      where: { id: due.id, enabled: true, nextRunAt: { lte: now }, ...notRunning },
      data: { lastStatus: "running", lastRunAt: now, lastError: null },
    });
    return claimed.count === 1 ? openRun(tx, due, "scheduled", now) : null;
  });
}

/** Start a task now because the user asked, whether or not it is switched on. */
export async function claimTaskNow(id: string, now = new Date()): Promise<ClaimedTask> {
  return db.$transaction(async tx => {
    const task = await tx.scheduledJob.findUnique({ where: { id }, select: claimSelect });
    if (!task) throw new ApiError({ code: "NOT_FOUND", message: "Task not found" });
    const claimed = await tx.scheduledJob.updateMany({ where: { id, ...notRunning }, data: { lastStatus: "running", lastRunAt: now, lastError: null } });
    if (claimed.count !== 1) throw new ApiError({ code: "CONFLICT", message: "The task is already running" });
    return openRun(tx, task, "manual", now);
  });
}

export type TaskOutcome = {
  /**
   * How the run ended. A run waiting for an approval has stopped, and carries on
   * in its conversation. A skipped run did nothing: a limit the user set held it back.
   * A missed run did nothing either: its time had passed and the task waits for its next.
   */
  status: "succeeded" | "failed" | "waiting_approval" | "skipped" | "missed";
  error?: string;
  chatId?: string;
  backupId?: string;
};

const LAST_STATUS = { succeeded: "done", failed: "failed", waiting_approval: "waiting_approval", skipped: "skipped", missed: "missed" } as const;

/**
 * Record what happened and what the task now owes.
 *
 * A repeating task's next run is recomputed from now rather than advanced by
 * one occurrence, so a machine that was asleep for a week runs once and then
 * resumes. A task that runs once is switched off: it has done what it was for.
 */
export async function completeTask(id: string, outcome: TaskOutcome, now = new Date(), runId?: string): Promise<void> {
  await db.$transaction(async tx => {
    const task = await tx.scheduledJob.findUnique({ where: { id }, select: { cron: true, timeZone: true, nextRunAt: true } });
    if (runId) {
      const run = await tx.scheduledRun.findUnique({ where: { id: runId }, select: { scheduledFor: true } });
      // Times that passed while this run waited or ran have no run of their own; they are counted on this one.
      const missedCount = run?.scheduledFor && task ? countOccurrences(task.cron, task.timeZone, run.scheduledFor, now) : undefined;
      const closed = await tx.scheduledRun.updateMany({ where: { id: runId, status: "running" }, data: {
        status: outcome.status, errorCode: outcome.error ?? (outcome.status === "failed" ? "INTERNAL_ERROR" : null),
        chatId: outcome.chatId ?? null, backupId: outcome.backupId ?? null, finishedAt: now,
        ...(missedCount === undefined ? {} : { missedCount }),
      } });
      if (!closed.count) return;
    }
    if (task) await tx.scheduledJob.update({ where: { id }, data: {
      lastStatus: LAST_STATUS[outcome.status],
      lastError: outcome.error?.slice(0, 500) ?? (outcome.status === "failed" ? "INTERNAL_ERROR" : null),
      ...afterRun(task, now),
    } });
    await pruneScheduledHistory(tx, now);
  });
}

/**
 * What a task owes after a run.
 *
 * A repeating task's next run is strictly after this one: a run finishing
 * exactly on its minute must not leave that occurrence due again. A task that
 * runs once is used up only once its own time has come; running it by hand
 * before then leaves the time it was set for still to come.
 */
function afterRun(task: { cron: string | null; timeZone: string; nextRunAt: Date | null }, now: Date) {
  // A task run only by hand owes nothing afterwards.
  if (!task.nextRunAt) return {};
  if (!task.cron) return task.nextRunAt.getTime() > now.getTime() ? {} : { enabled: false };
  const next = nextCronOccurrence(task.cron, task.timeZone, new Date(now.getTime() + 1));
  return next ? { nextRunAt: next } : { enabled: false };
}

/**
 * Release tasks a process left in flight.
 *
 * A run interrupted by the process going away is not owed again: it is marked
 * so the next poll does not wait for a claim that will never come, and the
 * schedule resumes from the current time. Only the rows this call released are
 * re-anchored, in the same transaction, so a failure part-way cannot leave the
 * rest holding their old next run.
 */
export async function releaseInterruptedTasks(now = new Date()): Promise<number> {
  return db.$transaction(async tx => {
    await tx.scheduledRun.updateMany({ where: { status: "running" }, data: { status: "interrupted", errorCode: "INTERRUPTED", finishedAt: now } });
    await pruneScheduledHistory(tx, now);
    const running = await tx.scheduledJob.findMany({ where: { lastStatus: "running" }, select: { id: true, cron: true, timeZone: true, nextRunAt: true } });
    for (const task of running) {
      await tx.scheduledJob.update({ where: { id: task.id }, data: { lastStatus: "interrupted", lastError: "INTERRUPTED", ...afterRun(task, now) } });
    }
    return running.length;
  });
}
