import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { createTestDatabase } from "../helpers/database";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { indexDocument } = await import("@/lib/documents/store");
const { searchDocuments, formatDocumentContext } = await import("@/lib/documents/retrieval");
const { searchKnowledge } = await import("@/tools/definitions/search-knowledge");
const { buildDocumentChunks } = await import("@/lib/documents/chunks");
// String.isWellFormed ships in Node, but the repository lib target predates it.
const isWellFormedString = (value: string) => (value as unknown as { isWellFormed(): boolean }).isWellFormed();
after(async () => { await db.$disconnect(); cleanup(); });

test("Chinese and English retrieval maintains recall and ranking against a fixed corpus with recent distractors", async t => {
  const corpus = JSON.parse(readFileSync(new URL("../fixtures/document-retrieval.json", import.meta.url), "utf8"));

  for (const document of corpus.documents) await indexDocument( { ...document, format: "txt", byteSize: Buffer.byteLength(document.text), pages: [{ pageNumber: null, text: document.text }] });
  for (let index = 0; index < 40; index++) await indexDocument( { filename: `recent-${index}.txt`, format: "txt", byteSize: 25, pages: [{ pageNumber: null, text: `最新公告 ${index}：花园浇水时间为早上七点。` }] });
  let recalled = 0, reciprocalRank = 0;
  for (const query of corpus.queries) {
    const results = await searchDocuments( query.query, 3);
    const rank = results.findIndex(result => result.filename === query.expected && result.snippet.includes(query.excerpt));
    if (rank >= 0) { recalled++; reciprocalRank += 1 / (rank + 1); }
    assert.equal(results[0]?.filename, query.expected, query.query);
    assert.ok(results[0].snippet.includes(query.excerpt), query.query);
    assert.deepEqual(await searchDocuments( query.query, 3), results);
  }
  const metrics = { queries: corpus.queries.length, recallAt3: recalled / corpus.queries.length, meanReciprocalRankAt3: reciprocalRank / corpus.queries.length };
  t.diagnostic(JSON.stringify(metrics));
  assert.equal(metrics.recallAt3, 1);
  assert.equal(metrics.meanReciprocalRankAt3, 1);
  assert.deepEqual(await searchDocuments( "罕见外星矿石 zirconiumxyz"), []);
  let rejected = 0;
  for (const query of corpus.negativeQueries) {
    const results = await searchDocuments(query, 3);
    assert.deepEqual(results, [], query); rejected += Number(results.length === 0);
  }
  for (const query of corpus.scopedQueries) {
    const results = await searchDocuments(query.query, 3, query.collections);
    assert.equal(results[0]?.filename ?? null, query.expected, JSON.stringify(query));
    assert.ok(results.every(result => query.collections.includes(result.collection)));
  }
  t.diagnostic(JSON.stringify({ noAnswerRejection: rejected / corpus.negativeQueries.length, collectionChecks: corpus.scopedQueries.length }));
  const tool = await searchKnowledge( { query: "星河项目回滚窗口", topK: 4 });
  assert.equal(tool.results[0].source, "document");
  assert.equal(tool.results[0].reference.filename, "星河发布.md");
  const context = formatDocumentContext(await searchDocuments( "星河项目回滚窗口"));
  assert.match(context, /untrusted reference data/);
  assert.match(context, /三十分钟/);
  assert.match(context, /knowledge\/documents\//);
});

test("short paragraphs of one section share a chunk, so a condition and its exceptions stay together", () => {
  const items = ["第二十五条 消费者有权自收到商品之日起七日内退货，但下列商品除外:", "（一）消费者定作的；", "（二）鲜活易腐的；", "（三）在线下载的数字化商品。"];
  const merged = buildDocumentChunks([{ pageNumber: null, text: items.join("\n\n") }]);
  assert.equal(merged.length, 1);
  for (const item of items) assert.ok(merged[0].text.includes(item));

  const sections = buildDocumentChunks([{ pageNumber: null, text: "# 一\n\n甲。\n\n乙。\n\n# 二\n\n丙。" }]);
  assert.deepEqual(sections.map(chunk => chunk.text), ["# 一", "甲。\n\n乙。", "# 二", "丙。"], "a heading always starts a new chunk");
  assert.deepEqual(sections.map(chunk => chunk.heading), ["一", "一", "二", "二"]);

  const pages = buildDocumentChunks([{ pageNumber: 1, text: "甲。" }, { pageNumber: 2, text: "乙。" }]);
  assert.deepEqual(pages.map(chunk => chunk.pageNumber), [1, 2], "a page number stays true of its chunk");

  const long = buildDocumentChunks([{ pageNumber: null, text: Array.from({ length: 6 }, (_, index) => `段落${index}${"内容".repeat(150)}`).join("\n\n") }]);
  assert.ok(long.length >= 3 && long.every(chunk => chunk.text.length <= 800), "merging stops at a size worth reading on its own");

  const table = buildDocumentChunks([{ pageNumber: null, text: "说明。\n\n| 项目 | 金额 |\n| --- | --- |\n| 住宿 | 500 |\n\n后记。" }]);
  assert.equal(table.length, 3, "a table keeps its own chunk");
  // Text that the chunk limit once refused at about a tenth of the size it can now hold.
  const statute = Array.from({ length: 600 }, (_, index) => `第${index}条 用人单位应当履行义务。`).join("\n\n");
  assert.ok(buildDocumentChunks([{ pageNumber: null, text: statute }]).length < 40);
});

test("chunk boundaries retain paragraphs, distinguish duplicates and bound long text without breaking surrogate pairs", () => {
  const repeated = "重复内容。".repeat(90);
  const first = buildDocumentChunks([{ pageNumber: 2, text: `${repeated}\n\n${repeated}` }]);
  assert.equal(first.length, 2);
  assert.notEqual(first[0].chunkKey, first[1].chunkKey);
  assert.equal(first[0].pageNumber, 2);
  const chunks = buildDocumentChunks([{ pageNumber: null, text: "😀".repeat(2000) }]);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.text.length <= 1000 && isWellFormedString(chunk.text)));
  assert.equal(buildDocumentChunks([{ pageNumber: null, text: "# 新增\n\n重复内容。" }])[1].chunkKey, buildDocumentChunks([{ pageNumber: null, text: "重复内容。" }])[0].chunkKey);
});

test("keyword candidates are chosen by their full BM25 score, so many passages sharing a word cannot push out the best one", async () => {
  // Every section mentions the word once in a long paragraph; the last one is short and about it.
  // Chosen by word rarity alone, all tie and the first 200 by position are kept, losing the last.
  const filler = "这一节记录日常事项，内容较长，与主题关系不大，只是顺带提到一次预算，其余都是无关的叙述和说明文字。".repeat(3);
  const sections = Array.from({ length: 210 }, (_, index) => `## 第${index + 1}节\n${filler}`);
  sections.push("## 结尾\n预算预算预算：预算的审批由财务负责。");
  const text = sections.join("\n\n");
  await indexDocument({ filename: "bm25-candidates.txt", collection: "bm25-candidates", format: "txt", byteSize: Buffer.byteLength(text), pages: [{ pageNumber: null, text }] });
  assert.ok(await db.documentChunk.count({ where: { document: { collection: "bm25-candidates" } } }) > 200);
  const results = await searchDocuments("预算", 3, ["bm25-candidates"]);
  assert.match(results[0]?.snippet ?? "", /预算的审批由财务负责/u);
});
