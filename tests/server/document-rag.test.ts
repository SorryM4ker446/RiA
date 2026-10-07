import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { readFileSync } from "node:fs";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { fixtureLibraryItem } from "../helpers/model-fixture";

const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const { providerState, resetProviderState } = await import("../helpers/model-provider");
const { defaultModelPreferences } = await import("@/lib/models/preferences-schema");
const { indexDocument, deleteDocument } = await import("@/lib/documents/store");
const { indexDocumentEmbeddings, semanticCoverage, validDocumentVector } = await import("@/lib/documents/semantic");
const { searchDocuments, documentRetrievalQuery, formatDocumentContext } = await import("@/lib/documents/retrieval");
const { markDocumentCitations } = await import("@/lib/documents/references");
const { documentSourceUrl } = await import("@/lib/documents/types");
const route = await import("@/app/api/documents/[id]/embeddings/route");
const { createAccountBackup, readBackupManifest } = await import("@/lib/backups/archive");
const { openBackup } = await import("@/lib/backups/files");
const { exclusiveDataOperation } = await import("@/lib/server/data-operations");
const { restoreAccountBackup } = await import("@/lib/backups/restore");
const modelRef = { providerId: "openrouter", modelId: "openai/text-embedding-3-small" } as const;
let cookie: string;
async function preference(modelId: string = modelRef.modelId) {
  const settings = defaultModelPreferences();
  settings.embedding = { ...modelRef, modelId };
  settings.library = [{ ...fixtureLibraryItem(modelId, ["embedding"]), providerId: "openrouter" }];
  await db.workspacePreference.upsert({ where: { id: "local" }, create: { id: "local", settings }, update: { settings } });
}
async function document(filename: string, text: string, collection = "工作") {
  return (await indexDocument({ filename, collection, format: "md", byteSize: Buffer.byteLength(text), pages: [{ pageNumber: null, text }] })).document;
}
beforeEach(async (t: TestContext) => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  resetProviderState();
  globalThis.__privateAiRateLimitStore?.clear();
  cookie = localAccessCookie();
  await db.knowledgeDocument.deleteMany({});
  await db.workspacePreference.deleteMany({});
  await preference();
  // Deliberately controlled semantic spaces. These prove retrieval mechanics,
  // not the quality of a live embedding model or a live generated answer.
  providerState.embeddingFunction = text => /公务出行|费用核销|出门办事|差旅/u.test(text) ? [1, 0, 0] : /医疗|医院/u.test(text) ? [0, 1, 0] : [0, 0, 1];
});
after(async () => { await db.$disconnect(); cleanup(); });

test("semantic retrieval finds indirect questions with no lexical matches and preserves exception evidence", async () => {
  const target = await document("差旅规程.md", "# 差旅规程\n\n公务出行的开支需要保留税务票据，回程后的十个工作日内提交费用核销申请。\n\n超过期限需要主管提供书面说明。\n\n遗失票据必须提供替代证明，不能直接申报。", "财务");
  await document("医疗服务.md", "医院接诊需要预约，非急诊的医疗服务开放时间为八点至十七点。", "医疗");
  const query = "出门办事的钱怎样领回来";
  assert.deepEqual(await searchDocuments(query), [], "lexical-only retrieval cannot answer this paraphrase");
  await indexDocumentEmbeddings(target.id, target.contentHash, modelRef);
  const sources = await searchDocuments(query, 8, ["财务"]);
  assert.equal(sources[0].retrieval, "semantic");
  assert.ok(sources.some(source => source.snippet.includes("十个工作日")));
  assert.ok(sources.some(source => source.snippet.includes("书面说明")));
  assert.ok(sources.every(source => source.collection === "财务" && source.contentHash === target.contentHash));
  assert.deepEqual(await searchDocuments(query, 8, ["医疗"]), []);
  assert.deepEqual(await searchDocuments("木星表面温度"), []);
  const context = formatDocumentContext(sources);
  assert.match(context, /applying and synthesizing/);
  assert.match(context, /prerequisites, exceptions, quantities and units/);
  assert.match(context, /evidence is insufficient/);
  assert.match(context, /十个工作日/);
});

test("semantic retrieval reaches older chunks across multiple bounded vector batches", async () => {
  const target = await document("差旅旧规程.md", "公务出行需要费用核销，时限为十个工作日。");
  const shortVector = providerState.embeddingFunction;
  providerState.embeddingFunction = text => [...shortVector!(text), ...new Array(1533).fill(0)];
  await indexDocumentEmbeddings(target.id, target.contentHash, modelRef);
  await db.documentChunk.updateMany({ where: { documentId: target.id }, data: { id: "zz-last-semantic-chunk" } });
  // More than two 64-row pages of compatible but semantically unrelated rows.
  const other = await document("医院.md", Array.from({ length: 150 }, (_, i) => `医院预约编号 ${i}：医疗服务须提前安排。`).join("\n\n"));
  while ((await indexDocumentEmbeddings(other.id, other.contentHash, modelRef)).remaining) {}
  const result = await searchDocuments("出门办事的钱怎样领回来", 3);
  assert.equal(result[0].documentId, target.id);
  assert.ok(result[0].snippet.includes("十个工作日"));
});

test("fixed paraphrase corpus measures lexical recall, hybrid recall, evidence coverage and irrelevant results", async t => {
  const corpus = JSON.parse(readFileSync(new URL("../fixtures/document-rag-evaluation.json", import.meta.url), "utf8"));
  providerState.embeddingFunction = text => {
    const category = corpus.cases.findIndex(item => text.includes(item.filename) || text.includes(item.question));
    return Array.from({ length: 5 }, (_, index) => index === (category < 0 ? 4 : category) ? 1 : 0);
  };
  const docs = [];
  for (const item of corpus.cases) docs.push(await document(item.filename, item.text, item.collection));
  let lexicalHits = 0;
  for (const item of corpus.cases) if ((await searchDocuments(item.question, 8)).some(source => source.filename === item.filename)) lexicalHits++;
  for (const doc of docs) await indexDocumentEmbeddings(doc.id, doc.contentHash, modelRef);
  let hybridHits = 0; let covered = 0; let facts = 0;
  for (const item of corpus.cases) {
    const sources = await searchDocuments(item.question, 8);
    assert.ok(sources.every(source => source.filename === item.filename), "irrelevant sources must not pollute the answer context");
    if (sources.some(source => source.filename === item.filename)) hybridHits++;
    const evidence = sources.map(source => source.snippet).join("\n");
    for (const fact of item.facts) { facts++; if (evidence.includes(fact)) covered++; }
    assert.deepEqual(await searchDocuments(item.question, 8, ["不存在的集合"]), []);
  }
  for (const query of corpus.unanswerable) assert.deepEqual(await searchDocuments(query), []);
  t.diagnostic(`Controlled paraphrase corpus: lexical Recall@8=${lexicalHits / docs.length}; hybrid Recall@8=${hybridHits / docs.length}; required evidence coverage=${covered / facts}; empty unrelated queries=${corpus.unanswerable.length}/${corpus.unanswerable.length}. Synthetic vectors, not live model quality.`);
  assert.ok(lexicalHits < docs.length);
  assert.equal(hybridHits, docs.length); assert.equal(covered, facts);
});

test("separate documents with conflicting quantities remain visible as distinct evidence", async () => {
  const prefix = "公务出行的费用核销需要保留税务票据并遵循审批流程，由部门主管审核费用清单及凭证，归档后通过线上平台提交。";
  const first = await document("规则一.md", `${prefix} 时限为十个工作日。`);
  const second = await document("规则二.md", `${prefix} 时限为二十个工作日。`);
  const sources = await searchDocuments("费用核销时限", 8);
  assert.ok(sources.some(source => source.documentId === first.id && source.snippet.includes("十个工作日")));
  assert.ok(sources.some(source => source.documentId === second.id && source.snippet.includes("二十个工作日")));
  assert.match(formatDocumentContext(sources), /Disclose conflicting evidence/);
});

test("heading changes preserve chunk identities but invalidate embeddings and respect unseparated sections", async () => {
  const { buildDocumentChunks } = await import("@/lib/documents/chunks");
  const chunks = buildDocumentChunks([{ pageNumber: null, text: "# 主章节\n正文。\n## 子章节\n子章节正文。\n# 新章节\n新章节正文。" }]);
  assert.deepEqual(chunks.map(chunk => chunk.heading), ["主章节", "主章节 / 子章节", "新章节"]);
  const target = await document("差旅规程.md", "# 审批\n\n公务出行需要费用核销。");
  await indexDocumentEmbeddings(target.id, target.contentHash, modelRef);
  const original = await db.documentChunk.findFirstOrThrow({ where: { documentId: target.id, ordinal: 1 } });
  await document("差旅规程.md", "# 报销\n\n公务出行需要费用核销。");
  const next = await db.documentChunk.findUniqueOrThrow({ where: { id: original.id } });
  assert.equal(next.heading, "报销"); assert.equal(next.embedding, null);
});

test("model changes, malformed vectors and mismatched dimensions cannot become semantic evidence", async () => {
  const target = await document("差旅规程.md", "公务出行需要费用核销。");
  await indexDocumentEmbeddings(target.id, target.contentHash, modelRef);
  await preference("openai/new-embedding-space");
  assert.equal((await semanticCoverage([target.id])).counts.get(target.id), undefined);
  assert.deepEqual(await searchDocuments("出门办事的钱怎样领回来"), []);
  await preference();
  await db.documentChunk.updateMany({ where: { documentId: target.id }, data: { embedding: [1, 0] } });
  assert.deepEqual(await searchDocuments("出门办事的钱怎样领回来"), []);
  for (const vector of [[], [0, 0], [1, NaN], [1, "bad"], new Array(4097).fill(1)]) assert.equal(validDocumentVector(vector), null);
});

test("editing document context invalidates vectors while unchanged imports retain them", async () => {
  const text = "# 差旅规程\n\n公务出行需要费用核销。";
  const target = await document("差旅规程.md", text, "财务");
  await indexDocumentEmbeddings(target.id, target.contentHash, modelRef);
  const calls = providerState.embeddingCalls.length;
  await document("差旅规程.md", text, "财务");
  await indexDocumentEmbeddings(target.id, target.contentHash, modelRef);
  assert.equal(providerState.embeddingCalls.length, calls, "unchanged chunks are not charged again");
  await document("差旅规程.md", text, "其他");
  assert.equal(await db.documentChunk.count({ where: { documentId: target.id, embedding: { not: Prisma.AnyNull } } }), 0);
  assert.deepEqual(await searchDocuments("出门办事的钱怎样领回来"), []);
});

test("obsolete and duplicate semantic indexing requests cannot commit over newer document state", async () => {
  const target = await document("差旅规程.md", "公务出行需要费用核销。");
  let release!: () => void;
  let entered!: () => void;
  providerState.embeddingGate = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { entered = resolve; });
  providerState.embeddingEntered = entered;
  const pending = indexDocumentEmbeddings(target.id, target.contentHash, modelRef);
  const checked = assert.rejects(pending, /文档已更新/);
  try {
    await observed;
    await assert.rejects(indexDocumentEmbeddings(target.id, target.contentHash, modelRef), /正在构建/);
    await document("差旅规程.md", "公务出行已经改为线上审批。");
  } finally { release(); }
  await checked;
  assert.equal(await db.documentChunk.count({ where: { embedding: { not: Prisma.AnyNull } } }), 0);
});

test("cancelled or failed embedding work leaves its batch unchanged and allows explicit recovery", async () => {
  const target = await document("差旅规程.md", "公务出行需要费用核销。");
  providerState.embeddingError = true;
  await assert.rejects(indexDocumentEmbeddings(target.id, target.contentHash, modelRef), /调用失败/);
  assert.equal(providerState.embeddingCalls.length, 1, "failed model requests are not automatically retried");
  providerState.embeddingError = false;
  let release!: () => void;
  let entered!: () => void;
  providerState.embeddingGate = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { entered = resolve; });
  providerState.embeddingEntered = entered;
  const controller = new AbortController();
  const pending = indexDocumentEmbeddings(target.id, target.contentHash, modelRef, controller.signal);
  const checked = assert.rejects(pending, { name: "AbortError" });
  await observed; controller.abort(); release(); await checked;
  assert.equal(await db.documentChunk.count({ where: { embedding: { not: Prisma.AnyNull } } }), 0);
  providerState.embeddingGate = undefined;
  assert.equal((await indexDocumentEmbeddings(target.id, target.contentHash, modelRef)).remaining, 0);
});

test("embedding API requires authentication, explicit confirmation and matching content/model identity", async () => {
  const target = await document("差旅规程.md", "公务出行需要费用核销。");
  const context = { params: Promise.resolve({ id: target.id }) };
  const request = (body, auth = cookie) => new NextRequest(`http://localhost/api/documents/${target.id}/embeddings`, { method: "POST", headers: { cookie: auth, "content-type": "application/json" }, body: JSON.stringify(body) });
  const input = { confirm: true, contentHash: target.contentHash, modelRef };
  assert.equal((await route.POST(request(input, ""), context)).status, 401);
  assert.equal((await route.POST(request({ ...input, confirm: false }), context)).status, 400);
  assert.equal((await route.POST(request({ ...input, contentHash: "0".repeat(64) }), context)).status, 409);
  assert.equal((await route.POST(request({ ...input, modelRef: { ...modelRef, modelId: "other" } }), context)).status, 409);
  assert.equal((await route.POST(request(input), context)).status, 200);
  assert.equal((await semanticCoverage([target.id])).counts.get(target.id), target._count.chunks);
  await deleteDocument(target.id);
  assert.equal(await db.documentChunk.count({ where: { documentId: target.id } }), 0);
});

test("follow-up retrieval uses prior user context without importing assistant speculation", () => {
  assert.equal(documentRetrievalQuery([{ role: "user", text: "星河项目的发布流程是什么" }, { role: "assistant", text: "invented secret topic" }, { role: "user", text: "那它需要多久？" }]), "星河项目的发布流程是什么\nFollow-up: 那它需要多久？");
  assert.equal(documentRetrievalQuery([{ role: "user", text: "差旅申请" }, { role: "user", text: "医疗预约流程" }]), "医疗预约流程");
  assert.match(formatDocumentContext([]), /do not invent document content/);
});

test("citation status requires the actual versioned source link and never implies verified claim support", async () => {
  const target = await document("差旅规程.md", "公务出行的费用核销需要保留票据。");
  const sources = await searchDocuments("费用核销");
  const url = documentSourceUrl(sources[0]);
  assert.equal(markDocumentCitations(sources, "未引用的答案")[0].citationStatus, "not-cited");
  assert.equal(markDocumentCitations(sources, `[规程](${url})`)[0].citationStatus, "cited");
  assert.equal(markDocumentCitations(sources, `[规程](/knowledge/documents/${target.id})`)[0].citationStatus, "not-cited");
  assert.equal(markDocumentCitations(sources, `只是提到 ${url}`)[0].citationStatus, "not-cited");
});

test("portable backups retain lexical frequencies and headings but exclude regenerable semantic vectors", async () => {
  const target = await document("差旅规程.md", "# 差旅规程\n\n公务出行的费用核销需要保留票据。");
  await indexDocumentEmbeddings(target.id, target.contentHash, modelRef);
  const backup = await createAccountBackup();
  const file = await openBackup(backup.id);
  const { manifest } = await readBackupManifest(file);
  await file.close();
  assert.ok(manifest.documents[0].chunks.some(chunk => chunk.heading === "差旅规程"));
  assert.ok(manifest.documents[0].chunks.every(chunk => !("embedding" in chunk)));
  await exclusiveDataOperation(() => restoreAccountBackup(backup.id));
  assert.equal(await db.documentChunk.count({ where: { embedding: { not: Prisma.AnyNull } } }), 0);
  assert.ok((await searchDocuments("费用核销"))[0].snippet.includes("保留票据"));
});
