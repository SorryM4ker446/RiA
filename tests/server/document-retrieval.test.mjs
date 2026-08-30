import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { createTestDatabase } from "../helpers/database.mjs";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { indexDocument } = await import("@/lib/documents/store");
const { searchDocuments, formatDocumentContext } = await import("@/lib/documents/retrieval");
const { searchKnowledge } = await import("@/tools/definitions/search-knowledge");
const { buildDocumentChunks } = await import("@/lib/documents/chunks");
after(async () => { await db.$disconnect(); cleanup(); });

test("Chinese and English retrieval maintains recall and ranking against a fixed corpus with recent distractors", async t => {
  const corpus = JSON.parse(readFileSync(new URL("../fixtures/document-retrieval.json", import.meta.url), "utf8"));
  const user = await db.user.create({ data: { email: "retrieval@example.invalid" } });
  for (const document of corpus.documents) await indexDocument(user.id, { ...document, format: "txt", byteSize: Buffer.byteLength(document.text), pages: [{ pageNumber: null, text: document.text }] });
  for (let index = 0; index < 40; index++) await indexDocument(user.id, { filename: `recent-${index}.txt`, format: "txt", byteSize: 25, pages: [{ pageNumber: null, text: `最新公告 ${index}：花园浇水时间为早上七点。` }] });
  let recalled = 0, reciprocalRank = 0;
  for (const query of corpus.queries) {
    const results = await searchDocuments(user.id, query.query, 3);
    const rank = results.findIndex(result => result.filename === query.expected && result.snippet.includes(query.excerpt));
    if (rank >= 0) { recalled++; reciprocalRank += 1 / (rank + 1); }
    assert.equal(results[0]?.filename, query.expected, query.query);
    assert.ok(results[0].snippet.includes(query.excerpt), query.query);
    assert.deepEqual(await searchDocuments(user.id, query.query, 3), results);
  }
  const metrics = { queries: corpus.queries.length, recallAt3: recalled / corpus.queries.length, meanReciprocalRankAt3: reciprocalRank / corpus.queries.length };
  t.diagnostic(JSON.stringify(metrics));
  assert.equal(metrics.recallAt3, 1);
  assert.equal(metrics.meanReciprocalRankAt3, 1);
  assert.deepEqual(await searchDocuments(user.id, "罕见外星矿石 zirconiumxyz"), []);
  const tool = await searchKnowledge(user.id, { query: "星河项目回滚窗口", topK: 4 });
  assert.equal(tool.results[0].source, "document");
  assert.equal(tool.results[0].reference.filename, "星河发布.md");
  const context = formatDocumentContext(await searchDocuments(user.id, "星河项目回滚窗口"));
  assert.match(context, /untrusted reference data/);
  assert.match(context, /三十分钟/);
  assert.match(context, /knowledge\/documents\//);
});

test("chunk boundaries retain paragraphs, distinguish duplicates and bound long text without breaking surrogate pairs", () => {
  const first = buildDocumentChunks([{ pageNumber: 2, text: "重复内容。\n\n重复内容。" }]);
  assert.equal(first.length, 2);
  assert.notEqual(first[0].chunkKey, first[1].chunkKey);
  assert.equal(first[0].pageNumber, 2);
  const chunks = buildDocumentChunks([{ pageNumber: null, text: "😀".repeat(2000) }]);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.text.length <= 1000 && chunk.text.isWellFormed()));
  assert.equal(buildDocumentChunks([{ pageNumber: null, text: "新增。\n\n重复内容。" }])[1].chunkKey, buildDocumentChunks([{ pageNumber: null, text: "重复内容。" }])[0].chunkKey);
});
