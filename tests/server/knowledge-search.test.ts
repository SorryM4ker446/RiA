import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { fixtureLibraryItem } from "../helpers/model-fixture";
import { providerState, resetProviderState } from "../helpers/model-provider";

const cleanup = createTestDatabase();
process.env.RIA_TEST_PROVIDER = "1";
process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
process.env.APP_RUNTIME = "test";
const { db } = await import("@/db");
const { defaultModelPreferences, } = await import("@/lib/models/preferences-schema");
const { indexDocument } = await import("@/lib/documents/store");
const { indexDocumentEmbeddings, semanticCoverage } = await import("@/lib/documents/semantic");
const { documentIndexingSettled, documentIndexingStatus, resumeDocumentIndexing, scheduleDocumentIndexing } = await import("@/lib/documents/auto-index");
const { searchKnowledge } = await import("@/tools/definitions/search-knowledge");
const { saveKnowledgeEntry } = await import("@/lib/knowledge/entries");
const { DOCUMENT_INDEX_VERSION } = await import("@/lib/documents/chunks");
const documentsRoute = await import("@/app/api/documents/route");

const modelRef = { providerId: "openrouter", modelId: "openai/text-embedding-3-small" } as const;
async function useEmbedding(modelId: string | null = modelRef.modelId) {
  const settings = defaultModelPreferences();
  settings.embedding = modelId ? { ...modelRef, modelId } : null;
  settings.library = modelId ? [{ ...fixtureLibraryItem(modelId, ["embedding"]), providerId: "openrouter" }] as never : [];
  await db.workspacePreference.upsert({ where: { id: "local" }, update: { settings: settings as never }, create: { id: "local", settings: settings as never } });
}
const add = (filename: string, text: string) => indexDocument({ filename, collection: null, format: "txt", byteSize: Buffer.byteLength(text), pages: [{ pageNumber: null, text }] } as never);
const passages = (word: string, count: number) => Array.from({ length: count }, (_, index) => `# ${word}${index}\n\n${word}规定第${index}条。`).join("\n\n");

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {}); t.mock.method(console, "warn", () => {});
  await documentIndexingSettled();
  resetProviderState(); globalThis.__riaRateLimitStore?.clear();
  await db.knowledgeDocument.deleteMany({}); await db.memory.deleteMany({});
  await useEmbedding(null);
});
after(async () => { await documentIndexingSettled(); await db.$disconnect(); cleanup(); });

test("a matching entry keeps a place when documents would fill the results", async () => {
  await add("手册.txt", passages("试用期", 12));
  await saveKnowledgeEntry({ key: "试用期政策", value: "本公司试用期统一为六周。" });
  const found = await searchKnowledge({ query: "试用期", topK: 4 });
  assert.equal(found.results.length, 4);
  assert.equal(found.results.filter(item => item.source === "entry").length, 1);
  assert.equal(found.results.filter(item => item.source === "document").length, 3);
  assert.equal(found.results.find(item => item.source === "entry")?.snippet, "本公司试用期统一为六周。");

  const larger = await searchKnowledge({ query: "试用期", topK: 8 });
  assert.equal(larger.results.filter(item => item.source === "document").length, 7);
  const scoped = await searchKnowledge({ query: "试用期", topK: 4 }, { collections: ["财务"] });
  assert.equal(scoped.results.some(item => item.source === "entry"), false, "a search kept to topics still leaves entries out");
});

test("an entry that does not match takes no place from a document", async () => {
  await add("手册.txt", passages("试用期", 12));
  await saveKnowledgeEntry({ key: "午餐", value: "周五吃面。" });
  const found = await searchKnowledge({ query: "试用期", topK: 4 });
  assert.deepEqual(found.results.map(item => item.source), ["document", "document", "document", "document"]);
});

test("one search makes one embedding request, and a document's text goes to the model once", async () => {
  await useEmbedding();
  const saved = await add("手册.txt", "# 试用期\n\n试用期不得超过二个月。");
  void saved;
  scheduleDocumentIndexing(); await documentIndexingSettled();
  await saveKnowledgeEntry({ key: "试用期政策", value: "本公司试用期统一为六周。" });
  providerState.embeddingCalls.length = 0;
  const found = await searchKnowledge({ query: "试用期多久", topK: 4 });
  assert.equal(providerState.embeddingCalls.length, 1);
  const document = found.results.find(item => item.source === "document")!;
  assert.equal(document.snippet, undefined, "its text is in the reference");
  assert.match(document.reference!.snippet, /二个月/);
  assert.equal(JSON.stringify(document).split("二个月").length - 1, 1);
  assert.ok(document.url);
});

test("the model is told when a result rests on keywords alone, or on nothing", async () => {
  assert.match((await searchKnowledge({ query: "试用期", topK: 4 })).note ?? "", /No documents/);
  await add("手册.txt", "# 试用期\n\n试用期不得超过二个月。");
  assert.match((await searchKnowledge({ query: "试用期", topK: 4 })).note ?? "", /keyword matching only/);

  await useEmbedding();
  assert.match((await searchKnowledge({ query: "试用期", topK: 4 })).note ?? "", /keyword matching only/, "chosen but not built yet");
  scheduleDocumentIndexing(); await documentIndexingSettled();
  assert.equal((await searchKnowledge({ query: "试用期", topK: 4 })).note, undefined);
  await add("另一份.txt", "# 报销\n\n报销需要发票。");
  assert.match((await searchKnowledge({ query: "试用期", topK: 4 })).note ?? "", /keyword matching only|only part/);
});

test("importing with a model chosen builds the index on its own, and without one sends nothing", async () => {
  const cookie = localAccessCookie();
  const upload = (name: string, text: string) => {
    const form = new FormData();
    form.set("file", new File([text], name, { type: "text/plain" }));
    return documentsRoute.POST(new NextRequest("http://localhost/api/documents", { method: "POST", headers: { cookie }, body: form }));
  };
  assert.equal((await upload("甲.txt", "# 甲\n\n甲的内容。")).status, 201);
  await documentIndexingSettled();
  assert.equal(providerState.embeddingCalls.length, 0, "no model, nothing sent");

  await useEmbedding();
  assert.equal((await upload("乙.txt", "# 乙\n\n乙的内容。")).status, 201);
  await documentIndexingSettled();
  const documents = await db.knowledgeDocument.findMany({ include: { _count: { select: { chunks: true } } } });
  const { counts } = await semanticCoverage(documents.map(item => item.id));
  for (const document of documents) assert.equal(counts.get(document.id), document._count.chunks, `${document.filename} is built, including what was there before`);

  // Everything current: nothing more is sent.
  providerState.embeddingCalls.length = 0;
  scheduleDocumentIndexing(); await documentIndexingSettled();
  assert.equal(providerState.embeddingCalls.length, 0);
});

test("a long document is built batch by batch, and changing the model rebuilds", async () => {
  await useEmbedding();
  const doc = await add("长.txt", Array.from({ length: 70 }, (_, index) => `条目${index}。${"内容".repeat(420)}`).join("\n\n"));
  void doc;
  scheduleDocumentIndexing(); await documentIndexingSettled();
  assert.equal(providerState.embeddingCalls.flat().length, 70);
  const row = await db.knowledgeDocument.findFirstOrThrow();
  assert.equal((await semanticCoverage([row.id])).counts.get(row.id), 70);

  await useEmbedding("openai/another-embedding");
  scheduleDocumentIndexing(); await documentIndexingSettled();
  const rebuilt = await semanticCoverage([row.id]);
  assert.equal(rebuilt.counts.get(row.id), 70);
  assert.equal(rebuilt.modelRef?.modelId, "openai/another-embedding");
});

test("a failure stops the run, keeps what was saved, and is not retried until something asks", async () => {
  await useEmbedding();
  await add("甲.txt", Array.from({ length: 40 }, (_, index) => `条目${index}。${"内容".repeat(420)}`).join("\n\n"));
  await add("乙.txt", "# 乙\n\n乙的内容。");
  const row = await db.knowledgeDocument.findUniqueOrThrow({ where: { filename: "甲.txt" } });
  await indexDocumentEmbeddings(row.id, row.contentHash, modelRef);
  assert.equal((await semanticCoverage([row.id])).counts.get(row.id), 32);

  providerState.embeddingError = true;
  providerState.embeddingCalls.length = 0;
  scheduleDocumentIndexing(); await documentIndexingSettled();
  assert.equal(providerState.embeddingCalls.length, 1, "it stops at the first failure rather than trying every document");
  assert.equal((await semanticCoverage([row.id])).counts.get(row.id), 32, "the finished batch stays");
  assert.ok(documentIndexingStatus().failed);

  resumeDocumentIndexing(true); await documentIndexingSettled();
  assert.equal(providerState.embeddingCalls.length, 1, "opening the library does not retry a failure");

  providerState.embeddingError = false;
  providerState.embeddingCalls.length = 0;
  scheduleDocumentIndexing(); await documentIndexingSettled();
  assert.equal(documentIndexingStatus().failed, null);
  assert.equal((await semanticCoverage([row.id])).counts.get(row.id), 40, "asking again finishes it");
  assert.equal(providerState.embeddingCalls.flat().length, 10, "only what was missing: 8 of the first document and 2 of the second");
});

test("a document from an older index version is rebuilt without any model, then gets its vectors", async () => {
  await add("旧.txt", "# 旧\n\n旧的内容。");
  await db.knowledgeDocument.updateMany({ data: { indexVersion: DOCUMENT_INDEX_VERSION - 1 } });
  await useEmbedding();
  scheduleDocumentIndexing(); await documentIndexingSettled();
  const row = await db.knowledgeDocument.findFirstOrThrow();
  assert.equal(row.indexVersion, DOCUMENT_INDEX_VERSION);
  assert.ok((await semanticCoverage([row.id])).counts.get(row.id));
});

test("knowledge entries get their vectors in the same run, and a refusal stops it", async () => {
  const { staleEmbeddingSummary } = await import("@/lib/knowledge/entry-reindex");
  await saveKnowledgeEntry({ key: "试用期政策", value: "本公司试用期统一为六周。" });
  assert.equal((await staleEmbeddingSummary()).stale, 1, "saved before any model was chosen");

  await useEmbedding();
  providerState.embeddingError = true;
  scheduleDocumentIndexing(); await documentIndexingSettled();
  assert.ok(documentIndexingStatus().failed, "a provider that refuses stops the run");
  assert.equal((await staleEmbeddingSummary()).stale, 1);

  providerState.embeddingError = false;
  scheduleDocumentIndexing(); await documentIndexingSettled();
  assert.equal(documentIndexingStatus().failed, null);
  assert.equal((await staleEmbeddingSummary()).stale, 0, "choosing the model is enough; nothing to press");

  await useEmbedding("openai/another-embedding");
  scheduleDocumentIndexing(); await documentIndexingSettled();
  assert.equal((await staleEmbeddingSummary()).stale, 0, "a model change rebuilds them too");
});

test("an entry holds a place by meaning only when it is as close as the documents that made the list", async () => {
  await useEmbedding();
  // On this model's scale passages about rules sit at 0.8. An unrelated entry at 0.5 would
  // have passed a fixed bar (0.5 × 0.85 ≥ 0.3); a close one at 0.9 belongs.
  providerState.embeddingFunction = text => text.includes("午餐") ? [0.5, 0, Math.sqrt(0.75)] : text.includes("六周") ? [0.9, Math.sqrt(0.19), 0] : text.includes("规定") ? [0.8, 0.6, 0] : [1, 0, 0];
  await add("手册.txt", passages("条款", 12));
  await saveKnowledgeEntry({ key: "午餐", value: "周五吃面。" });
  scheduleDocumentIndexing(); await documentIndexingSettled();
  const unrelated = await searchKnowledge({ query: "入职多久转正", topK: 4 });
  assert.equal(unrelated.results.length, 4);
  assert.equal(unrelated.results.some(item => item.source === "entry"), false, "less close than every passage listed");

  await saveKnowledgeEntry({ key: "试用安排", value: "本公司试用期统一为六周。" });
  scheduleDocumentIndexing(); await documentIndexingSettled();
  const related = await searchKnowledge({ query: "入职多久转正", topK: 4 });
  assert.deepEqual(related.results.filter(item => item.source === "entry").map(item => item.title), ["试用安排"]);
});
