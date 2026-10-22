import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import JSZip from "jszip";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { textPdf, wordTableDocument, wordDocument } from "../helpers/document-fixtures";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { exportDocument, processUpload, loadProcessorDocument } = await import("@/lib/document-processor/service");
const { documentDownload } = await import("@/lib/document-processor/schema");
const { parseDocument } = await import("@/lib/documents/parser");
const { indexDocument } = await import("@/lib/documents/store");
const { createChatToolSet, executeRegisteredTool, resolveToolDescriptor } = await import("@/tools/catalog");
const { startRun } = await import("@/lib/agent/runs");
const parseRoute = await import("@/app/api/document-processor/parse/route");
const exportRoute = await import("@/app/api/document-processor/export/route");
const sourceRoute = await import("@/app/api/document-processor/source/[id]/route");
const downloadRoute = await import("@/app/api/documents/[id]/export/route");
let cookie: string;
beforeEach(async (t: TestContext) => {
  for (const method of ["info", "warn", "error"] as const) t.mock.method(console, method, () => {});
  globalThis.__riaRateLimitStore?.clear(); cookie = localAccessCookie();
  await db.knowledgeDocument.deleteMany({}); await db.agentRun.deleteMany({});
});
after(async () => { await db.$disconnect(); cleanup(); });
const request = (url: string, body?: unknown, headers: Record<string, string> = {}) => new NextRequest(`http://localhost${url}`, { method: body === undefined ? "GET" : "POST", headers: { cookie, ...(body === undefined || body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const sample = "# 费用标准\n\n**住宿**上限为 500 元，日期 2026-10-17。\n\n| 项目 | 金额 | 条件 |\n| --- | --- | --- |\n| 住宿 | 500 元 | 主管审批 |\n| 交通 | 200 元 | 保留票据 |\n\n3. 第一项\n4. 第二项\n\n```c\nif (a < b && b > 0) return 1;\n```\n\n[政策](https://example.invalid/policy)\n\n![图示](https://example.invalid/private.png)\n\n<script>alert('untrusted')</script>";
const output = (format: "md" | "txt" | "html" | "docx", content = sample, syntax: "markdown" | "plain" = "markdown") => exportDocument({ filename: "费用标准.md", content, syntax, format });
async function seed(collection = "财务") { return indexDocument({ filename: `标准-${collection}.md`, format: "md", byteSize: 100, collection, pages: [{ pageNumber: null, text: sample }] }); }

test("PDF, Word, Markdown and TXT parsing is local and never imports documents or calls a model", async () => {
  for (const [format, bytes] of [["pdf", textPdf("Invoice amount is 500 USD.")], ["docx", await wordTableDocument()], ["md", Buffer.from(sample)], ["txt", Buffer.from("中文纯文本，金额 500 元。")]] as const) {
    const form = new FormData(); form.set("file", new File([new Uint8Array(bytes)], `sample.${format}`));
    const response = await parseRoute.POST(request("/api/document-processor/parse", form));
    assert.equal(response.status, 200, await response.clone().text());
    const { data } = await response.json(); assert.equal(data.format, format); assert.ok(data.characterCount > 0);
    assert.equal(data.pages[0].pageNumber, format === "pdf" ? 1 : null);
    assert.equal(data.syntax, ["md", "docx"].includes(format) ? "markdown" : "plain");
  }
  assert.equal(await db.knowledgeDocument.count(), 0); assert.equal(await db.modelRequest.count(), 0);
});

test("all export formats retain text, numbers and code while Word preserves headings, lists and table structure", async () => {
  assert.equal(Buffer.from((await output("md")).bytes).toString(), sample);
  const text = Buffer.from((await output("txt")).bytes).toString();
  for (const value of ["费用标准", "500 元", "2026-10-17", "住宿\t500 元\t主管审批", "交通\t200 元\t保留票据", "3. 第一项", "if (a < b && b > 0) return 1;", "<script>alert('untrusted')</script>"]) assert.ok(text.includes(value), value);
  const file = await output("docx"), zip = await JSZip.loadAsync(file.bytes);
  const xml = await zip.file("word/document.xml")!.async("string");
  assert.match(xml, /w:pStyle w:val="Heading1"/); assert.equal((xml.match(/<w:tr>/g) ?? []).length, 3); assert.match(xml, /<w:tblHeader\/>/);
  assert.match(await zip.file("word/numbering.xml")!.async("string"), /<w:start w:val="3"/);
  assert.match(xml, /<w:b\/>/); assert.match(xml, /&lt;script&gt;/); assert.equal(zip.file("word/media/private.png"), null);
  assert.equal(Object.keys(zip.files).some(name => name.endsWith("vbaProject.bin")), false);
  const extracted = (await parseDocument(file.bytes, "docx"))[0].text;
  for (const value of ["# 费用标准", "500 元", "2026-10-17", "| 住宿 | 500 元 | 主管审批 |", "第一项", "if (a < b && b > 0) return 1;"]) assert.ok(extracted.includes(value), value);
});

test("HTML output treats raw markup as text and never embeds remote images, executable links or scripts", async () => {
  const file = await output("html", sample + '\n\n[bad](javascript:alert%281%29)\n\n<img src="https://foreign.invalid/tracker" onerror="alert(1)">');
  const html = Buffer.from(file.bytes).toString();
  assert.match(html, /<h1>费用标准<\/h1>/); assert.match(html, /<table>/); assert.match(html, /&lt;script&gt;/);
  assert.equal(/<script\b|<img\b|href="javascript:/i.test(html), false);
  assert.match(html, /Content-Security-Policy/); assert.match(html, /default-src &#39;none&#39;/);
  assert.match(html, /href="https:\/\/example.invalid\/policy"/);
});

test("plain text keeps literal Markdown and Word parsing escapes literal symbols before conversion", async () => {
  const literal = '# Not a heading\n*literal* | 500 元 <tag> & 中文 😀\nC:\\tools\\file';
  assert.equal(Buffer.from((await output("txt", literal, "plain")).bytes).toString(), literal);
  const exported = await output("docx", literal, "plain");
  const extracted = (await parseDocument(exported.bytes, "docx"))[0].text;
  assert.equal(extracted, literal);
  const source = await wordDocument("*literal* | 500 元 <tag> & 中文 😀");
  const processed = await processUpload({ filename: "literal.docx", format: "docx", file: new File([new Uint8Array(source)], "literal.docx") });
  const restored = await output("txt", processed.content, processed.syntax);
  assert.equal(Buffer.from(restored.bytes).toString(), "*literal* | 500 元 <tag> & 中文 😀");
});

test("malformed, binary, scanned and oversized uploads fail without creating knowledge rows", async () => {
  for (const [name, bytes, status] of [["bad.pdf", Buffer.from("not pdf"), 400], ["binary.txt", Buffer.from([0xff, 0xfe]), 400], ["empty.pdf", textPdf(""), 400], ["old.doc", Buffer.from("legacy"), 415], ["large.txt", Buffer.alloc(8 * 1024 * 1024 + 1, 65), 413]] as const) {
    const form = new FormData(); form.set("file", new File([new Uint8Array(bytes)], name));
    assert.equal((await parseRoute.POST(request("/api/document-processor/parse", form))).status, status, name);
  }
  assert.equal(await db.knowledgeDocument.count(), 0);
});

test("authentication, Origin, payload limits and unsupported fields protect processing and downloads", async () => {
  assert.equal((await exportRoute.POST(request("/api/document-processor/export", {}, { cookie: "" }))).status, 401);
  assert.equal((await parseRoute.POST(request("/api/document-processor/parse", {}, { cookie: "" }))).status, 401);
  assert.equal((await exportRoute.POST(request("/api/document-processor/export", {}, { origin: "https://foreign.invalid" }))).status, 403);
  assert.equal((await exportRoute.POST(request("/api/document-processor/export", { content: "x".repeat(1024 * 1024 + 1) }))).status, 413);
  assert.equal((await exportRoute.POST(request("/api/document-processor/export", { filename: "../private", content: "x", syntax: "plain", format: "docx" }))).status, 400);
  assert.equal((await exportRoute.POST(request("/api/document-processor/export", { filename: "x", content: "x", syntax: "plain", format: "pdf" }))).status, 400);
  assert.equal((await sourceRoute.GET(request("/api/document-processor/source/missing", undefined, { cookie: "" }), context("missing"))).status, 401);
  assert.equal((await downloadRoute.GET(request("/api/documents/missing/export", undefined, { cookie: "" }), context("missing"))).status, 401);
});

test("empty, invalid Unicode and excessive document structures cannot produce corrupt files", async () => {
  for (const content of [" ", "x\u0000", "\ud800", "x".repeat(100_001)]) await assert.rejects(() => output("docx", content));
  await assert.rejects(() => output("docx", "*a* ".repeat(10_000)), /结构过于复杂/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => exportDocument({ filename: "x", content: "Cancelled", syntax: "plain", format: "docx" }, controller.signal));
});

test("knowledge downloads preserve version identity, reject changed or deleted sources and encode Chinese filenames", async () => {
  const { document } = await seed();
  const input = await loadProcessorDocument(document.id);
  const url = `/api/documents/${document.id}/export?format=docx&version=${input.source.contentHash}`;
  const downloaded = await downloadRoute.GET(request(url), context(document.id));
  assert.equal(downloaded.status, 200); assert.match(downloaded.headers.get("Content-Disposition")!, /filename\*=UTF-8''%/);
  assert.equal(downloaded.headers.get("Cache-Control"), "private, no-store");
  assert.match(downloaded.headers.get("Content-Type")!, /wordprocessingml/);
  await db.knowledgeDocument.update({ where: { id: document.id }, data: { contentHash: "a".repeat(64) } });
  assert.equal((await downloadRoute.GET(request(url), context(document.id))).status, 409);
  await db.knowledgeDocument.delete({ where: { id: document.id } });
  assert.equal((await downloadRoute.GET(request(url), context(document.id))).status, 404);
});

test("document tools obey collection scope, assistant allowlists and run budgets and expose safe download links", async () => {
  const first = await seed("财务"), second = await seed("医疗");
  const tools = await createChatToolSet({ toolIds: ["readDocument", "convertDocument"], documentCollections: ["财务"] });
  const options = { toolCallId: "document-call", messages: [] };
  const excerpt = await tools.readDocument.execute!({ documentId: first.document.id, offset: 0, limit: 12 }, options) as any;
  assert.equal(excerpt.text.length, 12); assert.equal(excerpt.nextOffset, 12);
  await assert.rejects(() => tools.readDocument.execute!({ documentId: second.document.id }, options), /知识集合/);
  await assert.rejects(() => tools.convertDocument.execute!({ documentId: second.document.id, format: "docx" }, options), /知识集合/);
  const file = await tools.convertDocument.execute!({ documentId: first.document.id, format: "docx" }, options);
  assert.ok(documentDownload(file)); assert.equal(documentDownload({ ...file as object, downloadUrl: "https://foreign.invalid/private" }), null);
  assert.equal((await createChatToolSet({ toolIds: [] })).convertDocument, undefined);
  const run = await startRun({ chatId: null, goal: "Read a document", budget: { maxSteps: 1 } });
  const descriptor = (await resolveToolDescriptor("readDocument"))!;
  await executeRegisteredTool(descriptor, { documentId: first.document.id }, { runId: run.id, trigger: "auto" });
  const refused = await executeRegisteredTool(descriptor, { documentId: first.document.id }, { runId: run.id, trigger: "auto" });
  assert.equal((refused.output as any).skipped, "budget"); assert.equal(await db.agentStep.count({ where: { runId: run.id } }), 1);
});

test("exports and layout previews share a bounded quota without changing source documents", async () => {
  for (let index = 0; index < 20; index++) assert.equal((await exportRoute.POST(request("/api/document-processor/export", { filename: "x", content: "Safe", syntax: "plain", format: "txt" }))).status, 200);
  const limited = await exportRoute.POST(request("/api/document-processor/export", { filename: "x", content: "Safe", syntax: "plain", format: "txt" }));
  assert.equal(limited.status, 429); assert.ok(limited.headers.get("Retry-After")); assert.equal(await db.knowledgeDocument.count(), 0);
});
