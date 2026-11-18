import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { after, beforeEach, test, type TestContext } from "node:test";
import { createTestDatabase } from "../helpers/database";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const archive = await import("@/lib/backups/archive");
const files = await import("@/lib/backups/files");
const { restoreAccountBackup } = await import("@/lib/backups/restore");
const { exclusiveDataOperation } = await import("@/lib/server/data-operations");
const { indexDocument } = await import("@/lib/documents/store");
const { hashDocumentContent } = await import("@/lib/documents/chunks");
const { documentEmbeddingText } = await import("@/lib/documents/lexical");
const { encodeDocumentVector, normalizeVector } = await import("@/lib/documents/vectors");
const { clearDocumentVectorIndex, searchDocumentVectors } = await import("@/lib/documents/vector-index");
const { retrieveDocuments } = await import("@/lib/documents/retrieval");
const { defaultModelPreferences } = await import("@/lib/models/preferences-schema");
after(async () => { await db.$disconnect(); cleanup(); });

const model = { providerId: "openrouter", modelId: "test/embedding" } as const;
beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {});
  for (const file of await files.listBackupFiles()) await files.removeBackupFile(file.id, file.extension);
  await db.knowledgeDocument.deleteMany({});
  await db.workspacePreference.deleteMany({});
  clearDocumentVectorIndex();
});

/** Reads an archive's manifest the way the archive reader does: after the 44-byte header. */
async function manifestOf(id: string) {
  const handle = await files.openBackup(id);
  try { return (await archive.readBackupManifest(handle)).manifest; } finally { await handle.close(); }
}

test("format 2 archives carry each document's chunks and vectors in a block, and restore brings back the ones that still fit", async () => {
  const { document } = await indexDocument({ filename: "差旅规程.md", collection: "财务", format: "md", byteSize: 10, pages: [{ pageNumber: null, text: "# 住宿\n\n住宿标准每晚五百元，需要主管审批。\n\n# 交通\n\nSQLITE_MAX_ATTACHED 与出差无关。" }] });
  const chunks = await db.documentChunk.findMany({ where: { documentId: document.id }, orderBy: { ordinal: "asc" } });
  assert.ok(chunks.length >= 2);
  const doc = { filename: "差旅规程.md", collection: "财务" };
  for (const [index, chunk] of chunks.entries()) {
    await db.documentChunk.update({ where: { id: chunk.id }, data: {
      vector: encodeDocumentVector(index === 0 ? [1, 0, 0] : [0, 1, 0]), embeddingModelProvider: model.providerId, embeddingModelId: model.modelId,
      // The last chunk's vector no longer describes it: it must not come back.
      embeddingContextHash: index === chunks.length - 1 ? "stale" : hashDocumentContent(documentEmbeddingText(chunk, doc)),
    } });
  }

  const backup = await exclusiveDataOperation(() => archive.createAccountBackup(false));
  const manifest = await manifestOf(backup.id);
  assert.equal(manifest.version, 2);
  const archived = manifest.documents[0] as { content?: { byteSize: number }; chunkCount: number; pages?: unknown };
  assert.ok(archived.content && archived.content.byteSize > 0);
  assert.equal(archived.chunkCount, chunks.length);
  assert.equal(archived.pages, undefined, "pages are in the block, not the manifest");

  await db.knowledgeDocument.deleteMany({});
  await exclusiveDataOperation(() => restoreAccountBackup(backup.id));
  const restored = await db.knowledgeDocument.findFirstOrThrow({ include: { chunks: { orderBy: { ordinal: "asc" } } } });
  assert.deepEqual(restored.chunks.map(chunk => chunk.id), chunks.map(chunk => chunk.id), "chunk identities survive, so citations still resolve");
  assert.equal(restored.collection, "财务");
  const withVectors = restored.chunks.filter(chunk => chunk.vector);
  assert.equal(withVectors.length, chunks.length - 1, "the stale vector is not restored");
  assert.equal(restored.chunks.at(-1)!.vector, null);

  const found = await searchDocumentVectors({ model, query: normalizeVector([1, 0, 0])! });
  assert.equal(found.results[0].id, chunks[0].id);
  const keyword = await retrieveDocuments("SQLITE_MAX_ATTACHED");
  assert.ok(keyword.sources.some(source => source.snippet.includes("SQLITE_MAX_ATTACHED")), "the keyword index is rebuilt from the text, terms with underscores included");
});

test("an archive written before format 2 still restores its documents, with the keyword index rebuilt from the text", async () => {
  const settings = defaultModelPreferences();
  const manifest = {
    format: "ria-account-backup", version: 1, createdAt: new Date().toISOString(),
    chats: [], memories: [], tasks: [], assets: [], usage: [], preferences: settings,
    documents: [{
      id: "legacy-doc", filename: "旧手册.txt", collection: null, format: "txt", byteSize: 20, contentHash: hashDocumentContent("旧手册"),
      pages: [{ pageNumber: null, text: "仓库每周四开放。" }], characterCount: 8, indexVersion: 4,
      indexedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      chunks: [{ id: "legacy-chunk", documentId: "legacy-doc", chunkKey: "k:0", ordinal: 0, pageNumber: null, text: "仓库每周四开放。", heading: null, tokenCount: 3, terms: [{ chunkId: "legacy-chunk", term: "仓库", frequency: 1 }] }],
    }],
  };
  const json = Buffer.from(JSON.stringify(manifest));
  const header = Buffer.alloc(44);
  Buffer.from("RIAB0001").copy(header); header.writeUInt32BE(json.length, 8); createHash("sha256").update(json).digest().copy(header, 12);
  const id = crypto.randomUUID();
  await writeFile(await files.backupFile(id), Buffer.concat([header, json]));

  await exclusiveDataOperation(() => restoreAccountBackup(id));
  const restored = await db.knowledgeDocument.findFirstOrThrow({ include: { chunks: { include: { search: true } } } });
  assert.equal(restored.filename, "旧手册.txt");
  assert.ok(restored.chunks[0].search?.terms.includes(Buffer.from("仓库").toString("hex")));
  assert.ok((await retrieveDocuments("仓库开放")).sources.some(source => source.snippet.includes("每周四")));
});

test("a damaged document block is refused before the workspace is touched", async () => {
  await indexDocument({ filename: "keep.txt", format: "txt", byteSize: 4, pages: [{ pageNumber: null, text: "保留的资料" }] });
  const backup = await exclusiveDataOperation(() => archive.createAccountBackup(false));
  const path = await files.backupFile(backup.id);
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(path);
  bytes[bytes.length - 3] ^= 0xff;
  await writeFile(path, bytes);
  await indexDocument({ filename: "live.txt", format: "txt", byteSize: 4, pages: [{ pageNumber: null, text: "现在的资料" }] });
  await assert.rejects(exclusiveDataOperation(() => restoreAccountBackup(backup.id)));
  assert.deepEqual((await db.knowledgeDocument.findMany({ orderBy: { filename: "asc" } })).map(row => row.filename), ["keep.txt", "live.txt"]);
});
