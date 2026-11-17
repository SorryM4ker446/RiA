import { db } from "@/db";
import type { ModelRef } from "@/lib/models/preferences-schema";
import { hashDocumentContent } from "@/lib/documents/chunks";
import { documentEmbeddingText } from "@/lib/documents/lexical";
import { decodeDocumentVector, dot } from "@/lib/documents/vectors";

/*
 * The document vectors of the chosen embedding model, held in memory so a
 * search by meaning does not read every vector from the database.
 *
 * Each vector is kept as int8 with its own scale, a quarter of its Float32 size.
 * A search scans all of them in that form, takes the closest few hundred, and
 * scores those exactly from the stored Float32 vectors: the ranking it returns
 * is the exact one, the int8 copy only decides which vectors are worth reading.
 *
 * The database stays the record. Each document carries a revision that triggers
 * bump whenever its chunks or their vectors change, so every search first reads
 * the revisions (one small query) and reloads only the documents that changed.
 * Losing this index loses nothing; the next search builds it again.
 */

/** How many candidates the int8 scan hands to exact scoring. */
export const EXACT_CANDIDATES = 256;
/** How many vectors at most a search returns, closest first. */
export const SEMANTIC_RESULTS = 64;
/** Vectors read per query while loading, which bounds the memory a first load needs on the way. */
const LOAD_BATCH_CHUNKS = 4000;

type Block = {
  revision: number;
  ids: string[];
  dimensions: number;
  codes: Int8Array;
  scales: Float32Array;
  /** Vectors whose stored hash no longer matches their text; left out and built again by indexing. */
  stale: number;
  /** Vectors that cannot be read, or of another length than the rest of the document's. */
  invalid: number;
};
type Segment = { key: string; blocks: Map<string, Block>; syncing: Promise<Map<string, DocumentState>> | null };
type DocumentState = { collection: string | null };

const memory = globalThis as typeof globalThis & { documentVectorIndex?: { segment: Segment | null } };
const state = memory.documentVectorIndex ??= { segment: null };
const keyOf = (model: ModelRef) => `${model.providerId}\u0000${model.modelId}`;

function quantize(vector: Float32Array, codes: Int8Array, offset: number): number {
  let largest = 0;
  for (let index = 0; index < vector.length; index++) largest = Math.max(largest, Math.abs(vector[index]));
  const scale = largest / 127 || 1;
  for (let index = 0; index < vector.length; index++) codes[offset + index] = Math.round(vector[index] / scale);
  return scale;
}

async function loadBlocks(model: ModelRef, documents: Array<{ id: string; vectorRevision: number; filename: string; collection: string | null }>) {
  const rows = await db.documentChunk.findMany({
    where: { documentId: { in: documents.map(document => document.id) }, vector: { not: null }, embeddingModelProvider: model.providerId, embeddingModelId: model.modelId },
    select: { id: true, documentId: true, text: true, heading: true, vector: true, embeddingContextHash: true },
    orderBy: { id: "asc" },
  });
  const byDocument = new Map<string, typeof rows>();
  for (const row of rows) { const list = byDocument.get(row.documentId) ?? []; list.push(row); byDocument.set(row.documentId, list); }
  const blocks = new Map<string, Block>();
  for (const document of documents) {
    const list = byDocument.get(document.id) ?? [];
    const decoded: Array<{ id: string; vector: Float32Array }> = [];
    let stale = 0, invalid = 0, dimensions = 0;
    for (const row of list) {
      if (row.embeddingContextHash !== hashDocumentContent(documentEmbeddingText(row, document))) { stale++; continue; }
      const vector = decodeDocumentVector(row.vector);
      if (!vector || (dimensions && vector.length !== dimensions)) { invalid++; continue; }
      dimensions = vector.length;
      decoded.push({ id: row.id, vector });
    }
    const codes = new Int8Array(decoded.length * dimensions);
    const scales = new Float32Array(decoded.length);
    decoded.forEach((entry, index) => { scales[index] = quantize(entry.vector, codes, index * dimensions); });
    blocks.set(document.id, { revision: document.vectorRevision, ids: decoded.map(entry => entry.id), dimensions, codes, scales, stale, invalid });
  }
  return blocks;
}

/**
 * Brings the index up to date with the database for this model. The revisions
 * are read before the vectors, so a change landing in between makes the next
 * search reload that document again rather than keep an old copy.
 */
async function sync(model: ModelRef): Promise<{ segment: Segment; documents: Map<string, DocumentState> }> {
  const key = keyOf(model);
  if (state.segment?.key !== key) state.segment = { key, blocks: new Map(), syncing: null };
  const segment = state.segment;
  segment.syncing ??= (async () => {
    try {
      const documents = await db.knowledgeDocument.findMany({ select: { id: true, vectorRevision: true, filename: true, collection: true, _count: { select: { chunks: true } } } });
      const present = new Set(documents.map(document => document.id));
      for (const id of segment.blocks.keys()) if (!present.has(id)) segment.blocks.delete(id);
      const changed = documents.filter(document => segment.blocks.get(document.id)?.revision !== document.vectorRevision);
      let batch: typeof changed = [], size = 0;
      const flush = async () => {
        if (!batch.length) return;
        for (const [id, block] of await loadBlocks(model, batch)) segment.blocks.set(id, block);
        batch = []; size = 0;
      };
      for (const document of changed) {
        if (size && size + document._count.chunks > LOAD_BATCH_CHUNKS) await flush();
        batch.push(document); size += document._count.chunks;
      }
      await flush();
      return new Map(documents.map(document => [document.id, { collection: document.collection }]));
    } finally { segment.syncing = null; }
  })();
  return { segment, documents: await segment.syncing };
}

/** The bytes the index holds for its vectors, for measuring. */
export function documentVectorIndexBytes() {
  let bytes = 0;
  for (const block of state.segment?.blocks.values() ?? []) bytes += block.codes.byteLength + block.scales.byteLength;
  return bytes;
}

export type DocumentVectorCoverage = { ready: number; stale: number; invalid: number };
/** What the index holds per document for this model: usable vectors, and those left out and why. */
export async function documentVectorCoverage(model: ModelRef): Promise<Map<string, DocumentVectorCoverage>> {
  const { segment } = await sync(model);
  return new Map([...segment.blocks].map(([id, block]) => [id, { ready: block.ids.length, stale: block.stale, invalid: block.invalid }]));
}

export type VectorSearch = {
  results: Array<{ id: string; score: number }>;
  /** Usable vectors in the searched collections. */
  compatible: number;
  scanned: number;
  stale: number;
  /** Unreadable vectors and vectors of another length than the query's. */
  invalid: number;
};

/**
 * The chunks closest in meaning to a unit-length query vector, scored exactly,
 * closest first. Only positive similarities are returned; there is no fixed
 * threshold, since every model has its own scale.
 */
export async function searchDocumentVectors(input: { model: ModelRef; query: Float32Array; collections?: string[]; signal?: AbortSignal }): Promise<VectorSearch> {
  const { segment, documents } = await sync(input.model);
  input.signal?.throwIfAborted();
  const scope = input.collections?.length ? new Set(input.collections) : null;
  const query = input.query, dimensions = query.length;
  const outcome: VectorSearch = { results: [], compatible: 0, scanned: 0, stale: 0, invalid: 0 };
  // Candidates are gathered past the limit and trimmed in batches, which beats keeping a heap in JavaScript.
  let candidates: Array<{ id: string; score: number }> = [];
  let floor = 0;
  for (const [id, block] of segment.blocks) {
    const document = documents.get(id);
    if (!document || (scope && !scope.has(document.collection ?? ""))) continue;
    outcome.stale += block.stale;
    outcome.invalid += block.invalid;
    if (!block.ids.length) continue;
    // Another length than the query's: looked at and refused, so diagnostics say so instead of counting it usable.
    if (block.dimensions !== dimensions) { outcome.invalid += block.ids.length; outcome.scanned += block.ids.length; continue; }
    outcome.compatible += block.ids.length;
    const { codes, scales, ids } = block;
    for (let row = 0, offset = 0; row < ids.length; row++, offset += dimensions) {
      let sum = 0;
      for (let index = 0; index < dimensions; index++) sum += codes[offset + index] * query[index];
      const score = sum * scales[row];
      outcome.scanned++;
      if (score > floor) candidates.push({ id: ids[row], score });
    }
    if (candidates.length > EXACT_CANDIDATES * 8) {
      candidates.sort((a, b) => b.score - a.score);
      candidates = candidates.slice(0, EXACT_CANDIDATES);
      floor = Math.max(0, candidates.at(-1)!.score);
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  candidates = candidates.slice(0, EXACT_CANDIDATES);
  if (!candidates.length) return outcome;
  input.signal?.throwIfAborted();
  const exact = await db.documentChunk.findMany({
    where: { id: { in: candidates.map(candidate => candidate.id) }, embeddingModelProvider: input.model.providerId, embeddingModelId: input.model.modelId },
    select: { id: true, vector: true },
  });
  outcome.results = exact.flatMap(row => {
    const vector = decodeDocumentVector(row.vector);
    if (!vector || vector.length !== dimensions) return [];
    const score = dot(query, vector);
    return Number.isFinite(score) && score > 0 ? [{ id: row.id, score }] : [];
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, SEMANTIC_RESULTS);
  return outcome;
}

/** Drops what the index holds, for tests and for a restore that replaces the library. */
export function clearDocumentVectorIndex() {
  state.segment = null;
}
