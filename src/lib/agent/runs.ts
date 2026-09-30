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

/**
 * The next free step position for a run.
 *
 * Counted from the rows the run already holds rather than from zero in each
 * caller, because positions are unique per run: a second tool set built for the
 * same run restarted its own counter at 1, collided with the index, and lost
 * the step entirely.
 */
export async function nextStepPositionForRun(runId: string | null): Promise<number> {
  if (!runId) return 1;
  const count = await db.agentStep.count({ where: { runId } }).catch(() => 0);
  return count + 1;
}

export async function recordStep(params: {
  runId: string;
  position: number;
  kind: "tool" | "approval" | "answer" | "note";
  toolName?: string;
  state?: StepState;
  input?: unknown;
  output?: unknown;
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
      errorCode: params.errorCode ?? null,
      finishedAt: params.finished ? new Date() : null,
    },
  });
}

export async function updateStep(stepId: string, data: { state?: StepState; output?: unknown; errorCode?: string | null; finished?: boolean }) {
  return db.agentStep.update({
    where: { id: stepId },
    data: {
      ...(data.state ? { state: data.state } : {}),
      ...(data.output === undefined ? {} : { output: data.output as never }),
      ...(data.errorCode === undefined ? {} : { errorCode: data.errorCode }),
      ...(data.finished ? { finishedAt: new Date() } : {}),
    },
  });
}

/**
 * Closes a run, and only the first close counts.
 *
 * A run that already holds a finish keeps the outcome it was closed with. The
 * turn closing its own run would otherwise overwrite the deadline refusal a
 * step recorded while it was being refused, leaving a run that was stopped for
 * running out of time reading as a plain success.
 */
export async function finishRun(runId: string, status: RunStatus, reason?: string) {
  await db.agentRun.updateMany({
    where: { id: runId, finishedAt: null },
    data: { status, stopReason: reason ?? null, finishedAt: new Date() },
  });
  return db.agentRun.findUnique({ where: { id: runId } });
}

/**
 * The step ceiling the SDK should stop at for this run.
 *
 * Read from the row rather than hard-coded, so the budget the user was shown
 * is the one that binds. The absolute ceiling stays as a backstop: a run row
 * written by a future version with a larger budget must not be able to talk
 * this application into an unbounded loop.
 */
export const ABSOLUTE_STEP_CEILING = 32;

export async function runStepCeiling(runId: string | null): Promise<number> {
  if (!runId) return DEFAULT_BUDGET.maxSteps;
  const run = await db.agentRun
    .findUnique({ where: { id: runId }, select: { maxSteps: true } })
    .catch(() => null);
  if (!run) return DEFAULT_BUDGET.maxSteps;
  return Math.max(1, Math.min(run.maxSteps, ABSOLUTE_STEP_CEILING));
}

/**
 * Whether the run still has room for another step.
 *
 * This is the same decision the tool wrapper makes, exposed separately so the
 * model's stop condition can ask it. Without that, a stopped or over-budget run
 * stopped taking *tool* steps but kept issuing provider requests, because the
 * refusal came back as an ordinary tool result the SDK treated as a completed
 * step. Failing closed matters here for the same reason as in the tool wrapper:
 * a run whose budget cannot be read is exactly the run worth stopping.
 */
export async function runStillAllowsStep(runId: string | null): Promise<boolean> {
  if (!runId) return true;
  const allowance = await checkRunAllowance(runId).catch(() => ({ allowed: false, reason: "run-budget-unreadable" }));
  return allowance.allowed;
}

export async function addRunCost(runId: string, costUsd: number | null) {  if (costUsd === null) return;
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
function currentProcessStart() {
  // Derived from the process itself, not remembered from the first call: a
  // remembered "now" is later than every run started since the server booted, so
  // the first look at the records marked a run that is still in flight as
  // interrupted — and reloading the module restarted that clock.
  return Date.now() - process.uptime() * 1000;
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
      errorCode: step.errorCode,
      startedAt: step.startedAt.toISOString(),
      finishedAt: step.finishedAt?.toISOString() ?? null,
    })),
  }));
}
