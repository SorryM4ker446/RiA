import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { saveKnowledgeEntry } = await import("@/lib/knowledge/entries");
const { indexDocument, reindexDocument, deleteDocument } = await import("@/lib/documents/store");
const { getEventSource, recordWorkspaceEvent, pruneWorkspaceEvents } = await import("@/lib/activity/events");
const { reviewWindow } = await import("@/lib/activity/window");
const { previewWorkspaceReview } = await import("@/lib/activity/reviews");
const { createAccountBackup, readBackupManifest } = await import("@/lib/backups/archive");
const { openBackup, backupFile } = await import("@/lib/backups/files");
const { restoreAccountBackup } = await import("@/lib/backups/restore");
const { executeRegisteredTool, getToolDescriptor } = await import("@/tools/catalog");

const knowledgeRoute = await import("@/app/api/knowledge/[id]/route");
const previewRoute = await import("@/app/api/activity/review/route");
const sourceRoute = await import("@/app/api/activity/events/[id]/route");
const now = new Date("2026-10-05T12:00:00Z");
let cookie: string;
beforeEach(async () => {
  cookie = localAccessCookie(); globalThis.__riaRateLimitStore?.clear();
  await db.workspaceReview.deleteMany({}); await db.workspaceEvent.deleteMany({});
  await db.chat.deleteMany({}); await db.memory.deleteMany({});
  await db.knowledgeDocument.deleteMany({}); await db.modelRequest.deleteMany({}); await db.workspacePreference.deleteMany({});
  await db.workspaceActivityState.update({ where: { id: "local" }, data: { recordingStartedAt: new Date("2026-01-01"), completeSince: new Date("2026-01-01") } });
});
after(async () => { await db.$disconnect(); cleanup(); });
const request = (path: string, method = "GET", body?: unknown, authenticated = true) => new NextRequest(`http://localhost${path}`, {
  method, headers: { ...(authenticated ? { cookie } : {}), "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
/** A document whose import is on record at `at`, rather than at the moment the test ran. */
async function event(at: string, label = "Recorded document") {
  const { document } = await indexDocument({ filename: `${randomUUID()}.txt`, format: "txt", byteSize: 8, pages: [{ pageNumber: null, text: `${label} ${randomUUID()}` }] });
  await db.workspaceEvent.deleteMany({ where: { entityId: document.id } });
  await db.workspaceEvent.create({ data: { kind: "document.imported", entityId: document.id, label, occurredAt: new Date(at) } });
  return document;
}

test("local review boundaries follow calendar dates through DST and skipped midnight", () => {
  const spring = reviewWindow("daily", "Europe/London", new Date("2026-03-30T12:00:00Z"));
  const fall = reviewWindow("daily", "Europe/London", new Date("2026-10-26T12:00:00Z"));
  assert.equal((spring.endAt.getTime() - spring.startAt.getTime()) / 3_600_000, 23);
  assert.equal((fall.endAt.getTime() - fall.startAt.getTime()) / 3_600_000, 25);
  const week = reviewWindow("weekly", "Europe/London", new Date("2026-03-30T12:00:00Z"));
  assert.equal(week.startDate, "2026-03-23"); assert.equal(week.endDate, "2026-03-30");
  assert.equal((week.endAt.getTime() - week.startAt.getTime()) / 3_600_000, 167);
  const midnight = reviewWindow("daily", "America/Sao_Paulo", new Date("2018-11-05T12:00:00Z"));
  assert.equal(midnight.startAt.toISOString(), "2018-11-04T03:00:00.000Z");
});

test("document imports and changes record events while duplicate import and reindex do not", async () => {
  const input = { filename: "record.txt", format: "txt", byteSize: 8, pages: [{ pageNumber: null, text: "Original source text" }] };
  const first = await indexDocument(input);
  await indexDocument(input); await reindexDocument(first.document.id);
  await indexDocument({ ...input, pages: [{ pageNumber: null, text: "Changed source text" }] });
  assert.deepEqual((await db.workspaceEvent.findMany({ orderBy: [{ occurredAt: "asc" }, { id: "asc" }] })).map(event => event.kind), ["document.imported", "document.updated"]);
  await deleteDocument(first.document.id);
  assert.equal((await getEventSource((await db.workspaceEvent.findFirstOrThrow()).id))?.entity, null);
});

test("memory confirmation is transactional and repeated acceptance or assistant inference adds no confirmation", async () => {
  const candidate = await saveKnowledgeEntry({ key: "Preference", value: "Candidate", source: "assistant" });
  assert.equal(await db.workspaceEvent.count(), 0);
  const path = `/api/knowledge/${candidate.id}`, context = { params: Promise.resolve({ id: candidate.id }) };
  assert.equal((await knowledgeRoute.PATCH(request(path, "PATCH", { confirmed: true }), context)).status, 200);
  assert.equal((await knowledgeRoute.PATCH(request(path, "PATCH", { confirmed: true }), context)).status, 200);
  await saveKnowledgeEntry({ key: candidate.key, value: "Discarded inference", source: "assistant" });
  assert.equal(await db.workspaceEvent.count(), 1);
  assert.equal((await db.memory.findUniqueOrThrow({ where: { id: candidate.id } })).value, "Candidate");
});

test("review uses an inclusive start and exclusive end in the selected zone", async () => {
  await event("2026-10-03T15:59:59Z");
  const inside = await event("2026-10-03T16:00:00Z", "Boundary document");
  await event("2026-10-04T16:00:00Z");
  const review = await previewWorkspaceReview("daily", "Asia/Shanghai", new Date("2026-10-05T01:00:00Z"));
  assert.equal(review.facts.counts["document.imported"], 1);
  assert.equal(review.facts.complete, true);
  assert.equal(review.facts.sources[0].entityId, inside.id);
  const source = await getEventSource(review.facts.sources[0].id);
  assert.ok(source?.entity && "filename" in source.entity);
});

test("an event recorded for a to-do keeps its label and has nothing further to show", async () => {
  // To-dos were removed; their completions stay in the record as what was counted then.
  const recorded = await db.$transaction(tx => recordWorkspaceEvent(tx, { kind: "task.completed", entityId: "removed-to-do", label: "Finished before the change" }, new Date("2026-10-04T06:00:00Z")));
  const preview = await previewWorkspaceReview("daily", "UTC", now);
  assert.equal(preview.facts.counts["task.completed"], 1);
  const source = await getEventSource(recorded.id);
  assert.equal(source?.event.label, "Finished before the change"); assert.equal(source?.entity, null);
});

test("preexisting rows never manufacture events and partial coverage stays explicit", async () => {
  await indexDocument({ filename: "before.txt", format: "txt", byteSize: 8, pages: [{ pageNumber: null, text: "Imported before recording began" }] });
  await db.workspaceEvent.deleteMany({});
  await db.workspaceActivityState.update({ where: { id: "local" }, data: { recordingStartedAt: new Date("2026-10-04T12:00:00Z"), completeSince: new Date("2026-10-04T12:00:00Z") } });
  const preview = await previewWorkspaceReview("daily", "UTC", now);
  assert.equal(preview.facts.complete, false); assert.equal(preview.facts.counts["document.imported"], 0);
  assert.equal(await db.modelRequest.count(), 0);
});

test("the model reads the same recorded activity through its tool, without writing anything", async () => {
  await event("2026-10-04T06:00:00Z", "Read by the tool");
  const tool = getToolDescriptor("readWorkspaceActivity")!;
  const { output } = await executeRegisteredTool(tool, { period: "weekly", timeZone: "UTC" }, { trigger: "auto" });
  const expected = await previewWorkspaceReview("weekly", "UTC");
  assert.deepEqual(JSON.parse(JSON.stringify(output)), JSON.parse(JSON.stringify(expected)));
  assert.equal(await db.workspaceReview.count(), 0); assert.equal(await db.chat.count(), 0);
  // A person cannot pick it, and a template with no tools does not get it.
  assert.equal(tool.surface.user, null); assert.equal(tool.surface.underlying, "model");
  await assert.rejects(executeRegisteredTool(tool, { period: "monthly", timeZone: "UTC" }, { trigger: "auto" }));
});

test("portable events retain identity and map source rows without creating restoration activity", async () => {
  const document = await event("2026-10-04T06:00:00Z"); const original = await db.workspaceEvent.findFirstOrThrow();
  const backup = await createAccountBackup(); await restoreAccountBackup(backup.id); await restoreAccountBackup(backup.id);
  assert.equal(await db.workspaceEvent.count(), 1);
  const restored = await db.workspaceEvent.findUniqueOrThrow({ where: { id: original.id } });
  assert.notEqual(restored.entityId, document.id); assert.ok((await getEventSource(restored.id))?.entity);
});

test("an old archive without activity restores empty coverage from restoration time", async () => {
  await event("2026-10-04T06:00:00Z");
  const backup = await createAccountBackup(); const file = await openBackup(backup.id);
  const manifest = (await readBackupManifest(file)).manifest as unknown as Record<string, unknown>; await file.close();
  delete manifest.events; delete manifest.activityCoverage; delete manifest.reviews;
  // Archives from before the activity feature also predate the RiA rename.
  manifest.format = "private-ai-account-backup";
  const json = Buffer.from(JSON.stringify(manifest)); const header = Buffer.alloc(44);
  header.write("PAIB0001"); header.writeUInt32BE(json.length, 8); createHash("sha256").update(json).digest().copy(header, 12);
  const oldId = randomUUID(); await writeFile(await backupFile(oldId), Buffer.concat([header, json]));
  const before = new Date(); await restoreAccountBackup(oldId);
  assert.equal(await db.workspaceEvent.count(), 0);
  assert.ok((await db.workspaceActivityState.findUniqueOrThrow({ where: { id: "local" } })).recordingStartedAt >= before);
});

test("retention exposes incomplete coverage and source API enforces access including deleted sources", async () => {
  await db.workspaceEvent.createMany({ data: Array.from({ length: 10_002 }, (_, index) => ({ id: `bounded-${String(index).padStart(5, "0")}`, kind: "document.imported", entityId: "deleted-source", label: "Snapshot", occurredAt: new Date("2026-10-04T06:00:00Z") })) });
  await db.$transaction(tx => pruneWorkspaceEvents(tx, now)); assert.equal(await db.workspaceEvent.count(), 10_000);
  const preview = await previewWorkspaceReview("daily", "UTC", now); assert.equal(preview.facts.complete, false);
  assert.equal(preview.facts.counts["document.imported"], 10_000); assert.equal(preview.facts.omitted, 9900);
  const id = preview.facts.sources[0].id, path = `/api/activity/events/${id}`, context = { params: Promise.resolve({ id }) };
  assert.equal((await sourceRoute.GET(request(path, "GET", undefined, false), context)).status, 401);
  assert.equal((await (await sourceRoute.GET(request(path), context)).json()).data.entity, null);
  assert.equal((await previewRoute.GET(request("/api/activity/review?period=daily&timeZone=Invalid"))).status, 400);
  assert.equal((await previewRoute.GET(request("/api/activity/review?period=daily&period=weekly&timeZone=UTC"))).status, 400);
  assert.equal((await previewRoute.GET(request("/api/activity/review?period=daily&timeZone=UTC&asOf=2026-01-01"))).status, 400);
  assert.equal((await previewRoute.GET(request("/api/activity/review?period=daily&timeZone=UTC", "GET", undefined, false))).status, 401);
});
