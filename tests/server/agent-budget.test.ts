import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createTestDatabase } from "../helpers/database";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { startRun, reserveRunStep, checkRunAllowance, runStepCeiling, cancelRun } = await import("@/lib/agent/runs");
beforeEach(async () => { await db.agentStep.deleteMany({}); await db.agentRun.deleteMany({}); });
after(async () => { await db.$disconnect(); cleanup(); });

test("new runs can exceed the former step, failure and elapsed-time ceilings", async () => {
  const run = await startRun({ chatId: null, goal: "Keep working until the model finishes" });
  assert.equal(run.maxSteps, null);
  assert.equal(run.maxFailures, null);
  assert.equal(run.deadlineMs, null);
  assert.equal(await runStepCeiling(run.id), null);
  await db.agentRun.update({ where: { id: run.id }, data: { startedAt: new Date(Date.now() - 3_600_000) } });
  await db.agentStep.createMany({ data: Array.from({ length: 40 }, (_, i) => ({ runId: run.id, position: i + 1, kind: "tool", state: "failed", finishedAt: new Date() })) });
  assert.deepEqual(await checkRunAllowance(run.id), { allowed: true, reason: null });
  const next = await reserveRunStep({ runId: run.id, toolName: "searchKnowledge" });
  assert.equal(next.step?.position, 41);
  await cancelRun(run.id, "stopped-by-user");
  assert.deepEqual(await checkRunAllowance(run.id), { allowed: false, reason: "run-cancelled" });
});

test("historical budgets and explicit cost limits keep their recorded behavior", async () => {
  const run = await startRun({ chatId: null, goal: "Historical limits", budget: { maxSteps: 8, maxFailures: 2, deadlineMs: 120_000 } });
  assert.equal(await runStepCeiling(run.id), 8);
  await db.agentStep.createMany({ data: [1, 2].map(position => ({ runId: run.id, position, kind: "tool", state: "failed" })) });
  assert.equal((await checkRunAllowance(run.id)).reason, "failure-budget");
  const cost = await startRun({ chatId: null, goal: "Recorded cost", budget: { maxCostUsd: 1 } });
  await db.agentRun.update({ where: { id: cost.id }, data: { spentCostUsd: 1 } });
  assert.equal((await checkRunAllowance(cost.id)).reason, "cost-budget");
});
