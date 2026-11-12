import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";
import { interfaceLocale, wordTask } from "@/lib/scheduler/task-wording";

/**
 * How long after its time a run still counts as on time. The poller looks
 * every minute, so a run starting later than this was held up: RiA was not
 * running, or the task was still busy with its last run, or waiting for a place.
 */
export const LATE_AFTER_MS = 10 * 60_000;

export const HISTORY_LIMITS = { days: 90, rows: 1000, display: 50 } as const;
export type ScheduledRunView = {
  id: string; jobId: string | null; kind: string; trigger: string;
  requestId: string; status: string; errorCode: string | null;
  chatId: string | null; backupId: string | null;
  startedAt: string; finishedAt: string | null;
  /** When a run that started on its own was due, and how many later times passed without a run of their own. */
  scheduledFor: string | null; missedCount: number;
  /** Whether it started long enough after its time to count as late. */
  late: boolean;
  /** The task's name as it is now; null once the task has been deleted. */
  title: string | null;
};

export function scheduledErrorCode(error: unknown): string {
  if (error instanceof ApiError) return error.code;
  if (error instanceof Error && error.name === "TimeoutError") return "TIMEOUT";
  if (error instanceof Error && error.name === "AbortError") return "ABORTED";
  return "INTERNAL_ERROR";
}

export async function pruneScheduledHistory(tx: Prisma.TransactionClient, now: Date) {
  const terminal = { status: { not: "running" } };
  await tx.scheduledRun.deleteMany({ where: { ...terminal, startedAt: { lt: new Date(now.getTime() - HISTORY_LIMITS.days * 86_400_000) } } });
  const boundary = await tx.scheduledRun.findMany({
    where: terminal, orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    skip: HISTORY_LIMITS.rows, take: 1, select: { startedAt: true, id: true },
  });
  if (boundary[0]) await tx.scheduledRun.deleteMany({ where: { ...terminal, OR: [
    { startedAt: { lt: boundary[0].startedAt } },
    { startedAt: boundary[0].startedAt, id: { lte: boundary[0].id } },
  ] } });
}

export async function listScheduledRuns(jobId?: string): Promise<ScheduledRunView[]> {
  const rows = await db.scheduledRun.findMany({
    where: jobId ? { jobId } : {},
    orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: HISTORY_LIMITS.display,
    include: { job: { select: { title: true, prompt: true, template: true } } },
  });
  const locale = await interfaceLocale();
  return rows.map(({ job, retryOf: _retryOf, ...run }) => ({ ...run, title: job ? wordTask(job, locale).title : null,
    startedAt: run.startedAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null, scheduledFor: run.scheduledFor?.toISOString() ?? null,
    late: run.scheduledFor !== null && run.startedAt.getTime() - run.scheduledFor.getTime() > LATE_AFTER_MS }));
}

// Export only defined structural fields. Even redacted inputs, provider error
// messages and run goals can contain personal data or credentials.
const token = (value: string | null) => value === null ? null : createHash("sha256").update(value).digest("hex").slice(0, 16);
const safe = (value: string | null, allowed: readonly string[]) => value !== null && allowed.includes(value) ? value : value === null ? null : "other";
const kinds = ["prompt", "backupReminder", "scheduledBackup", "dailyBrief", "weeklySummary"];
const codes = ["TIMEOUT", "ABORTED", "UNAUTHORIZED", "FORBIDDEN", "CONFIGURATION_ERROR", "SERVICE_UNAVAILABLE", "UPSTREAM_FAILED", "INTERNAL_ERROR", "VALIDATION_ERROR", "CONTEXT_LIMIT", "BACKGROUND_LIMIT", "NOT_FOUND", "CONFLICT", "RATE_LIMITED", "MODEL_UNAVAILABLE", "INTERRUPTED", "UNSUPPORTED_KIND"];
export async function exportExecutionDiagnostics() {
  const [scheduled, agents] = await Promise.all([
    db.scheduledRun.findMany({ orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: 100 }),
    db.agentRun.findMany({ orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: 100,
      select: { id: true, status: true, startedAt: true, finishedAt: true, steps: { select: { state: true, errorCode: true }, take: 32, orderBy: { position: "asc" } } } }),
  ]);
  return { format: "ria-execution-diagnostics", version: 1, generatedAt: new Date().toISOString(),
    retention: HISTORY_LIMITS,
    scheduled: scheduled.map(run => ({ id: token(run.id), jobId: token(run.jobId), requestId: token(run.requestId),
      kind: safe(run.kind, kinds),
      trigger: safe(run.trigger, ["scheduled", "manual"]), status: safe(run.status, ["running", "succeeded", "failed", "interrupted", "waiting_approval", "skipped", "missed"]),
      missedCount: run.missedCount,
      errorCode: safe(run.errorCode, codes), startedAt: run.startedAt, finishedAt: run.finishedAt,
      hasConversation: !!run.chatId, hasBackup: !!run.backupId,
    })),
    agents: agents.map(run => ({ id: token(run.id), status: safe(run.status, ["running", "waiting_approval", "paused", "succeeded", "failed", "cancelled"]),
      startedAt: run.startedAt, finishedAt: run.finishedAt,
      steps: run.steps.map(step => ({ state: safe(step.state, ["running", "waiting_approval", "done", "failed", "skipped", "denied", "cancelled"]), errorCode: safe(step.errorCode, codes) })),
    })),
  };
}
