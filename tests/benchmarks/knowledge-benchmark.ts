/*
 * Measures the knowledge base at a size well past today's limits, to set the
 * new ones from numbers rather than guesses. Run with:
 *
 *   node --import ./tests/helpers/register-typescript.ts tests/benchmarks/knowledge-benchmark.ts [--chunks 100000] [--dimensions 1024]
 *
 * It builds a throwaway database in the system temporary directory and reports:
 * - how long one import holds the write transaction, by document size;
 * - how many keyword rows a chunk adds, and the database size;
 * - the vector index's first load, memory and search time;
 * - whether the int8 scan with exact rescoring still ranks as exact scoring does.
 * No model is called.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { createTestDatabase } from "../helpers/database";

const { values } = parseArgs({ options: { chunks: { type: "string", default: "100000" }, dimensions: { type: "string", default: "1024" }, sizes: { type: "string", default: "256,1000,4000,10000" } } });
const totalChunks = Number(values.chunks), dimensions = Number(values.dimensions);
const importSizes = values.sizes!.split(",").map(Number);

const scratch = mkdtempSync(join(tmpdir(), "ria-knowledge-benchmark-"));
const cleanup = createTestDatabase();
const databaseFile = (process.env.DATABASE_URL ?? "").replace(/^file:/, "");
const { db } = await import("@/db");
const { DOCUMENT_LIMITS } = await import("@/lib/documents/types");
const { indexDocument } = await import("@/lib/documents/store");
const { hashDocumentContent } = await import("@/lib/documents/chunks");
const { documentEmbeddingText } = await import("@/lib/documents/lexical");
const { encodeDocumentVector, normalizeVector, decodeDocumentVector, dot } = await import("@/lib/documents/vectors");
const { clearDocumentVectorIndex, searchDocumentVectors, documentVectorCoverage, documentVectorIndexBytes } = await import("@/lib/documents/vector-index");
const { retrieveDocuments } = await import("@/lib/documents/retrieval");

const model = { providerId: "openrouter", modelId: "benchmark/embedding" } as const;
let seed = 20261117;
const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
// A large vocabulary of common-range characters and some English, so a chunk adds about as many keyword rows as real text does.
const character = () => String.fromCodePoint(0x4e00 + Math.floor(random() * 0x1400));
const words = [...Array.from({ length: 6000 }, () => character() + character()), ...Array.from({ length: 600 }, character), "invoice", "approval", "policy", "travel", "budget", "deadline", "vendor", "contract"];
const sentence = () => Array.from({ length: 12 + Math.floor(random() * 10) }, () => words[Math.floor(random() * words.length)]).join("") + "。";
const paragraph = () => Array.from({ length: 6 }, sentence).join("");
const report: Record<string, unknown> = { totalChunks, dimensions, limits: { characters: DOCUMENT_LIMITS.characters, chunks: DOCUMENT_LIMITS.chunks } };
const ms = (start: number) => Math.round(performance.now() - start);

try {
  // 1. One import, by size: the whole replacement happens in one transaction, which holds SQLite's only writer.
  const imports: unknown[] = [];
  for (const size of importSizes) {
    // Pages stay under the per-page character cap the schema fixed when it loaded.
    const pages: Array<{ pageNumber: number; text: string }> = [];
    for (let index = 0; index < size; index++) {
      const section = `## 第${index}节\n\n${paragraph()}`;
      const last = pages.at(-1);
      if (last && last.text.length + section.length + 2 <= 90_000) last.text += `\n\n${section}`;
      else pages.push({ pageNumber: pages.length + 1, text: section });
    }
    const characters = pages.reduce((sum, page) => sum + page.text.length, 0);
    (DOCUMENT_LIMITS as { characters: number; chunks: number }).characters = Math.max(DOCUMENT_LIMITS.characters, characters);
    (DOCUMENT_LIMITS as { characters: number; chunks: number }).chunks = Math.max(DOCUMENT_LIMITS.chunks, size * 2);
    const started = performance.now();
    try {
      const result = await indexDocument({ filename: `import-${size}.md`, format: "md", byteSize: characters * 3, pages });
      imports.push({ chunks: result.added, characters, ms: ms(started) });
    } catch (error) {
      imports.push({ chunks: size, characters, ms: ms(started), failed: error instanceof Error ? error.message.slice(0, 160) : String(error) });
    }
  }
  report.imports = imports;
  const keywordRows = await db.documentChunkSearch.count(), keywordChunks = await db.documentChunk.count();
  report.keywords = { chunks: keywordChunks, rows: keywordRows, rowsPerChunk: Math.round(keywordRows / Math.max(1, keywordChunks)) };

  // 2. Fill the library to the target size with vectors, straight through SQLite for speed.
  const filler = new DatabaseSync(databaseFile);
  try {
    const documents = Math.ceil(totalChunks / 1000);
    const insertDocument = filler.prepare(`INSERT INTO knowledge_documents (id,filename,collection,format,byteSize,contentHash,pages,characterCount,indexVersion,updatedAt) VALUES (?,?,?,?,?,?,?,?,4,CURRENT_TIMESTAMP)`);
    const insertChunk = filler.prepare(`INSERT INTO document_chunks (id,documentId,chunkKey,ordinal,text,heading,vector,embeddingModelProvider,embeddingModelId,embeddingContextHash) VALUES (?,?,?,?,?,NULL,?,?,?,?)`);
    // Keyword rows like real text's: about a hundred terms per chunk, written as the index stores them.
    const insertSearch = filler.prepare(`INSERT INTO document_chunk_search (chunkId, terms) VALUES (?, ?)`);
    const termsFor = () => Array.from({ length: 98 }, () => Buffer.from(words[Math.floor(random() * words.length)]).toString("hex")).join(" ");
    const started = performance.now();
    filler.exec("BEGIN");
    for (let document = 0; document < documents; document++) {
      const id = `bench-${document}`, filename = `bench-${document}.txt`, collection = document % 4 ? "工作" : "生活";
      insertDocument.run(id, filename, collection, "txt", 1, hashDocumentContent(id), "[]", 1);
      for (let ordinal = 0; ordinal < 1000 && document * 1000 + ordinal < totalChunks; ordinal++) {
        const text = `${filename} ${ordinal}`;
        const vector = encodeDocumentVector(Array.from({ length: dimensions }, () => random() * 2 - 1))!;
        insertChunk.run(`${id}-${ordinal}`, id, `${id}:${ordinal}`, ordinal, text, vector, model.providerId, model.modelId, hashDocumentContent(documentEmbeddingText({ text, heading: null }, { filename, collection })));
        insertSearch.run(`${id}-${ordinal}`, termsFor());
      }
    }
    filler.exec("COMMIT");
    report.fill = { documents, ms: ms(started) };
  } finally { filler.close(); }
  report.databaseBytes = statSync(databaseFile).size;

  // 3. The vector index: first load, memory, warm search time, and its ranking against exact scoring.
  clearDocumentVectorIndex();
  globalThis.gc?.();
  const memoryBefore = process.memoryUsage();
  let started = performance.now();
  const coverage = await documentVectorCoverage(model);
  const loadMs = ms(started);
  globalThis.gc?.();
  const memoryAfter = process.memoryUsage();
  report.index = {
    vectors: [...coverage.values()].reduce((sum, entry) => sum + entry.ready, 0), loadMs, indexMb: Math.round(documentVectorIndexBytes() / 1024 / 1024),
    arrayBuffersMb: Math.round((memoryAfter.arrayBuffers - memoryBefore.arrayBuffers) / 1024 / 1024),
    heapMb: Math.round((memoryAfter.heapUsed - memoryBefore.heapUsed) / 1024 / 1024),
  };
  const searches: number[] = [];
  let identical = 0;
  // The reference reads every vector straight from SQLite: through Prisma, 100,000 of them exceed
  // the longest string V8 can hold. The product never reads more than a few thousand at once.
  const reader = new DatabaseSync(databaseFile, { readOnly: true });
  const exactRows = (reader.prepare("SELECT id, vector FROM document_chunks WHERE vector IS NOT NULL").all() as Array<{ id: string; vector: Uint8Array }>)
    .map(row => ({ id: row.id, vector: decodeDocumentVector(row.vector)! }));
  reader.close();
  for (let round = 0; round < 20; round++) {
    const query = normalizeVector(Array.from({ length: dimensions }, () => random() * 2 - 1))!;
    started = performance.now();
    const found = await searchDocumentVectors({ model, query });
    searches.push(performance.now() - started);
    const exact = exactRows.map(row => ({ id: row.id, score: dot(query, row.vector) })).filter(row => row.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, found.results.length);
    if (exact.every((row, index) => row.id === found.results[index]?.id)) identical++;
  }
  searches.sort((a, b) => a - b);
  report.search = { medianMs: Math.round(searches[10]), worstMs: Math.round(searches.at(-1)!), rankingIdenticalToExact: `${identical}/20` };

  // 4. Keyword search over the imported documents, the part of a search that grows with keyword rows.
  const lexical: number[] = [];
  // Questions from the same vocabulary, so each term matches about as many passages as a common word does.
  const questions = Array.from({ length: 5 }, () => Array.from({ length: 4 }, () => words[Math.floor(random() * words.length)]).join(" "));
  for (const question of questions) {
    started = performance.now();
    await retrieveDocuments(question);
    lexical.push(ms(started));
  }
  report.keywordSearchMs = lexical;
  console.log(JSON.stringify(report, null, 2));
} finally {
  await db.$disconnect();
  cleanup();
  rmSync(scratch, { recursive: true, force: true });
}
