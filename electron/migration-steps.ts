import type { DatabaseSync } from "node:sqlite";

/*
 * Data a migration has to convert in JavaScript because SQL cannot, run by the
 * desktop migrator right after that migration's SQL and inside the same
 * transaction: a failure rolls back the whole migration, never half of it.
 *
 * Only data is converted here. Tables, columns and triggers stay in the SQL
 * files, so the schema drift check, which applies the SQL alone, still builds
 * the same schema.
 */

/** The longest vector RiA keeps; longer ones are dropped and built again by the embedding model. */
export const MAX_VECTOR_DIMENSIONS = 8192;

/**
 * A vector as stored: scaled to unit length, then little-endian Float32. Kept in
 * step with `encodeDocumentVector` in src/lib/documents/vectors.ts; a test checks
 * both produce the same bytes.
 */
export function encodeVector(values: unknown): Uint8Array | null {
  if (!Array.isArray(values) || !values.length || values.length > MAX_VECTOR_DIMENSIONS) return null;
  let norm = 0;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    norm += value * value;
  }
  if (!(norm > 0) || !Number.isFinite(norm)) return null;
  const length = Math.sqrt(norm);
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index++) view.setFloat32(index * 4, (values[index] as number) / length, true);
  return bytes;
}

/**
 * Document vectors from JSON to binary. A vector that cannot be read (not a
 * list of finite numbers, all zero, too long) is cleared with its model and
 * hash, so the background indexing builds it again.
 */
function documentVectors(database: DatabaseSync) {
  const rows = database.prepare('SELECT "id", "embedding" FROM "document_chunks" WHERE "embedding" IS NOT NULL').all() as Array<{ id: string; embedding: string | null }>;
  const keep = database.prepare('UPDATE "document_chunks" SET "vector" = ?, "embedding" = NULL WHERE "id" = ?');
  const drop = database.prepare('UPDATE "document_chunks" SET "vector" = NULL, "embedding" = NULL, "embeddingModelId" = NULL, "embeddingModelProvider" = NULL, "embeddingContextHash" = NULL WHERE "id" = ?');
  for (const row of rows) {
    let parsed: unknown = null;
    try { parsed = row.embedding === null ? null : JSON.parse(row.embedding); } catch { parsed = null; }
    const vector = encodeVector(parsed);
    if (vector) keep.run(vector, row.id);
    else drop.run(row.id);
  }
}

/**
 * A term as the full-text index stores it: its UTF-8 bytes in hexadecimal, which
 * the index's ASCII tokenizer keeps whole. Kept in step with `searchToken` in
 * src/lib/documents/lexical.ts; a test checks both agree.
 */
export const searchToken = (term: string) => Buffer.from(term, "utf8").toString("hex");

/**
 * Each chunk's terms from document_terms into one full-text row: every term
 * repeated by its frequency, so BM25 sees the same frequencies and lengths.
 */
function documentSearch(database: DatabaseSync) {
  // Read row by row: an existing library can hold millions of term rows.
  const rows = database.prepare('SELECT "chunkId", "term", "frequency" FROM "document_terms" ORDER BY "chunkId", "term"').iterate() as Iterable<{ chunkId: string; term: string; frequency: number }>;
  const insert = database.prepare('INSERT INTO "document_chunk_search" ("chunkId", "terms") VALUES (?, ?)');
  let chunkId: string | null = null, tokens: string[] = [];
  const flush = () => { if (chunkId !== null) insert.run(chunkId, tokens.join(" ")); };
  for (const row of rows) {
    if (row.chunkId !== chunkId) { flush(); chunkId = row.chunkId; tokens = []; }
    const token = searchToken(row.term);
    for (let count = 0; count < Math.max(1, row.frequency); count++) tokens.push(token);
  }
  flush();
}

export const migrationDataSteps: Readonly<Record<string, (database: DatabaseSync) => void>> = {
  "20261120100000_document_vectors": documentVectors,
  "20261121100000_document_search": documentSearch,
};
