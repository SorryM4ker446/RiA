import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { scannedPdf } from "../helpers/document-fixtures";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const collection = await import("@/app/api/documents/route");
const detail = await import("@/app/api/documents/[id]/route");
const retry = await import("@/app/api/documents/[id]/ocr/route");
const preview = await import("@/app/api/documents/preview/route");
const { parseDocumentForImport, parseDocument } = await import("@/lib/documents/parser");
const { cleanOcrText, documentOcrSettled, ocrSourcePath, resumeDocumentOcr, scheduleDocumentOcr, sourceDigest, withOcrText } = await import("@/lib/documents/ocr/runner");
const { indexDocument } = await import("@/lib/documents/store");
const { readImportedPages } = await import("@/lib/documents/import-pages");
const { searchDocuments } = await import("@/lib/documents/retrieval");
after(async () => { await db.$disconnect(); cleanup(); });

let cookie: string;
const context = (id: string) => ({ params: Promise.resolve({ id }) });
async function send(route: { POST: (request: NextRequest) => Promise<Response> }, name: string, content: Buffer) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(content)], name));
  const encoded = new Response(form);
  return route.POST(new NextRequest("http://localhost/api/documents", { method: "POST", headers: { cookie, "content-type": encoded.headers.get("content-type")! }, body: await encoded.arrayBuffer() }));
}
async function data(response: Response, status = 200) { assert.equal(response.status, status, await response.clone().text()); return (await response.json()).data; }
const list = async () => (await (await collection.GET(new NextRequest("http://localhost/api/documents", { headers: { cookie } }))).json()).data as Array<{ id: string; ocr?: { status: string; done: number; total: number; error: string | null } }>;

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {});
  cookie = localAccessCookie();
  globalThis.__riaRateLimitStore?.clear();
  await documentOcrSettled();
  await db.knowledgeDocument.deleteMany({});
  await db.documentOcr.deleteMany({});
});

const scanLines = ["Aurora warehouse opens on Thursdays.", "Deliveries need a signed approval form."];

test("scanned pages are found while parsing, and an all-scanned PDF imports only when OCR will follow", async () => {
  const mixed = await scannedPdf([{ text: "Policy overview for the warehouse team." }, scanLines]);
  const parsed = await parseDocumentForImport(mixed, "pdf");
  assert.deepEqual(parsed.ocrPages, [2]);
  assert.match(parsed.pages[0].text, /Policy overview/);
  assert.equal(parsed.pages[1].text, "");

  // A page with no text at all is read too, image or not: it may be text drawn as outlines.
  assert.deepEqual((await parseDocumentForImport(await scannedPdf([{ text: "Policy overview for the warehouse team." }, { text: "" }]), "pdf")).ocrPages, [2]);

  const scanned = await scannedPdf([scanLines]);
  await assert.rejects(parseDocument(scanned, "pdf"), /没有可检索的文本|no searchable text/i, "other callers still refuse a PDF with no text");
  assert.deepEqual((await parseDocumentForImport(scanned, "pdf", undefined, { allowTextless: true })).ocrPages, [1]);
});

test("an imported scan is searchable by its text pages at once and by its scanned pages once they are read", async () => {
  const bytes = await scannedPdf([{ text: "Policy overview for the warehouse team." }, scanLines]);
  const previewed = await data(await send(preview, "warehouse.pdf", bytes));
  assert.equal(previewed.ocrPages, 1);
  assert.ok(previewed.notes.some((note: string) => /1/.test(note) && /识别|read/.test(note)));

  const { document } = await data(await send(collection, "warehouse.pdf", bytes), 201);
  assert.ok(existsSync(ocrSourcePath(document.id)), "the PDF waits in the cache until its pages are read");
  assert.ok((await searchDocuments("policy overview warehouse")).length, "the text page is searchable straight away");
  await documentOcrSettled();

  const job = await db.documentOcr.findUniqueOrThrow({ where: { documentId: document.id } });
  assert.equal(job.status, "done", job.error ?? "");
  const saved = await db.knowledgeDocument.findUniqueOrThrow({ where: { id: document.id } });
  assert.notEqual(saved.contentHash, document.contentHash, "the read text is a new version of the document");
  assert.match(JSON.stringify(saved.pages), /Thursdays/);
  assert.ok((await searchDocuments("Thursdays deliveries approval")).some(source => /Thursdays/.test(source.snippet)));
  assert.equal(existsSync(ocrSourcePath(document.id)), false, "the kept PDF goes once its pages are in the document");
  assert.equal((await list()).find(row => row.id === document.id)?.ocr, undefined);

  // The same file imported again reuses the text already read: nothing changes and nothing is read twice.
  const again = await data(await send(collection, "warehouse.pdf", bytes));
  assert.equal(again.change, "unchanged");
  assert.equal(await db.documentOcr.count({ where: { NOT: { status: "done" } } }), 0);
});

test("deleting a document while its pages wait stops the reading and removes the kept PDF", async () => {
  const bytes = await scannedPdf([scanLines, scanLines, scanLines]);
  const { document } = await data(await send(collection, "scan.pdf", bytes), 201);
  await data(await detail.DELETE(new NextRequest("http://localhost/api/documents", { method: "DELETE", headers: { cookie } }), context(document.id)));
  await documentOcrSettled();
  assert.equal(await db.documentOcr.count(), 0);
  assert.equal(existsSync(ocrSourcePath(document.id)), false);
});

test("a reading that cannot finish says why, keeps what was read, and can be retried", async () => {
  const bytes = await scannedPdf([scanLines]);
  const document = await db.knowledgeDocument.create({ data: { filename: "lost.pdf", format: "pdf", byteSize: bytes.length, contentHash: "v1", pages: [{ pageNumber: 1, text: "" }], characterCount: 0, indexVersion: 4 } });
  await db.documentOcr.create({ data: { documentId: document.id, sourceHash: sourceDigest(bytes), contentHash: "v1", pages: [1], results: {} } });
  scheduleDocumentOcr();
  await documentOcrSettled();
  const failed = await db.documentOcr.findUniqueOrThrow({ where: { documentId: document.id } });
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /重新导入这个文件|import the file again/);
  assert.equal((await list()).find(row => row.id === document.id)?.ocr?.status, "failed");

  await mkdir(dirname(ocrSourcePath(document.id)), { recursive: true });
  writeFileSync(ocrSourcePath(document.id), bytes);
  await data(await retry.POST(new NextRequest("http://localhost/api/documents", { method: "POST", headers: { cookie } }), context(document.id)));
  await documentOcrSettled();
  assert.equal((await db.documentOcr.findUniqueOrThrow({ where: { documentId: document.id } })).status, "done");
  assert.ok((await searchDocuments("Aurora warehouse Thursdays")).length);
  assert.equal((await retry.POST(new NextRequest("http://localhost/api/documents", { method: "POST", headers: { cookie } }), context(document.id))).status, 409, "nothing left to retry");
});

test("kept PDFs without a job are removed when reading resumes, as after a restore", async () => {
  const stray = ocrSourcePath("stray-document");
  await mkdir(dirname(stray), { recursive: true });
  writeFileSync(stray, "left behind by a restore");
  await resumeDocumentOcr();
  await documentOcrSettled();
  assert.equal(existsSync(stray), false);
  assert.ok(readdirSync(dirname(stray)).every(name => !name.endsWith(".pdf")));
});

test("importing the same file again after a failed reading reads it again", async () => {
  const bytes = await scannedPdf([scanLines]);
  // The document as the first import saved it, and its reading failed with the kept PDF gone.
  const { pages, pending, sourceHash } = await readImportedPages(bytes, "pdf");
  const { document } = await indexDocument({ filename: "again.pdf", format: "pdf", byteSize: bytes.length, pages }, undefined, undefined, { textPending: true });
  await db.documentOcr.create({ data: { documentId: document.id, sourceHash: sourceHash!, contentHash: document.contentHash, pages: pending, results: {}, status: "failed", error: "The scanned PDF is no longer available" } });

  const again = await data(await send(collection, "again.pdf", bytes));
  assert.equal(again.change, "unchanged");
  await documentOcrSettled();
  assert.equal((await db.documentOcr.findUniqueOrThrow({ where: { documentId: document.id } })).status, "done");
  assert.ok((await searchDocuments("Aurora warehouse Thursdays")).length);
});

test("a scan with nothing to read says so, and a page where nothing was read keeps its own text", async () => {
  const { document } = await data(await send(collection, "blank.pdf", await scannedPdf([{ text: "" }])), 201);
  await documentOcrSettled();
  const job = await db.documentOcr.findUniqueOrThrow({ where: { documentId: document.id } });
  assert.equal(job.status, "failed");
  assert.match(job.error ?? "", /没有识别出文字|No text was found/);

  assert.deepEqual(withOcrText([{ pageNumber: 1, text: "Fig. 3" }, { pageNumber: 2, text: "" }], { 1: " \n", 2: "Read text" }), [{ pageNumber: 1, text: "Fig. 3" }, { pageNumber: 2, text: "Read text" }]);
});

test("spaces Tesseract puts between Chinese characters go, and the ones between words stay", () => {
  assert.equal(cleanOcrText("差 旅 住宿 标准 ， 需要 主管 审批 。\nInvoice approval  within 10 days.  \n\n\n\n下 一 页"), "差旅住宿标准，需要主管审批。\nInvoice approval  within 10 days.\n\n下一页");
  assert.equal(cleanOcrText("SQLite 的 WAL 模式"), "SQLite 的 WAL 模式", "a space between Chinese and Latin text stays");
});
