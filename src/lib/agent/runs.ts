import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";

/**
 * Execution records.
 *
 * A run is one assistant turn that used tools. It exists so three things can be
 * true at once: the reader can see what was done and what it produced, the work
 * is bounded by a budget that is enforced rather than assumed, and stopping the
 * remaining steps is a recorded fact rather than a disappearance.
 *
 * Everything here is best-effort bookkeeping. A run that cannot be written must
 * never be the reason an answer fails, so failures are swallowed where the work
 * itself has already happened — but a budget that cannot be read does refuse,
 * because an unbounded run is the thing worth preventing.
 */

export type RunStatus = "running" | "waiting_approval" | "paused" | "succeeded" | "failed" | "cancelled";
export type StepState = "running" | "waiting_approval" | "done" | "failed" | "skipped" | "denied" | "cancelled";

export const DEFAULT_BUDGET = { maxSteps: 8, maxFailures: 2, deadlineMs: 120_000 } as const;

export type RunBudget = {
  maxSteps: number;
  maxFailures: number;
  deadlineMs: number;
  maxCostUsd: number | null;
};

function budgetOf(run: { maxSteps: number; maxFailures: number; deadlineMs: number; maxCostUsd: number | null }): RunBudget {
  return { maxSteps: run.maxSteps, maxFailures: run.maxFailures, deadlineMs: run.deadlineMs, maxCostUsd: run.maxCostUsd };
}

export async function startRun(params: { chatId: string | null; goal: string; budget?: Partial<RunBudget> }) {
  const budget = { ...DEFAULT_BUDGET, ...params.budget };
  return db.agentRun.create({
    data: {
      chatId: params.chatId,
      goal: params.goal.slice(0, 500),
      status: "running",
      maxSteps: budget.maxSteps,
      maxFailures: budget.maxFailures,
      deadlineMs: budget.deadlineMs,
      maxCostUsd: budget.maxCostUsd ?? null,
    },
  });
}

/**
 * Whether another step may start. A refused step is a recorded decision, not an
 * error: the answer continues with what it already has.
 */
export async function checkRunAllowance(runId: string): Promise<{ allowed: boolean; reason: string | null }> {
  const run = await db.agentRun.findUnique({ where: { id: runId } });
  if (!run) return { allowed: false, reason: "run-missing" };
  if (run.status === "cancelled" || run.status === "paused") return { allowed: false, reason: `run-${run.status}` };
  if (Date.now() - run.startedAt.getTime() > run.deadlineMs) {
    await finishRun(runId, "failed", "deadline-exceeded").catch(() => undefined);
    return { allowed: false, reason: "deadline-exceeded" };
  }
  const steps = await db.agentStep.findMany({ where: { runId }, select: { state: true } });
  if (steps.length >= run.maxSteps) return { allowed: false, reason: "step-budget" };
  const failures = steps.filter((step) => step.state === "failed").length;
  if (failures >= run.maxFailures) return { allowed: false, reason: "failure-budget" };
  if (run.maxCostUsd !== null && run.spentCostUsd >= run.maxCostUsd) return { allowed: false, reason: "cost-budget" };
  return { allowed: true, reason: null };
}

export async function recordStep(params: {
  runId: string;
  position: number;
  kind: "tool" | "approval" | "answer" | "note";
  toolName?: string;
  state?: StepState;
  input?: unknown;
  output?: unknown;
  artifactAssetId?: string | null;
  errorCode?: string | null;
  finished?: boolean;
}) {
  return db.agentStep.create({
    data: {
      runId: params.runId,
      position: params.position,
      kind: params.kind,
      toolName: params.toolName ?? null,
      state: params.state ?? "running",
      input: params.input === undefined ? undefined : (params.input as never),
      output: params.output === undefined ? undefined : (params.output as never),
      artifactAssetId: params.artifactAssetId ?? null,
      errorCode: params.errorCode ?? null,
      finishedAt: params.finished ? new Date() : null,
    },
  });
}

export async function updateStep(stepId: string, data: { state?: StepState; output?: unknown; errorCode?: string | null; artifactAssetId?: string | null; finished?: boolean }) {
  return db.agentStep.update({
    where: { id: stepId },
    data: {
      ...(data.state ? { state: data.state } : {}),
      ...(data.output === undefined ? {} : { output: data.output as never }),
      ...(data.errorCode === undefined ? {} : { errorCode: data.errorCode }),
      ...(data.artifactAssetId === undefined ? {} : { artifactAssetId: data.artifactAssetId }),
      ...(data.finished ? { finishedAt: new Date() } : {}),
    },
  });
}

export async function finishRun(runId: string, status: RunStatus, reason?: string) {
  return db.agentRun.update({
    where: { id: runId },
    data: { status, stopReason: reason ?? null, finishedAt: new Date() },
  });
}

export async function addRunCost(runId: string, costUsd: number | null) {
  if (costUsd === null) return;
  await db.agentRun.update({ where: { id: runId }, data: { spentCostUsd: { increment: costUsd } } });
}

/** Stops a run and marks its unfinished steps, so nothing appears to be in flight. */
export async function cancelRun(runId: string, reason: string) {
  const run = await db.agentRun.findUnique({ where: { id: runId } });
  if (!run) throw new ApiError({ code: "NOT_FOUND", message: "Run not found" });
  if (run.status !== "running" && run.status !== "waiting_approval") return run;
  await db.agentStep.updateMany({
    where: { runId, state: { in: ["running", "waiting_approval"] } },
    data: { state: "cancelled", finishedAt: new Date() },
  });
  return finishRun(runId, "cancelled", reason);
}

export type RunView = {
  id: string;
  chatId: string | null;
  goal: string;
  status: RunStatus;
  stopReason: string | null;
  startedAt: string;
  finishedAt: string | null;
  budget: RunBudget & { spentCostUsd: number };
  steps: {
    id: string;
    position: number;
    kind: string;
    toolName: string | null;
    state: StepState;
    output: unknown;
    artifactAssetId: string | null;
    errorCode: string | null;
    startedAt: string;
    finishedAt: string | null;
  }[];
};

/**
 * A run that was in flight when the process went away cannot still be running.
 * Marking it interrupted is what keeps a restart from replaying anything: the
 * record says the turn stopped and waits for a decision, instead of the next
 * request picking up where an answer that never finished left off.
 */
let processStartedAt: number | null = null;

function currentProcessStart() {
  processStartedAt ??= Date.now();
  return processStartedAt;
}

export async function reconcileInterruptedRuns() {
  const startedAt = currentProcessStart();
  const orphans = await db.agentRun.findMany({
    where: { status: { in: ["running", "waiting_approval"] }, startedAt: { lt: new Date(startedAt) } },
    select: { id: true },
  });
  if (orphans.length === 0) return 0;
  await db.agentStep.updateMany({
    where: { runId: { in: orphans.map((run) => run.id) }, state: { in: ["running", "waiting_approval"] } },
    data: { state: "cancelled", finishedAt: new Date() },
  });
  await db.agentRun.updateMany({
    where: { id: { in: orphans.map((run) => run.id) } },
    data: { status: "paused", stopReason: "interrupted-by-restart", finishedAt: new Date() },
  });
  return orphans.length;
}

export async function listRuns(chatId: string, limit = 20): Promise<RunView[]> {
  // Cheap and self-healing: a stale "running" row is corrected the first time
  // anyone looks at the records after a restart.
  await reconcileInterruptedRuns().catch(() => 0);
  const runs = await db.agentRun.findMany({
    where: { chatId },
    orderBy: { startedAt: "desc" },
    take: limit,
    include: { steps: { orderBy: { position: "asc" } } },
  });
  return runs.map((run) => ({
    id: run.id,
    chatId: run.chatId,
    goal: run.goal,
    status: run.status as RunStatus,
    stopReason: run.stopReason,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    budget: { ...budgetOf(run), spentCostUsd: run.spentCostUsd },
    steps: run.steps.map((step) => ({
      id: step.id,
      position: step.position,
      kind: step.kind,
      toolName: step.toolName,
      state: step.state as StepState,
      output: step.output,
      artifactAssetId: step.artifactAssetId,
      errorCode: step.errorCode,
      startedAt: step.startedAt.toISOString(),
      finishedAt: step.finishedAt?.toISOString() ?? null,
    })),
  }));
}
