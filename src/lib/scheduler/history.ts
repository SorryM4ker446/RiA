import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";

export const HISTORY_LIMITS = { days: 90, rows: 1000, display: 50 } as const;
export type ScheduledRunView = {
  id: string; jobId: string | null; kind: string; trigger: string;
  requestId: string; status: string; errorCode: string | null;
  chatId: string | null; backupId: string | null;
  startedAt: string; finishedAt: string | null; canRetry: boolean;
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

export async function listScheduledRuns(): Promise<ScheduledRunView[]> {
  const rows = await db.scheduledRun.findMany({
    orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: HISTORY_LIMITS.display,
    include: { job: { select: { enabled: true, lastStatus: true, kind: true } } },
  });
  const latest = new Set<string>();
  return rows.map(({ job, ...run }) => {
    const newest = !!run.jobId && !latest.has(run.jobId);
    if (run.jobId) latest.add(run.jobId);
    return { ...run, startedAt: run.startedAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null,
      canRetry: newest && !!job?.enabled && job.kind === run.kind && job.lastStatus !== "running" && run.status === "failed" && !run.chatId && !run.backupId,
    };
  });
}

// Export only defined structural fields. Even redacted inputs, provider error
// messages and run goals can contain personal data or credentials.
const token = (value: string | null) => value === null ? null : createHash("sha256").update(value).digest("hex").slice(0, 16);
const safe = (value: string | null, allowed: readonly string[]) => value !== null && allowed.includes(value) ? value : value === null ? null : "other";
const codes = ["TIMEOUT", "ABORTED", "UNAUTHORIZED", "FORBIDDEN", "CONFIGURATION_ERROR", "SERVICE_UNAVAILABLE", "UPSTREAM_FAILED", "INTERNAL_ERROR", "VALIDATION_ERROR", "NOT_FOUND", "CONFLICT", "RATE_LIMITED", "MODEL_UNAVAILABLE", "INTERRUPTED", "UNSUPPORTED_KIND"];
export async function exportExecutionDiagnostics() {
  const [scheduled, agents] = await Promise.all([
    db.scheduledRun.findMany({ orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: 100 }),
    db.agentRun.findMany({ orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: 100,
      select: { id: true, status: true, startedAt: true, finishedAt: true, steps: { select: { state: true, errorCode: true }, take: 32, orderBy: { position: "asc" } } } }),
  ]);
  return { format: "ria-execution-diagnostics", version: 1, generatedAt: new Date().toISOString(),
    retention: HISTORY_LIMITS,
    scheduled: scheduled.map(run => ({ id: token(run.id), jobId: token(run.jobId), requestId: token(run.requestId),
      kind: safe(run.kind, ["backupReminder", "scheduledBackup", "dailyBrief", "weeklySummary"]),
      trigger: safe(run.trigger, ["scheduled", "manual"]), status: safe(run.status, ["running", "succeeded", "failed", "interrupted"]),
      errorCode: safe(run.errorCode, codes), startedAt: run.startedAt, finishedAt: run.finishedAt,
      hasConversation: !!run.chatId, hasBackup: !!run.backupId,
    })),
    agents: agents.map(run => ({ id: token(run.id), status: safe(run.status, ["running", "waiting_approval", "paused", "succeeded", "failed", "cancelled"]),
      startedAt: run.startedAt, finishedAt: run.finishedAt,
      steps: run.steps.map(step => ({ state: safe(step.state, ["running", "waiting_approval", "done", "failed", "skipped", "denied", "cancelled"]), errorCode: safe(step.errorCode, codes) })),
    })),
  };
}
