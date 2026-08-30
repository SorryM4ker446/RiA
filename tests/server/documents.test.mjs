import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database.mjs";
import { textPdf, wordDocument } from "../helpers/document-fixtures.mjs";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { createSession } = await import("@/lib/auth/session");
const collection = await import("@/app/api/documents/route");
const detail = await import("@/app/api/documents/[id]/route");
const search = await import("@/app/api/documents/search/route");
const { parseDocument, validateDocumentFile } = await import("@/lib/documents/parser");
const { indexDocument } = await import("@/lib/documents/store");
const { searchDocuments } = await import("@/lib/documents/retrieval");
let user, cookie, otherCookie;
const context = id => ({ params: Promise.resolve({ id }) });
const request = (method = "GET", session = cookie, body) => new NextRequest("http://localhost/api/documents", { method, headers: { cookie: session, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
async function upload(name, content, session = cookie) {
  const form = new FormData();
  form.append("file", new File([content], name));
  const encoded = new Response(form);
  return collection.POST(new NextRequest("http://localhost/api/documents", { method: "POST", headers: { cookie: session, "content-type": encoded.headers.get("content-type") }, body: await encoded.arrayBuffer() }));
}
async function data(response, status = 200) { assert.equal(response.status, status, await response.clone().text()); return (await response.json()).data; }
beforeEach(async () => {
  user = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  const other = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  cookie = `app_session=${await createSession(user.id)}`;
  otherCookie = `app_session=${await createSession(other.id)}`;
});
after(async () => { await db.$disconnect(); cleanup(); });

test("PDF, DOCX, Markdown and text import actual extracted content with page references", async () => {
  for (const [filename, bytes, expected, page] of [
    ["support.pdf", textPdf(), "Aurora support hours", 1],
    ["发布.docx", await wordDocument(), "回滚窗口", null],
    ["手册.md", "# 部署\n\n北极星部署需要双人审批。", "双人审批", null],
    ["notes.txt", "Backup recovery requires the database and media directory.", "Backup recovery", null],
  ]) {
    const result = await data(await upload(filename, bytes), 201);
    const stored = await data(await detail.GET(request(), context(result.document.id)));
    assert.equal(stored.filename, filename);
    assert.match(stored.chunks.map(chunk => chunk.text).join("\n"), new RegExp(expected));
    assert.equal(stored.chunks[0].pageNumber, page);
    assert.ok(await db.documentTerm.count({ where: { chunk: { documentId: stored.id } } }));
  }
  assert.equal((await data(await collection.GET(request()))).length, 4);
});

test("incremental updates retain unchanged chunk IDs, retries deduplicate, reindex repairs terms and deletion cascades", async () => {
  const original = await data(await upload("runbook.txt", "蓝鲸发布需要审批。\n\n蓝鲸备份保留七天。"), 201);
  const old = await data(await detail.GET(request(), context(original.document.id)));
  const retry = await data(await upload("runbook.txt", "蓝鲸发布需要审批。\n\n蓝鲸备份保留七天。"));
  assert.equal(retry.change, "unchanged");
  assert.equal(retry.document.id, old.id);
  const updated = await data(await upload("runbook.txt", "蓝鲸发布需要审批。\n\n蓝鲸备份保留三十天。"));
  assert.deepEqual([updated.added, updated.retained, updated.removed], [1, 1, 1]);
  const next = await data(await detail.GET(request(), context(old.id)));
  assert.equal(next.chunks[0].id, old.chunks[0].id);
  assert.notEqual(next.chunks[1].id, old.chunks[1].id);
  await db.documentTerm.deleteMany({ where: { chunk: { documentId: old.id } } });
  assert.deepEqual(await searchDocuments(user.id, "蓝鲸备份"), []);
  const reindexed = await data(await detail.POST(request("POST"), context(old.id)));
  assert.equal(reindexed.change, "reindexed");
  const results = await data(await search.POST(request("POST", cookie, { query: "蓝鲸备份" })));
  assert.ok(results.some(result => result.snippet.includes("三十天")));
  await data(await detail.DELETE(request("DELETE"), context(old.id)));
  assert.equal(await db.documentChunk.count({ where: { documentId: old.id } }), 0);
  assert.equal(await db.documentTerm.count({ where: { chunkId: { in: next.chunks.map(chunk => chunk.id) } } }), 0);
  assert.deepEqual(await searchDocuments(user.id, "蓝鲸"), []);
});

test("document APIs require authentication and isolate list, text, search, reindex and delete by owner", async () => {
  assert.equal((await upload("a.txt", "private", "")).status, 401);
  assert.equal((await collection.GET(request("GET", ""))).status, 401);
  assert.equal((await search.POST(request("POST", "", { query: "private" }))).status, 401);
  const { document } = await data(await upload("private.txt", "猎户座内部发行口令使用测试占位符。"), 201);
  assert.deepEqual(await data(await collection.GET(request("GET", otherCookie))), []);
  for (const method of ["GET", "POST", "DELETE"]) {
    assert.equal((await detail[method](request(method, ""), context(document.id))).status, 401);
    const response = await detail[method](request(method, otherCookie), context(document.id));
    assert.equal(response.status, 404);
  }
  assert.deepEqual(await data(await search.POST(request("POST", otherCookie, { query: "猎户座" }))), []);
  await db.session.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(0) } });
  assert.equal((await detail.GET(request(), context(document.id))).status, 401);
});

test("invalid content, size, compressed expansion and unexpected requests cannot replace a working index", async () => {
  const { document } = await data(await upload("guide.pdf", textPdf("Preserve the working index.")), 201);
  assert.equal((await upload("guide.pdf", "%PDF-broken")).status, 400);
  assert.equal((await upload("old.doc", "old word")).status, 415);
  assert.equal((await upload("binary.txt", Buffer.from([255, 0]))).status, 400);
  assert.equal((await upload("large.txt", Buffer.alloc(8 * 1024 * 1024 + 1))).status, 413);
  const bomb = await wordDocument("hello", { "word/extra.xml": "a".repeat(13 * 1024 * 1024) });
  assert.equal((await upload("expanded.docx", bomb)).status, 413);
  assert.match((await data(await detail.GET(request(), context(document.id)))).chunks[0].text, /Preserve/);
  const freshCookie = otherCookie;
  assert.equal((await collection.POST(request("POST", freshCookie, { file: "x" }))).status, 415);
  assert.equal((await search.POST(request("POST", freshCookie, { query: "x", extra: true }))).status, 400);
  assert.equal((await detail.POST(request("POST", freshCookie, { unexpected: true }), context(document.id))).status, 400);
  const form = new FormData(); form.append("file", new File(["hello"], "notes.txt")); form.append("extra", "x");
  const encoded = new Response(form);
  assert.equal((await collection.POST(new NextRequest("http://localhost/api/documents", { method: "POST", headers: { cookie: freshCookie, "content-type": encoded.headers.get("content-type") }, body: await encoded.arrayBuffer() }))).status, 400);
});

test("ingestion rate limits return Retry-After without modifying documents", async () => {
  for (let i = 0; i < 6; i++) await data(await upload("same.txt", "Limited import"), i ? 200 : 201);
  const response = await upload("new.txt", "Not stored");
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) > 0);
  assert.equal(await db.knowledgeDocument.count({ where: { userId: user.id } }), 1);
});

test("parser timeout and cancellation release concurrency capacity", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = parseDocument(textPdf(), "pdf");
  t.mock.timers.tick(15_001);
  await assert.rejects(pending, error => error.code === "TIMEOUT");
  t.mock.timers.reset();
  await assert.rejects(parseDocument(Buffer.from("hello"), "txt", AbortSignal.abort()), /取消/);
  assert.equal((await parseDocument(Buffer.from("recovered"), "txt"))[0].text, "recovered");
});

test("failed indexing and stale reindex keep previous document and its index atomic", async () => {
  const { document } = await data(await upload("atomic.txt", "月球基地补给每周二抵达。"), 201);
  const original = await db.knowledgeDocument.findUnique({ where: { id: document.id } });
  await assert.rejects(indexDocument(user.id, { ...original, pages: [{ pageNumber: null, text: "a\n\n".repeat(300) }] }), error => error.code === "PAYLOAD_TOO_LARGE");
  await assert.rejects(indexDocument(user.id, { ...original, pages: original.pages }, { id: original.id, contentHash: "stale" }), error => error.code === "CONFLICT");
  assert.equal((await db.knowledgeDocument.findUnique({ where: { id: document.id } })).contentHash, original.contentHash);
  assert.ok((await searchDocuments(user.id, "月球基地补给")).length);
});

test("a database failure during term insertion rolls back the text, chunks and previous search index", async t => {
  t.mock.method(console, "error", () => {});
  const { document } = await data(await upload("rollback.txt", "火星仓库每周四开放。"), 201);
  const original = await db.knowledgeDocument.findUnique({ where: { id: document.id } });
  const chunks = await db.documentChunk.findMany({ where: { documentId: document.id } });
  await db.$executeRawUnsafe("CREATE TRIGGER document_test_failure BEFORE INSERT ON document_terms WHEN NEW.term = 'tripwire' BEGIN SELECT RAISE(ABORT, 'Synthetic index failure'); END");
  try {
    await assert.rejects(indexDocument(user.id, { ...original, pages: [{ pageNumber: null, text: "tripwire" }] }));
  } finally { await db.$executeRawUnsafe("DROP TRIGGER document_test_failure"); }
  assert.equal((await db.knowledgeDocument.findUnique({ where: { id: document.id } })).contentHash, original.contentHash);
  assert.deepEqual(await db.documentChunk.findMany({ where: { documentId: document.id } }), chunks);
  assert.match((await searchDocuments(user.id, "火星仓库"))[0].snippet, /每周四/);
});

test("parser concurrency rejects excess work and all workers settle before capacity is reused", async () => {
  const operations = [parseDocument(textPdf(), "pdf"), parseDocument(textPdf(), "pdf"), parseDocument(Buffer.from("excess"), "txt")];
  const settled = await Promise.allSettled(operations);
  assert.equal(settled[0].status, "fulfilled");
  assert.equal(settled[1].status, "fulfilled");
  assert.equal(settled[2].status, "rejected");
  assert.equal(settled[2].reason.code, "SERVICE_UNAVAILABLE");
  assert.equal((await parseDocument(Buffer.from("after"), "txt"))[0].text, "after");
});

test("document count cap is enforced transactionally while updates and other users remain available", async () => {
  await db.knowledgeDocument.createMany({ data: Array.from({ length: 99 }, (_, index) => ({ userId: user.id, filename: `quota-${index}.txt`, format: "txt", byteSize: 4, contentHash: "old", pages: [{ pageNumber: null, text: "seed" }], characterCount: 4, indexVersion: 1 })) });
  const settled = await Promise.allSettled(["last-a.txt", "last-b.txt"].map(filename => indexDocument(user.id, { filename, format: "txt", byteSize: 4, pages: [{ pageNumber: null, text: "last" }] })));
  assert.equal(settled.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(settled.find(result => result.status === "rejected").reason.code, "CONFLICT");
  assert.equal(await db.knowledgeDocument.count({ where: { userId: user.id } }), 100);
  assert.equal((await upload("overflow.txt", "rejected")).status, 409);
  assert.equal((await upload("quota-0.txt", "updated in place")).status, 200);
  assert.equal((await upload("other.txt", "another user", otherCookie)).status, 201);
});

test("empty, image-only and binary documents fail clearly, and path-like filenames are rejected", async () => {
  assert.throws(() => validateDocumentFile(new File(["hello"], "../notes.txt")), error => error.code === "VALIDATION_ERROR");
  assert.throws(() => validateDocumentFile(new File([], "empty.txt")), error => error.code === "VALIDATION_ERROR");
  await assert.rejects(parseDocument(textPdf(""), "pdf"), /没有可检索的文本/);
  await assert.rejects(parseDocument(Buffer.from([0, 1, 2]), "txt"), /二进制内容/);
  await assert.rejects(parseDocument(Buffer.from("x".repeat(100_001)), "txt"), error => error.code === "PAYLOAD_TOO_LARGE");
});
