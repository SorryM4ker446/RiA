import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { createTestDatabase } from "../helpers/database";

const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";
// The repository lib target predates Promise.withResolvers, but the Node
// runtime that executes these tests provides it.
const withResolvers = <T>() => (Promise as unknown as {
  withResolvers: <U>() => { promise: Promise<U>; resolve: (value: U) => void; reject: (reason?: unknown) => void };
}).withResolvers<T>();
const { db } = await import("@/db");
const { saveMemory } = await import("@/lib/memory/store");
after(async () => { await db.$disconnect(); cleanup(); });

test("concurrent memory writes and transactions queue beyond the SQLite lock timeout", { timeout: 45_000 }, async () => {
  const [busyTimeout] = await db.$queryRawUnsafe<Array<{ timeout: number }>>("PRAGMA busy_timeout");
  assert.equal(Number(busyTimeout.timeout), 5_000);

  // The holder and the queued request both write to rows of this workspace.
  const queuedTask = await db.task.create({ data: { title: "Queue target" } });
  const queuedTaskId = queuedTask.id;
  await db.task.create({ data: { title: "Lock holder" } });

  const locked = withResolvers<void>();
  const release = withResolvers<void>();
  const holder = db.$transaction(async (tx) => {
    await tx.task.updateMany({ data: { details: "Held transaction" } });
    locked.resolve();
    await release.promise;
  }, { maxWait: 15_000, timeout: 20_000 });
  void holder.catch(locked.reject);
  let writes = Promise.resolve([]);
  let unlockTimer;
  try {
    await locked.promise;
    writes = Promise.allSettled([
      ...Array.from({ length: 8 }, (_, index) => saveMemory({ key: "queued preference", value: `value ${index}`, score: 0.9,
      })),
      db.$transaction((tx) => tx.task.update({ where: { id: queuedTaskId }, data: { details: "Queued transaction" } })),
    ]);
    // Hold a real write lock longer than SQLite's five-second busy timeout.
    // With one connection, pending requests wait in the pool, not on this lock.
    unlockTimer = setTimeout(release.resolve, 6_500);
    const results = await writes;
    await holder;
    for (const result of results) if (result.status === "rejected") throw result.reason;
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: queuedTaskId } })).details, "Queued transaction");
    assert.equal(await db.memory.count({ where: { key: "queued preference" } }), 1);
    const updated = await saveMemory({ key: "queued preference", value: "Queue recovered" });
    assert.equal(updated.value, "Queue recovered");
    assert.equal(updated.score, 0.9);
  } finally {
    clearTimeout(unlockTimer);
    release.resolve();
    // Always drain outstanding operations before another test or database cleanup.
    await Promise.allSettled([holder, writes]);
  }
});

test("an external SQLite writer still times out and later writes recover", { timeout: 30_000 }, async () => {

  const external = new DatabaseSync(process.env.DATABASE_URL.slice(5));
  try {
    external.exec("BEGIN IMMEDIATE");
    try {
      await assert.rejects(saveMemory({ key: "external lock", value: "Must not be saved" }), (error: any) => error.code === "P1008");
    } finally {
      external.exec("ROLLBACK");
    }
  } finally {
    external.close();
  }
  assert.equal(await db.memory.count({ where: { key: "external lock" } }), 0);
  await saveMemory({ key: "external lock", value: "Saved after unlock" });
  assert.equal(await db.memory.count({ where: { key: "external lock" } }), 1);
});
