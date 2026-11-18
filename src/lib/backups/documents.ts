import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { z } from "zod";
import { db } from "@/db";
import { DOCUMENT_LIMITS, documentPagesSchema } from "@/lib/documents/types";
import { providerIdSchema } from "@/lib/models/preferences-schema";

/*
 * A document in a backup archive: its pages, its chunks and their vectors, in
 * one gzip block of its own after the media files, rather than inside the JSON
 * manifest. A large library's text and vectors would not fit in a manifest a
 * reader can parse, and a vector costs an embedding call to make again.
 *
 * Block layout before compression: the ASCII magic "RIAD", a version (uint32),
 * the length of the JSON part (uint32), the JSON part, then every vector as
 * little-endian Float32, back to back. The JSON names each chunk's slice.
 */

const MAGIC = Buffer.from("RIAD");
const FORMAT = 1;
/** The most one document's block may expand to: its text twice (pages and chunks) and the longest vectors. */
export const DOCUMENT_CONTENT_EXPANDED_BYTES = 1024 * 1024 * 1024;
const zip = promisify(gzip), unzip = promisify(gunzip);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const count = z.number().int().nonnegative();

const chunkSchema = z.strictObject({
  id, chunkKey: z.string().max(200), ordinal: count, pageNumber: count.nullable(), text: z.string().max(2 * 1024 * 1024),
  heading: z.string().max(600).nullable(), tokenCount: count,
  vector: z.strictObject({ providerId: providerIdSchema, modelId: z.string().max(200), contextHash: z.string().max(128), offset: count, length: count }).nullable(),
});
const payloadSchema = z.strictObject({ pages: documentPagesSchema, chunks: z.array(chunkSchema).max(DOCUMENT_LIMITS.chunks) });
export type DocumentContent = z.infer<typeof payloadSchema> & { vectors: Buffer };

/** Reads one document's pages, chunks and vectors, a page of chunks at a time, and packs them. */
export async function packDocumentContent(documentId: string): Promise<Buffer> {
  const { pages } = await db.knowledgeDocument.findUniqueOrThrow({ where: { id: documentId }, select: { pages: true } });
  const chunks: z.infer<typeof chunkSchema>[] = [];
  const vectors: Buffer[] = [];
  let offset = 0;
  for (let after: string | undefined; ;) {
    const rows = await db.documentChunk.findMany({
      where: { documentId, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: "asc" }, take: 2000,
      select: { id: true, chunkKey: true, ordinal: true, pageNumber: true, text: true, heading: true, tokenCount: true, vector: true, embeddingModelProvider: true, embeddingModelId: true, embeddingContextHash: true },
    });
    for (const row of rows) {
      const kept = row.vector && row.embeddingModelProvider && row.embeddingModelId && row.embeddingContextHash ? Buffer.from(row.vector) : null;
      chunks.push({
        id: row.id, chunkKey: row.chunkKey, ordinal: row.ordinal, pageNumber: row.pageNumber, text: row.text, heading: row.heading, tokenCount: row.tokenCount,
        vector: kept ? { providerId: row.embeddingModelProvider as z.infer<typeof providerIdSchema>, modelId: row.embeddingModelId!, contextHash: row.embeddingContextHash!, offset, length: kept.byteLength } : null,
      });
      if (kept) { vectors.push(kept); offset += kept.byteLength; }
    }
    if (rows.length < 2000) break;
    after = rows.at(-1)!.id;
  }
  const json = Buffer.from(JSON.stringify({ pages, chunks }));
  const head = Buffer.alloc(12);
  MAGIC.copy(head); head.writeUInt32BE(FORMAT, 4); head.writeUInt32BE(json.length, 8);
  return zip(Buffer.concat([head, json, ...vectors]), { level: 6 });
}

export const contentDigest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Unpacks and checks one document's block; any inconsistency is an invalid archive. */
export async function unpackDocumentContent(bytes: Buffer): Promise<DocumentContent> {
  const frame = await unzip(bytes, { maxOutputLength: DOCUMENT_CONTENT_EXPANDED_BYTES });
  if (frame.length < 12 || !frame.subarray(0, 4).equals(MAGIC) || frame.readUInt32BE(4) !== FORMAT) throw new Error("Unknown document content");
  const length = frame.readUInt32BE(8);
  if (12 + length > frame.length) throw new Error("Truncated document content");
  const payload = payloadSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(12, 12 + length))));
  const vectors = frame.subarray(12 + length);
  const ids = new Set<string>(), keys = new Set<string>();
  for (const chunk of payload.chunks) {
    if (ids.has(chunk.id) || keys.has(chunk.chunkKey)) throw new Error("Duplicate chunk");
    ids.add(chunk.id); keys.add(chunk.chunkKey);
    if (chunk.vector && (chunk.vector.length % 4 || chunk.vector.offset + chunk.vector.length > vectors.length)) throw new Error("Vector out of range");
  }
  return { ...payload, vectors };
}
