import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createTestDatabase } from "../helpers/database";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { hashDocumentContent } = await import("@/lib/documents/chunks");
const { documentEmbeddingText } = await import("@/lib/documents/lexical");
const { decodeDocumentVector, dot, encodeDocumentVector, normalizeVector } = await import("@/lib/documents/vectors");
const { clearDocumentVectorIndex, documentVectorCoverage, searchDocumentVectors, SEMANTIC_RESULTS } = await import("@/lib/documents/vector-index");
const { createAccountBackup } = await import("@/lib/backups/archive");
const { exclusiveDataOperation } = await import("@/lib/server/data-operations");
after(async () => { await db.$disconnect(); cleanup(); });

const model = { providerId: "openrouter", modelId: "test/embedding" } as const;
beforeEach(async () => {
  clearDocumentVectorIndex();
  await db.knowledgeDocument.deleteMany({});
});

/** A small deterministic generator, so a failing ranking can be reproduced. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32 * 2 - 1; };
}
const vectorOf = (next: () => number, dimensions: number) => Array.from({ length: dimensions }, next);

/** A document whose chunks carry vectors the way indexing writes them. */
async function seed(name: string, vectors: number[][], collection: string | null = null) {
  const document = await db.knowledgeDocument.create({ data: {
    filename: name, collection, format: "txt", byteSize: 1, contentHash: hashDocumentContent(name), pages: [{ pageNumber: null, text: name }], characterCount: 1, indexVersion: 4,
  } });
  const rows = vectors.map((vector, index) => {
    const chunk = { text: `${name} ${index}`, heading: null };
    return {
      id: `${name}-${String(index).padStart(5, "0")}`, documentId: document.id, chunkKey: `${name}:${index}`, ordinal: index, text: chunk.text, heading: chunk.heading,
      vector: encodeDocumentVector(vector), embeddingModelProvider: model.providerId, embeddingModelId: model.modelId,
      embeddingContextHash: hashDocumentContent(documentEmbeddingText(chunk, document)),
    };
  });
  for (let offset = 0; offset < rows.length; offset += 500) await db.documentChunk.createMany({ data: rows.slice(offset, offset + 500) });
  return document;
}

async function exactRanking(query: Float32Array, collections: string[] = []) {
  const rows = await db.documentChunk.findMany({ where: { vector: { not: null }, ...(collections.length ? { document: { collection: { in: collections } } } : {}) }, select: { id: true, vector: true } });
  return rows.map(row => ({ id: row.id, score: dot(query, decodeDocumentVector(row.vector)!) }))
    .filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, SEMANTIC_RESULTS);
}

test("the int8 scan with exact rescoring ranks exactly as scoring every stored vector does", async () => {
  const next = random(20261117);
  const dimensions = 96;
  await seed("alpha.txt", Array.from({ length: 1400 }, () => vectorOf(next, dimensions)), "工作");
  await seed("beta.txt", Array.from({ length: 900 }, () => vectorOf(next, dimensions)), "生活");
  await seed("gamma.txt", Array.from({ length: 700 }, () => vectorOf(next, dimensions)), null);
  for (let round = 0; round < 25; round++) {
    const query = normalizeVector(vectorOf(next, dimensions))!;
    const collections = round % 5 === 0 ? ["工作"] : [];
    const found = await searchDocumentVectors({ model, query, collections });
    const expected = await exactRanking(query, collections);
    assert.deepEqual(found.results.map(row => row.id), expected.map(row => row.id), `round ${round}`);
    found.results.forEach((row, index) => assert.ok(Math.abs(row.score - expected[index].score) < 1e-6));
    assert.equal(found.compatible, collections.length ? 1400 : 3000);
  }
});

test("the index follows writes: changed, cleared and deleted vectors are reloaded from their revision", async () => {
  const next = random(7);
  const first = await seed("one.txt", Array.from({ length: 50 }, () => vectorOf(next, 16)));
  const second = await seed("two.txt", Array.from({ length: 50 }, () => vectorOf(next, 16)));
  const target = vectorOf(next, 16);
  const query = normalizeVector(target)!;

  // A vector rewritten to match the query comes first on the next search.
  await db.documentChunk.update({ where: { id: "one.txt-00007" }, data: { vector: encodeDocumentVector(target) } });
  assert.equal((await searchDocumentVectors({ model, query })).results[0].id, "one.txt-00007");

  // Text that changes clears its vector, through the trigger, whoever writes it.
  await db.documentChunk.update({ where: { id: "one.txt-00007" }, data: { text: "rewritten" } });
  const cleared = await db.documentChunk.findUniqueOrThrow({ where: { id: "one.txt-00007" } });
  assert.equal(cleared.vector, null); assert.equal(cleared.embeddingContextHash, null);
  assert.ok(!(await searchDocumentVectors({ model, query })).results.some(row => row.id === "one.txt-00007"));

  // A collection move invalidates every vector of the document; deleting a document takes it out.
  await db.knowledgeDocument.update({ where: { id: second.id }, data: { collection: "归档" } });
  assert.equal(await db.documentChunk.count({ where: { documentId: second.id, vector: { not: null } } }), 0);
  await db.knowledgeDocument.delete({ where: { id: first.id } });
  const after = await searchDocumentVectors({ model, query });
  assert.deepEqual(after.results, []); assert.equal(after.compatible, 0);
  assert.deepEqual([...(await documentVectorCoverage(model)).keys()], [second.id]);
});

test("stale, unreadable and other-length vectors are left out and counted, never ranked", async () => {
  const next = random(11);
  const doc = await seed("mixed.txt", Array.from({ length: 6 }, () => vectorOf(next, 8)));
  await db.documentChunk.update({ where: { id: "mixed.txt-00000" }, data: { embeddingContextHash: "stale" } });
  await db.documentChunk.update({ where: { id: "mixed.txt-00001" }, data: { vector: new Uint8Array(32) } });
  await db.documentChunk.update({ where: { id: "mixed.txt-00002" }, data: { vector: new Uint8Array([1, 2, 3]) } });
  const coverage = (await documentVectorCoverage(model)).get(doc.id);
  assert.deepEqual(coverage, { ready: 3, stale: 1, invalid: 2 });
  const found = await searchDocumentVectors({ model, query: normalizeVector(vectorOf(next, 8))! });
  assert.ok(found.results.every(row => !["mixed.txt-00000", "mixed.txt-00001", "mixed.txt-00002"].includes(row.id)));
  const otherLength = await searchDocumentVectors({ model, query: normalizeVector([1, 0, 0])! });
  assert.deepEqual(otherLength.results, []); assert.equal(otherLength.invalid, 2 + 3);
});

test("vectors are stored at unit length as little-endian Float32", () => {
  const bytes = encodeDocumentVector([3, 4])!;
  assert.equal(bytes.byteLength, 8);
  const view = new DataView(bytes.buffer);
  assert.ok(Math.abs(view.getFloat32(0, true) - 0.6) < 1e-7 && Math.abs(view.getFloat32(4, true) - 0.8) < 1e-7);
  for (const bad of [[], [0, 0], [1, Number.NaN], new Array(8193).fill(1)]) assert.equal(encodeDocumentVector(bad), null);
  assert.equal(decodeDocumentVector(new Uint8Array(6)), null);
});

test("a backup holds documents up to the import size limit, not the old 8 MiB", async () => {
  await db.knowledgeDocument.create({ data: {
    filename: "large-scan.pdf", format: "pdf", byteSize: 20 * 1024 * 1024, contentHash: hashDocumentContent("large"), pages: [{ pageNumber: 1, text: "扫描件" }], characterCount: 3, indexVersion: 4,
    chunks: { create: [{ chunkKey: "large:0", ordinal: 0, pageNumber: 1, text: "扫描件" }] },
  } });
  const backup = await exclusiveDataOperation(() => createAccountBackup(false));
  assert.ok(backup.id);
});
