import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { wordTableDocument, wordDocument, wordMergedDocument } from "../helpers/document-fixtures";
import { seedTestModelPreferences } from "../helpers/model-library";
import { fixtureLibraryItem } from "../helpers/model-fixture";
import { providerState, resetProviderState } from "../helpers/model-provider";

const cleanup = createTestDatabase(); process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const { parseDocument } = await import("@/lib/documents/parser");
const { buildDocumentChunks } = await import("@/lib/documents/chunks");
const { tableCells } = await import("@/lib/documents/table-blocks");
const { indexDocument, reindexDocument } = await import("@/lib/documents/store");
const { searchDocuments } = await import("@/lib/documents/retrieval");
const { semanticCoverage, indexDocumentEmbeddings } = await import("@/lib/documents/semantic");
const { maintainDocumentIndexes } = await import("@/features/knowledge/index-maintenance");
const { DocumentRequestError } = await import("@/features/knowledge/document-client");
const { serializeWordDocument } = await import("@/lib/documents/word-structure");
const preview = await import("@/app/api/documents/preview/route"); const routes = await import("@/app/api/documents/route");
let cookie: string; const modelRef = { providerId: "openrouter", modelId: "openai/text-embedding-3-small" } as const;
beforeEach(async () => {
  cookie = localAccessCookie(); resetProviderState(); globalThis.__privateAiRateLimitStore?.clear();
  await db.knowledgeDocument.deleteMany({}); await db.workspacePreference.deleteMany({});
  const prefs = await seedTestModelPreferences(db); prefs.embedding = modelRef;
  prefs.library = [...prefs.library, { ...fixtureLibraryItem(modelRef.modelId, ["embedding"]), providerId: "openrouter" }];
  await db.workspacePreference.update({ where: { id: "local" }, data: { settings: prefs } }); process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
});
after(async () => { await db.$disconnect(); cleanup(); });
async function upload(bytes: Uint8Array, filename: string, fields: Record<string, string> = {}, auth = cookie) {
  const form = new FormData(); form.append("file", new File([Uint8Array.from(bytes)], filename));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const encoded = new Response(form);
  return new NextRequest("http://localhost/api/documents", { method: "POST", headers: { cookie: auth, "content-type": encoded.headers.get("content-type")! }, body: await encoded.arrayBuffer() });
}
async function document(text: string, filename = "表格.md") {
  return (await indexDocument({ filename, collection: "财务", format: "md", byteSize: Buffer.byteLength(text), pages: [{ pageNumber: null, text }] })).document;
}

test("real Word tables retain headings, amounts and prerequisites without rendering document HTML", async () => {
  const pages = await parseDocument(await wordTableDocument(), "docx");
  assert.match(pages[0].text, /# 费用标准/u); assert.match(pages[0].text, /\| 项目 \| 金额 \| 条件 \|/u);
  assert.match(pages[0].text, /\| 住宿 \| 500 元 \| 主管审批 \|/u);
  assert.match(pages[0].text, /\| 交通 \| 200 元 \| 保留票据 \|/u);
  const doc = await document(pages[0].text);
  const hits = await searchDocuments("住宿金额审批");
  assert.ok(hits.some(hit => hit.documentId === doc.id && hit.snippet.includes("500 元") && hit.snippet.includes("主管审批") && hit.snippet.includes("金额")));
  const raw = await parseDocument(await wordTableDocument([["<script>alert(1)</script>", "A|B"]], false), "docx");
  assert.match(raw[0].text, /\| 列 1 \| 列 2 \|/u); assert.match(raw[0].text, /A\\\|B/u);
  const merged = (await parseDocument(await wordMergedDocument(), "docx"))[0].text;
  assert.match(merged, /1\. 先保留票据/u); assert.match(merged, /主管审批（合并 2 行\/2 列）/u);
  const rows = merged.split("\n").filter(line => line.includes("合并")); assert.equal(rows.length, 2);
  assert.ok(rows[0].endsWith("500 元 |") && rows[1].endsWith("200 元 |"));
  const literalTable = (await parseDocument(await wordTableDocument([["项目", "金额", "条件"], ...Array.from({ length: 60 }, (_, i) => ["`项目" + i, "500 元", "主管审批"])]), "docx"))[0].text;
  const literalChunks = buildDocumentChunks([{ pageNumber: null, text: literalTable }]).filter(chunk => chunk.text.includes("500 元"));
  assert.ok(literalChunks.length > 1); assert.ok(literalChunks.every(chunk => chunk.text.startsWith("| 项目 | 金额 | 条件 |")));
});

test("table chunks keep complete rows and repeated headers while ordinary chunks retain identities", async () => {
  const table = "# 限额\n\n| 项目 | 金额 | 条件 |\n| --- | --- | --- |\n" + Array.from({ length: 60 }, (_, i) => `| 项目${i} | ${i + 10} 元 | 主管审批${i} |`).join("\n");
  const chunks = buildDocumentChunks([{ pageNumber: null, text: table }]);
  const tables = chunks.filter(chunk => chunk.text.startsWith("| 项目 |")); assert.ok(tables.length > 1);
  assert.ok(tables.every(chunk => chunk.text.length <= 1000 && chunk.text.includes("| --- | --- | --- |")));
  for (let i = 0; i < 60; i++) assert.equal(tables.filter(chunk => chunk.text.includes(`| 项目${i} | ${i + 10} 元 | 主管审批${i} |`)).length, 1);
  const old = await document("普通段落的身份应保持。\n\n" + table); const before = await db.documentChunk.findFirst({ where: { documentId: old.id, text: "普通段落的身份应保持。" } });
  await document("普通段落的身份应保持。\n\n" + table.replace("主管审批59", "财务审批59"));
  assert.equal((await db.documentChunk.findFirst({ where: { documentId: old.id, text: "普通段落的身份应保持。" } })).id, before.id);
});

test("merged cells are explicitly marked, unmarked first rows are data and oversized tables fail before replacement", async () => {
  const paragraph = value => ({ type: "paragraph", children: [{ type: "text", value }] });
  const node = { type: "document", children: [{ type: "table", children: [
    { type: "tableRow", children: [{ type: "tableCell", colSpan: 2, rowSpan: 2, children: [paragraph("共享条件")] }, { type: "tableCell", children: [paragraph("500")] }] },
    { type: "tableRow", children: [{ type: "tableCell", children: [paragraph("200")] }] },
  ] }] };
  const text = serializeWordDocument(node, 100_000); assert.match(text, /合并 2 行\/2 列/u); assert.match(text, /列 3/u); assert.ok(text.includes("500") && text.includes("200"));
  const doc = await document("保留原先的有效版本。");
  await assert.rejects(document(`| 项目 | 条件 |\n| --- | --- |\n| 住宿 | ${"说明".repeat(600)} |`), /1000/u);
  assert.equal((await db.knowledgeDocument.findUnique({ where: { id: doc.id } })).contentHash, doc.contentHash);
  assert.throws(() => serializeWordDocument({ type: "document", children: [{ type: "table", children: [{ type: "tableRow", children: [{ type: "tableCell", colSpan: 10000000, children: [] }] }] }] }, 100_000), { code: "PAYLOAD_TOO_LARGE" });
});

test("table recognition preserves escaped delimiters, inline code, surrounding prose and fenced code", () => {
  const text = "前置条件。\n| 项目 | 条件 |\n| --- | --- |\n| A\\|B | `x|y` |\n后置例外。\n\n```md\n| code | sample |\n| --- | --- |\n| 1 | 2 |\n```";
  const chunks = buildDocumentChunks([{ pageNumber: 1, text }]);
  assert.ok(chunks.some(chunk => chunk.text.includes("A\\|B") && chunk.text.includes("`x|y`")));
  assert.ok(chunks.some(chunk => chunk.text === "前置条件。")); assert.ok(chunks.some(chunk => chunk.text === "后置例外。"));
  assert.ok(chunks.some(chunk => chunk.text.includes("```md") && chunk.text.includes("| code | sample |")));
  const singleColumn = buildDocumentChunks([{ pageNumber: null, text: "| 条件 |\n| --- |\n" + Array.from({ length: 80 }, (_, i) => `| 主管审批${i}，财务复核 |`).join("\n") }]);
  assert.ok(singleColumn.length > 1); assert.ok(singleColumn.every(chunk => chunk.text.startsWith("| 条件 |\n| --- |")));
});

test("fenced heading examples cannot change the section attributed to later evidence", async () => {
  const text = "# 真实费用章节\n\n```md\n# 示例中的其他章节\n| 示例 | 数值 |\n| --- | --- |\n| 演示 | 1 |\n```\n\n| 项目 | 金额 | 条件 |\n| --- | --- | --- |\n| 住宿 | 500 元 | 主管审批 |";
  const chunks = buildDocumentChunks([{ pageNumber: null, text }]);
  const evidence = chunks.find(chunk => chunk.text.includes("| 住宿 |"));
  assert.equal(evidence.heading, "真实费用章节");
  const saved = await document(text);
  const results = await searchDocuments("住宿金额审批");
  assert.ok(results.some(source => source.snippet.includes("500 元") && source.heading === "真实费用章节"));
  const table = await db.documentChunk.findFirst({ where: { documentId: saved.id, text: { contains: "| 住宿 |" } } });
  // Reproduce an already saved index from before the heading correction.
  await db.documentChunk.update({ where: { id: table.id }, data: { heading: "示例中的其他章节" } });
  await indexDocumentEmbeddings(saved.id, saved.contentHash, modelRef);
  assert.ok((await db.documentChunk.findUnique({ where: { id: table.id } })).embedding);
  await reindexDocument(saved.id);
  const repaired = await db.documentChunk.findUnique({ where: { id: table.id } });
  assert.equal(repaired.heading, "真实费用章节"); assert.equal(repaired.embedding, null);
  assert.equal((await db.knowledgeDocument.findUnique({ where: { id: saved.id } })).contentHash, saved.contentHash);
});

test("escaped trailing backslashes cannot hide table delimiters or detach rows from their headers", () => {
  const path = String.raw`C:\\`;
  assert.deepEqual(tableCells(`| 住宿 | ${path}|`), ["住宿", path]);
  assert.deepEqual(tableCells(String.raw`| 住宿 | A\|B |`), ["住宿", String.raw`A\|B`]);
  const text = "| 项目 | 路径 |\n| --- | --- |\n" + Array.from({ length: 80 }, (_, i) => `| 住宿${i} | ${path}|`).join("\n");
  const chunks = buildDocumentChunks([{ pageNumber: null, text }]);
  assert.ok(chunks.length > 1); assert.ok(chunks.every(chunk => chunk.text.startsWith("| 项目 | 路径 |\n| --- | --- |")));
  for (let i = 0; i < 80; i++) assert.equal(chunks.filter(chunk => chunk.text.includes(`| 住宿${i} | ${path}|`)).length, 1);
});

test("preview confirmation detects content changes and collection moves even when the ID stays the same", async () => {
  const bytes = Buffer.from("原先有效段落。"); await document("原先有效段落。", "手册.txt");
  const original = (await (await preview.POST(await upload(bytes, "手册.txt"))).json()).data;
  await document("另一请求更新了内容。", "手册.txt");
  assert.equal((await routes.POST(await upload(bytes, "手册.txt", { previewHash: original.previewHash, base: JSON.stringify(original.base) }))).status, 409);
  const changed = (await (await preview.POST(await upload(bytes, "手册.txt"))).json()).data;
  await db.knowledgeDocument.update({ where: { id: changed.base.id }, data: { collection: "人事" } });
  assert.equal((await routes.POST(await upload(bytes, "手册.txt", { previewHash: changed.previewHash, base: JSON.stringify(changed.base) }))).status, 409);
  const preserved = await db.knowledgeDocument.findUnique({ where: { id: changed.base.id } });
  assert.equal(preserved.collection, "人事"); assert.equal(preserved.contentHash, changed.base.contentHash);
});

test("preview is authenticated, local-only and read-only; saving checks content and concurrent creation", async () => {
  const bytes = await wordTableDocument();
  assert.equal((await preview.POST(await upload(bytes, "标准.docx", {}, ""))).status, 401);
  const response = await preview.POST(await upload(bytes, "标准.docx")); assert.equal(response.status, 200);
  const value = (await response.json()).data; assert.equal(value.base, null); assert.match(value.chunks.map(chunk => chunk.text).join("\n"), /500 元/u);
  assert.equal(await db.knowledgeDocument.count(), 0); assert.equal(providerState.embeddingCalls.length, 0);
  const mismatch = await routes.POST(await upload(await wordDocument("变了"), "标准.docx", { previewHash: value.previewHash, base: "null" })); assert.equal(mismatch.status, 409);
  await document("另一请求创建的版本。", "标准.docx");
  assert.equal((await routes.POST(await upload(bytes, "标准.docx", { previewHash: value.previewHash, base: "null" }))).status, 409);
});

test("preview confirmation rejects changed or deleted/recreated documents but unchanged retry is idempotent", async () => {
  const bytes = Buffer.from("原先有效段落。");
  const value = (await (await preview.POST(await upload(bytes, "手册.txt"))).json()).data;
  const first = await routes.POST(await upload(bytes, "手册.txt", { previewHash: value.previewHash, base: "null" })); assert.equal(first.status, 201);
  const current = (await (await preview.POST(await upload(bytes, "手册.txt"))).json()).data;
  assert.equal((await routes.POST(await upload(bytes, "手册.txt", { previewHash: current.previewHash, base: JSON.stringify(current.base) }))).status, 200);
  await db.knowledgeDocument.deleteMany({}); await document("原先有效段落。", "手册.txt");
  assert.equal((await routes.POST(await upload(bytes, "手册.txt", { previewHash: current.previewHash, base: JSON.stringify(current.base) }))).status, 409);
});

test("index summaries derive fresh, stale, malformed and different-model vectors from stored content", async () => {
  const doc = await document("第一段报销规定。\n\n第二段报销规定。\n\n第三段报销规定。\n\n第四段报销规定。");
  await indexDocumentEmbeddings(doc.id, doc.contentHash, modelRef);
  const rows = await db.documentChunk.findMany({ where: { documentId: doc.id }, orderBy: { ordinal: "asc" } });
  await db.documentChunk.update({ where: { id: rows[0].id }, data: { embeddingContextHash: "stale" } });
  await db.documentChunk.update({ where: { id: rows[1].id }, data: { embedding: [0, 0, 0] } });
  await db.documentChunk.update({ where: { id: rows[2].id }, data: { embeddingModelId: "old/model" } });
  const stats = await semanticCoverage([doc.id]); assert.equal(stats.counts.get(doc.id), 1);
  assert.deepEqual(stats.details.get(doc.id), { stale: 1, invalid: 1, differentModel: 1 });
  const previousCalls = providerState.embeddingCalls.length;
  await indexDocumentEmbeddings(doc.id, doc.contentHash, modelRef);
  assert.equal((await semanticCoverage([doc.id])).counts.get(doc.id), 4);
  assert.equal(providerState.embeddingCalls.slice(previousCalls).flat().length, 3);
});

test("batch maintenance resumes real persisted batches and never charges completed documents", async () => {
  const doc = await document(Array.from({ length: 40 }, (_, index) => `报销条件${index}。`).join("\n\n"));
  const summary = { ...doc, indexedAt: doc.indexedAt.toISOString(), semantic: { indexed: 0, total: 40, modelRef, lexicalCurrent: true } };
  const progress = [];
  let batches = 0;
  const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
    batches++; const input = JSON.parse(String(init.body)); return await indexDocumentEmbeddings(doc.id, input.contentHash, input.modelRef, init.signal as AbortSignal) as T;
  };
  const result = await maintainDocumentIndexes([summary], new AbortController().signal, items => progress.push(items), request);
  assert.equal(result[0].status, "complete"); assert.equal(result[0].indexed, 40); assert.equal(batches, 2); assert.equal(providerState.embeddingCalls.flat().length, 40);
  assert.ok(progress.some(items => items[0].indexed === 32));
  await maintainDocumentIndexes([{ ...summary, semantic: { ...summary.semantic, indexed: 40 } }], new AbortController().signal, () => {}, request);
  assert.equal(batches, 2); assert.equal(providerState.embeddingCalls.flat().length, 40);
});

test("maintenance cancellation and quota pauses stop further work and preserve saved progress", async () => {
  const doc = await document(Array.from({ length: 40 }, (_, index) => `保存片段${index}。`).join("\n\n"));
  const summary = { ...doc, indexedAt: doc.indexedAt.toISOString(), semantic: { indexed: 0, total: 40, modelRef, lexicalCurrent: true } };
  const controller = new AbortController(); let calls = 0;
  const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
    calls++; const input = JSON.parse(String(init.body)); const result = await indexDocumentEmbeddings(doc.id, input.contentHash, input.modelRef); return result as T;
  };
  const result = await maintainDocumentIndexes([summary], controller.signal, items => { if (items[0].indexed === 32 && items[0].status === "indexing") controller.abort(); }, request);
  assert.equal(calls, 1); assert.equal(result[0].status, "cancelled"); assert.equal((await semanticCoverage([doc.id])).counts.get(doc.id), 32);
  let limitedCalls = 0;
  const stopped = await maintainDocumentIndexes([summary, { ...summary, id: "another" }], new AbortController().signal, () => {}, async () => { limitedCalls++; throw new DocumentRequestError("本分钟已达到限额。", 429, "60"); });
  assert.equal(limitedCalls, 1); assert.equal(stopped[0].status, "paused"); assert.match(stopped[0].error, /60/u); assert.equal(stopped[1].status, "waiting");
});

test("maintenance isolates document failures, stops stale work and enforces its request ceiling", async () => {
  const doc = await document("索引测试。"); const summary = { ...doc, indexedAt: doc.indexedAt.toISOString(), semantic: { indexed: 0, total: 1, modelRef, lexicalCurrent: true } };
  let calls = 0;
  const targets = Array.from({ length: 16 }, (_, index) => ({ ...summary, id: `document-${index}` }));
  const result = await maintainDocumentIndexes(targets, new AbortController().signal, () => {}, async <T>() => { calls++; if (calls === 1) throw new Error("上游不可用"); return { indexed: 1, total: 1, remaining: 0 } as T; });
  assert.equal(calls, 12); assert.equal(result[0].status, "failed"); assert.equal(result[11].status, "complete"); assert.equal(result[12].status, "paused");
  calls = 0;
  const stale = await maintainDocumentIndexes(targets, new AbortController().signal, () => {}, async () => { calls++; throw new DocumentRequestError("文档已改变。", 409, null); });
  assert.equal(calls, 1); assert.equal(stale[0].status, "failed"); assert.equal(stale[1].status, "waiting");
  await db.knowledgeDocument.update({ where: { id: doc.id }, data: { indexVersion: 2 } });
  await reindexDocument(doc.id); assert.equal((await db.knowledgeDocument.findUnique({ where: { id: doc.id } })).indexVersion, 3);
});
