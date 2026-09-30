import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";

const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const { indexDocument } = await import("@/lib/documents/store");
const { startRun } = await import("@/lib/agent/runs");
const { createChatToolSet } = await import("@/tools/catalog");
const { RATE_LIMIT_POLICIES } = await import("@/lib/server/rate-limit");

let cookie: string;
const req = (path: string, method = "POST", body?: unknown) => new NextRequest(`http://localhost${path}`, {
  method,
  headers: { cookie, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  globalThis.__privateAiRateLimitStore.clear();
  cookie = localAccessCookie();
  await db.knowledgeDocument.deleteMany({});
  await db.documentChunk.deleteMany({});
  await db.agentStep.deleteMany({});
  await db.agentRun.deleteMany({});
  await db.task.deleteMany({});
});
after(async () => { await db.$disconnect(); cleanup(); });

test("a memory search is metered, because it embeds the query", async () => {
  const route = await import("@/app/api/retrieval/route");
  const limit = RATE_LIMIT_POLICIES.memory.limit;

  for (let index = 0; index < limit; index += 1) {
    const allowed = await route.POST(req("/api/retrieval", "POST", { query: "notes" }));
    assert.equal(allowed.status, 200, `call ${index + 1} should be inside the quota`);
  }

  const refused = await route.POST(req("/api/retrieval", "POST", { query: "notes" }));
  assert.equal(refused.status, 429);
  // The reindex beside this route was already metered while this one, which
  // reaches a provider on every call, was not.
  assert.ok(RATE_LIMIT_POLICIES.memoryReindex.limit < limit);
});

test("writing a memory is metered on the same quota", async () => {
  const route = await import("@/app/api/memory/route");
  for (let index = 0; index < RATE_LIMIT_POLICIES.memory.limit; index += 1) {
    const allowed = await route.POST(req("/api/memory", "POST", { key: `k-${index}`, value: "v" }));
    assert.equal(allowed.ok, true, `call ${index + 1} should be inside the quota: ${await allowed.clone().text()}`);
  }
  const refused = await route.POST(req("/api/memory", "POST", { key: "one-too-many", value: "v" }));
  assert.equal(refused.status, 429);
});

test("re-importing unchanged content into another collection actually moves it", async () => {
  const pages = [{ pageNumber: 1, text: "The quarterly figures are in the appendix." }];
  const first = await indexDocument({ filename: "report.md", collection: "work", format: "md", byteSize: 40, pages });
  assert.equal(first.change, "created");

  // Same bytes, same document: the expensive re-chunking is skipped.
  const same = await indexDocument({ filename: "report.md", collection: "work", format: "md", byteSize: 40, pages });
  assert.equal(same.change, "unchanged");

  // Same bytes, different collection. The shortcut used to answer "unchanged"
  // here too and leave the document in the old collection, so the move was
  // dropped while the request reported success.
  const moved = await indexDocument({ filename: "report.md", collection: "archive", format: "md", byteSize: 40, pages });
  const stored = await db.knowledgeDocument.findFirst({ where: { filename: "report.md" }, select: { collection: true } });
  assert.equal(stored?.collection, "archive");
  assert.ok(moved.document.id, "the document is still returned to the caller");
  assert.equal(await db.knowledgeDocument.count(), 1, "moving a document does not duplicate it");
});

test("a second tool set for one run does not collide on the step position", async () => {
  const run = await startRun({ chatId: null, goal: "two tool sets" });
  const first = await createChatToolSet({ toolIds: ["createTask"], runId: run.id });
  await first.createTask.execute({ title: "from the first set" }, {} as never);

  const second = await createChatToolSet({ toolIds: ["createTask"], runId: run.id });
  await second.createTask.execute({ title: "from the second set" }, {} as never);

  // Positions are unique per run. The second set used to restart its counter at
  // 1, and the write that collided was swallowed — so a run that did two
  // pieces of work recorded one of them nowhere.
  const steps = await db.agentStep.findMany({ where: { runId: run.id }, orderBy: { position: "asc" } });
  assert.equal(steps.length, 2);
  assert.deepEqual(steps.map(step => step.position), [1, 2]);
  assert.equal(steps.every(step => step.state === "done"), true);
});

test("a binary document is refused rather than read as replacement characters", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { resolveWithinGrant, resolveGrant } = await import("@/lib/local-files/safe-path");
  const { createGrant } = await import("@/lib/local-files/grants");

  const root = mkdtempSync(join(tmpdir(), "ria-readable-"));
  writeFileSync(join(root, "notes.md"), "# notes");
  writeFileSync(join(root, "notes.txt"), "plain");
  // A real PDF header, so the refusal cannot be mistaken for a missing file.
  writeFileSync(join(root, "report.pdf"), Buffer.from("%PDF-1.7\nbinary"));
  writeFileSync(join(root, "report.docx"), Buffer.from("PKbinary"));

  const grant = await createGrant({ path: root });
  const resolved = await resolveGrant({ label: "test", path: root });
  const boundary = { ...grant, realPath: resolved.realPath };

  for (const name of ["notes.md", "notes.txt"]) {
    assert.equal((await resolveWithinGrant(boundary, name, "read")).relativePath, name);
  }
  // The reader decodes bytes as UTF-8 and has no extractor for these, so a PDF
  // used to come back as a successful read full of replacement characters.
  for (const name of ["report.pdf", "report.docx"]) {
    await assert.rejects(
      () => resolveWithinGrant(boundary, name, "read"),
      (error: { reason?: string }) => error.reason === "unsupported-format",
    );
  }
});
