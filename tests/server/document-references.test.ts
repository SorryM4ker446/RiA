import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { indexDocument, reindexDocument, deleteDocument } = await import("@/lib/documents/store");
const { searchDocuments } = await import("@/lib/documents/retrieval");
const { checkDocumentReferences } = await import("@/lib/documents/references");
const { documentSourceUrl, documentSourceSchema } = await import("@/lib/documents/types");
const { encodePersistedAssistantToolMessage, decodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
const { createAccountBackup } = await import("@/lib/backups/archive");
const { restoreAccountBackup } = await import("@/lib/backups/restore");
const route = await import("@/app/api/documents/references/route");
const searchRoute = await import("@/app/api/documents/search/route");
beforeEach(async () => { await db.chat.deleteMany({}); await db.workspaceReview.deleteMany({}); await db.workspaceEvent.deleteMany({}); await db.knowledgeDocument.deleteMany({}); globalThis.__privateAiRateLimitStore?.clear(); });
after(async () => { await db.$disconnect(); cleanup(); });
const upload = (text: string, collection = "Manual|操作") => indexDocument({ filename: "Operations.txt", format: "txt", byteSize: Buffer.byteLength(text), collection, pages: [{ pageNumber: null, text }] });
const request = (path: string, body: unknown, auth = true) => new NextRequest(`http://localhost${path}`, { method: "POST", headers: { ...(auth ? { cookie: localAccessCookie() } : {}), "Content-Type": "application/json" }, body: JSON.stringify(body) });
test("unchanged chunks still report a changed document version and a reindex alone remains current", async () => {
  await upload("Deployment requires two approvals.\n\nRollback deadline is twenty minutes.");
  const source = documentSourceSchema.parse((await searchDocuments("two approvals"))[0]);
  assert.equal((await checkDocumentReferences([source]))[0].status, "current");
  await reindexDocument(source.documentId); assert.equal((await checkDocumentReferences([source]))[0].status, "current");
  await upload("Deployment requires two approvals.\n\nRollback deadline is ten minutes.");
  assert.ok(await db.documentChunk.findUnique({ where: { id: source.chunkId } }));
  assert.equal((await checkDocumentReferences([source]))[0].status, "changed");
  assert.equal(source.snippet, "Deployment requires two approvals.");
  assert.match(documentSourceUrl(source), /\?version=[a-f0-9]{64}#/);
  await deleteDocument(source.documentId); assert.equal((await checkDocumentReferences([source]))[0].status, "deleted");
  await upload("Deployment requires two approvals."); assert.equal((await checkDocumentReferences([source]))[0].status, "deleted");
});
test("legacy sources are unverified and moving a collection invalidates its captured provenance", async () => {
  await upload("Aurora support hours are nine to six.");
  const source = documentSourceSchema.parse((await searchDocuments("Aurora support"))[0]);
  const { contentHash: _hash, ...old } = source;
  assert.equal((await checkDocumentReferences([old]))[0].status, "unverified");
  await upload(source.snippet, "Other"); assert.equal((await checkDocumentReferences([source]))[0].status, "changed");
});
test("reference checks and scoped retrieval require authorization and reject invalid or excessive input", async () => {
  await upload("Aurora support hours are nine to six."); const source = documentSourceSchema.parse((await searchDocuments("Aurora"))[0]);
  const path = "/api/documents/references";
  assert.equal((await route.POST(request(path, { sources: [source] }, false))).status, 401);
  for (const body of [{ sources: Array(9).fill(source) }, { sources: [{ ...source, contentHash: "invalid" }] }, { sources: [source], extra: true }]) assert.equal((await route.POST(request(path, body))).status, 400);
  const data = await (await route.POST(request(path, { sources: [source] }))).json(); assert.equal(data.data[0].status, "current");
  const scoped = await (await searchRoute.POST(request("/api/documents/search", { query: "Aurora", collections: ["Manual|操作"] }))).json(); assert.equal(scoped.data.length, 1);
  const excluded = await (await searchRoute.POST(request("/api/documents/search", { query: "Aurora", collections: ["Other"] }))).json(); assert.deepEqual(excluded.data, []);
  assert.equal(await db.modelRequest.count(), 0);
});
test("restoration remaps source identities and markdown links while preserving version and historical excerpts", async () => {
  const initial = await upload("Deployment requires two approvals.");
  await upload(`Deployment requires two approvals. See [self](/knowledge/documents/${initial.document.id}).`);
  const source = documentSourceSchema.parse((await searchDocuments("two approvals"))[0]);
  const chat = await db.chat.create({ data: { title: "Evidence" } });
  await db.message.createMany({ data: [
    { chatId: chat.id, role: "assistant", content: encodePersistedAssistantToolMessage({ type: "assistant-tool-message", text: `Read [Operations](${documentSourceUrl(source)})`, tools: [], documentSources: [source] }) },
    { chatId: chat.id, role: "assistant", content: `Read [Operations](${documentSourceUrl(source)})\nExternal [link](https://example.invalid${documentSourceUrl(source)})` },
  ] });
  const backup = await createAccountBackup(); await restoreAccountBackup(backup.id);
  const rows = await db.message.findMany(); const encoded = rows.map(row => decodePersistedAssistantToolMessage(row.content)).find(Boolean)!;
  const restored = encoded.documentSources![0]; assert.notEqual(restored.documentId, source.documentId); assert.notEqual(restored.chunkId, source.chunkId);
  assert.equal(restored.contentHash, source.contentHash); assert.equal(restored.snippet, source.snippet);
  assert.equal((await checkDocumentReferences([restored]))[0].status, "current");
  assert.ok(rows.every(row => row.content.includes(documentSourceUrl(restored))));
  assert.ok(rows.some(row => row.content.includes(`https://example.invalid${documentSourceUrl(source)}`)));
});
