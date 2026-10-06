import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { DatabaseSync } from "node:sqlite";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const jobs = await import("@/lib/scheduler/jobs");
const { runDueScheduledJob, retryScheduledJob } = await import("@/lib/scheduler/runner");
const { listScheduledRuns, exportExecutionDiagnostics, pruneScheduledHistory } = await import("@/lib/scheduler/history");
const retryRoute = await import("@/app/api/schedules/[id]/retry/route");
const historyRoute = await import("@/app/api/schedules/runs/route");
const diagnosticRoute = await import("@/app/api/diagnostics/route");
const { exclusiveDataOperation } = await import("@/lib/server/data-operations");
const { createAccountBackup, readBackupManifest } = await import("@/lib/backups/archive");
const { openBackup } = await import("@/lib/backups/files");
const { restoreAccountBackup } = await import("@/lib/backups/restore");
let cookie: string;
beforeEach(async () => {
  cookie = localAccessCookie();
  globalThis.__privateAiRateLimitStore?.clear();
  await db.workspaceReview.deleteMany({});
  await db.workspaceEvent.deleteMany({});
  await db.$executeRawUnsafe("DROP TRIGGER IF EXISTS reject_period_review");
  await db.$executeRawUnsafe("CREATE TRIGGER reject_period_review BEFORE INSERT ON workspace_reviews BEGIN SELECT RAISE(ABORT, 'fixture-persistence-failure'); END");
  await db.scheduledRun.deleteMany({});
  await db.scheduledJob.deleteMany({});
  await db.agentRun.deleteMany({});
  await db.chat.deleteMany({});
  await db.appNotice.deleteMany({});
  await db.workspacePreference.deleteMany({});
});
after(async () => { await db.$disconnect(); cleanup(); });
async function due(kind: "dailyBrief" | "backupReminder" | "scheduledBackup" = "dailyBrief") {
  const job = await jobs.createScheduledJob({ kind, enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily" });
  await db.scheduledJob.update({ where: { id: job.id }, data: { nextRunAt: new Date(0) } });
  return job;
}
function request(path: string, method = "GET", body?: unknown, authenticated = true) {
  return new NextRequest(`http://localhost${path}`, { method, headers: { ...(authenticated ? { cookie } : {}), "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });

test("a failed schedule keeps an independent sanitized execution and a distinct retry identity", async () => {
  const job = await due();
  await runDueScheduledJob();
  const [first] = await listScheduledRuns();
  assert.equal(first.errorCode, "INTERNAL_ERROR");
  assert.equal(first.status, "failed");
  assert.ok(first.finishedAt);
  assert.equal(first.canRetry, true);
  const retry = await retryScheduledJob(job.id, first.id);
  const rows = await db.scheduledRun.findMany({ where: { jobId: job.id } });
  assert.equal(rows.length, 2);
  assert.equal(retry.runId, rows.find(row => row.retryOf === first.id)?.id);
  assert.equal(new Set(rows.map(row => row.requestId)).size, 2);
  assert.equal((await db.scheduledRun.findUniqueOrThrow({ where: { id: first.id } })).status, "failed");
  await assert.rejects(() => retryScheduledJob(job.id, first.id), { code: "CONFLICT" });
  assert.equal(await db.scheduledRun.count(), 2);
});

test("concurrent retries authorize exactly one new execution and recheck the current enabled state", async () => {
  const job = await due();
  await runDueScheduledJob();
  const [first] = await listScheduledRuns();
  await jobs.updateScheduledJob(job.id, { enabled: false });
  await assert.rejects(() => retryScheduledJob(job.id, first.id), { code: "CONFLICT" });
  await jobs.updateScheduledJob(job.id, { enabled: true });
  const results = await Promise.allSettled([retryScheduledJob(job.id, first.id), retryScheduledJob(job.id, first.id)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(await db.scheduledRun.count(), 2);
});

test("claims and execution evidence commit together and only one job runs across all schedules", async () => {
  await due("backupReminder");
  await due("backupReminder");
  const [claim] = await jobs.claimDueJobs();
  assert.ok(claim.runId);
  assert.equal(await db.scheduledRun.count({ where: { status: "running" } }), 1);
  assert.deepEqual(await jobs.claimDueJobs(), []);
  await jobs.deleteScheduledJob(claim.id);
  // Deleting a configuration does not release work already executing.
  assert.deepEqual(await jobs.claimDueJobs(), []);
  await jobs.completeJob(claim.id, { ok: true }, new Date(), claim.runId);
  assert.equal((await listScheduledRuns())[0].jobId, null);
  assert.equal((await jobs.claimDueJobs()).length, 1);
});

test("a history insertion failure rolls back the claim before any execution can happen", async () => {
  const job = await due("backupReminder");
  const sqlite = new DatabaseSync(process.env.DATABASE_URL!.slice(5));
  sqlite.exec("CREATE TRIGGER reject_execution BEFORE INSERT ON scheduled_runs BEGIN SELECT RAISE(ABORT, 'fixture-write-failure'); END;");
  try {
    await assert.rejects(() => jobs.claimDueJobs());
    assert.equal((await db.scheduledJob.findUniqueOrThrow({ where: { id: job.id } })).lastStatus, null);
    assert.equal(await db.scheduledRun.count(), 0);
    assert.equal(await db.appNotice.count(), 0);
  } finally { sqlite.exec("DROP TRIGGER reject_execution;"); sqlite.close(); }
});

test("success links to a real backup and cannot be retried or erased by notice dismissal", async () => {
  const job = await due("scheduledBackup");
  await runDueScheduledJob();
  const [run] = await listScheduledRuns();
  assert.equal(run.status, "succeeded");
  assert.ok(run.backupId);
  const file = await openBackup(run.backupId);
  try { assert.equal((await readBackupManifest(file)).manifest.version, 1); } finally { await file.close(); }
  await assert.rejects(() => retryScheduledJob(job.id, run.id), { code: "CONFLICT" });
  await db.appNotice.deleteMany({});
  await jobs.deleteScheduledJob(job.id);
  assert.equal((await listScheduledRuns())[0].id, run.id);
});

test("restart recovery records interruption once and obsolete completion cannot overwrite it", async () => {
  await due("backupReminder");
  const [claim] = await jobs.claimDueJobs(new Date("2026-10-01T09:00:00Z"));
  const restart = new Date("2026-10-04T09:00:00Z");
  assert.equal(await jobs.releaseInterruptedJobs(restart), 1);
  const row = await db.scheduledJob.findUniqueOrThrow({ where: { id: claim.id } });
  assert.ok(row.nextRunAt > restart);
  await jobs.completeJob(claim.id, { ok: true }, restart, claim.runId);
  assert.equal((await listScheduledRuns())[0].status, "interrupted");
  assert.equal((await listScheduledRuns())[0].canRetry, false);
  assert.equal((await db.scheduledJob.findUniqueOrThrow({ where: { id: claim.id } })).lastStatus, "interrupted");
  assert.equal(await jobs.releaseInterruptedJobs(restart), 0);
});

test("restore deferral claims no execution and retry endpoints enforce local access and request contracts", async () => {
  const job = await due();
  await exclusiveDataOperation(async () => { assert.equal(await runDueScheduledJob(), null); });
  assert.equal(await db.scheduledRun.count(), 0);
  await runDueScheduledJob();
  const [run] = await listScheduledRuns();
  const path = `/api/schedules/${job.id}/retry`;
  assert.equal((await retryRoute.POST(request(path, "POST", { runId: run.id }, false), context(job.id))).status, 401);
  assert.equal((await retryRoute.POST(request(path, "POST", { runId: run.id, extra: true }), context(job.id))).status, 400);
  assert.equal((await retryRoute.POST(request(path, "POST", { runId: run.id }), context(job.id))).status, 201);
  assert.equal((await retryRoute.POST(request(path, "POST", { runId: run.id }), context(job.id))).status, 409);
  const response = await historyRoute.GET(request("/api/schedules/runs"));
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.equal((await response.json()).data.length, 2);
});

test("diagnostics exclude all free text, secrets and paths even in malicious error fields", async () => {
  const secret = "sentinel-private-secret-C:\\private\\folder";
  await db.scheduledRun.create({ data: { kind: secret, trigger: secret, requestId: secret, errorCode: secret, status: secret } });
  await db.agentRun.create({ data: { goal: secret, status: secret, stopReason: secret, steps: { create: { kind: secret, toolName: secret, position: 1, input: { secret }, output: { secret }, errorCode: secret, state: secret } } } });
  const exported = JSON.stringify(await exportExecutionDiagnostics());
  assert.ok(!exported.includes(secret));
  assert.ok(!exported.includes("private\\\\folder"));
  assert.equal((await diagnosticRoute.GET(request("/api/diagnostics", "GET", undefined, false))).status, 401);
  const response = await diagnosticRoute.GET(request("/api/diagnostics"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition") ?? "", /attachment/);
  assert.equal((await response.json()).format, "ria-execution-diagnostics");
});

test("history retention is bounded by age and count without deleting active work", async () => {
  const now = new Date();
  await db.scheduledRun.createMany({ data: Array.from({ length: 1003 }, (_, index) => ({
    id: `history-${String(index).padStart(4, "0")}`, kind: "backupReminder", requestId: `request-${index}`,
    status: "succeeded", startedAt: now, finishedAt: now,
  })) });
  await db.scheduledRun.createMany({ data: [
    { kind: "backupReminder", requestId: "old", status: "failed", startedAt: new Date(0), finishedAt: new Date(1) },
    { kind: "backupReminder", requestId: "active", status: "running", startedAt: new Date(0) },
  ] });
  await db.$transaction(tx => pruneScheduledHistory(tx, now));
  assert.equal(await db.scheduledRun.count({ where: { status: { not: "running" } } }), 1000);
  assert.equal(await db.scheduledRun.count({ where: { status: "running" } }), 1);
  assert.equal(await db.scheduledRun.count({ where: { requestId: "old" } }), 0);
});

test("portable restore preserves local evidence, clears obsolete conversation links and pauses retry permission", async () => {
  const job = await due();
  const chat = await db.chat.create({ data: { title: "Local artifact" } });
  const run = await db.scheduledRun.create({ data: { jobId: job.id, chatId: chat.id, kind: job.kind, requestId: "local", status: "failed" } });
  const backup = await createAccountBackup();
  const file = await openBackup(backup.id);
  try { assert.ok(!("scheduledRuns" in (await readBackupManifest(file)).manifest)); } finally { await file.close(); }
  await restoreAccountBackup(backup.id);
  const retained = await db.scheduledRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(retained.chatId, null);
  assert.equal((await db.scheduledJob.findUniqueOrThrow({ where: { id: job.id } })).enabled, false);
  assert.equal((await listScheduledRuns())[0].canRetry, false);
});
