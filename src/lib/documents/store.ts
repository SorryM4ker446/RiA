import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { t } from "@/lib/locale";
import { buildDocumentChunks, DOCUMENT_INDEX_VERSION, hashDocumentContent } from "@/lib/documents/chunks";
import { DOCUMENT_LIMITS, documentPagesSchema, type DocumentPage } from "@/lib/documents/types";
import { tokenizeQuery } from "@/lib/memory/retrieval";
import { ApiError } from "@/lib/server/api-error";
import { recordWorkspaceEvent } from "@/lib/activity/events";

export const documentSummarySelect = {
  id: true, filename: true, collection: true, format: true, byteSize: true, characterCount: true,
  indexVersion: true, indexedAt: true, createdAt: true, updatedAt: true,
  _count: { select: { chunks: true } },
} as const;

type DocumentInput = { filename: string; collection?: string | null; format: string; byteSize: number; pages: DocumentPage[] };
export async function indexDocument(input: DocumentInput, expected?: { id: string; contentHash: string }) {
  const pages = documentPagesSchema.parse(input.pages);
  const characterCount = pages.reduce((sum, page) => sum + page.text.length, 0);
  if (characterCount > DOCUMENT_LIMITS.characters) throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: t("lib.documents.charLimit") });
  const prepared = buildDocumentChunks(pages).map(chunk => ({ ...chunk, terms: tokenizeQuery(`${input.filename} ${chunk.text}`).filter(term => term.length <= 100) }));
  const contentHash = hashDocumentContent(JSON.stringify(pages));
  return db.$transaction(async tx => {
    const existing = await tx.knowledgeDocument.findUnique({ where: { filename: input.filename }, include: { chunks: true } });
    if (expected && (!existing || existing.id !== expected.id || existing.contentHash !== expected.contentHash)) {
      throw new ApiError({ code: "CONFLICT", message: t("lib.documents.modifiedOrDeleted") });
    }
    if (!existing && await tx.knowledgeDocument.count({ where: {} }) >= DOCUMENT_LIMITS.documentsPerUser) {
      throw new ApiError({ code: "CONFLICT", message: t("lib.documents.tooManyDocuments") });
    }
    // Unchanged content skips the re-chunking, but only when nothing else about
    // the document changed either. The collection is part of what the request
    // asked for: importing the same file into a different topic used to answer
    // "unchanged" and leave the document in the old one, so the move was
    // silently dropped while the interface reported success.
    if (existing?.contentHash === contentHash && existing.indexVersion === DOCUMENT_INDEX_VERSION && !expected
      && (existing.collection ?? null) === (input.collection ?? null)) {
      return { document: await tx.knowledgeDocument.findUniqueOrThrow({ where: { id: existing.id }, select: documentSummarySelect }), change: "unchanged", added: 0, removed: 0, retained: existing.chunks.length };
    }
    const data = { filename: input.filename, collection: input.collection ?? null, format: input.format, byteSize: input.byteSize, pages, contentHash, characterCount, indexVersion: DOCUMENT_INDEX_VERSION, indexedAt: new Date() };
    const document = existing
      ? await tx.knowledgeDocument.update({ where: { id: existing.id }, data })
      : await tx.knowledgeDocument.create({ data });
    const old = new Map((existing?.chunks ?? []).map(chunk => [chunk.chunkKey, chunk]));
    const next = new Set(prepared.map(chunk => chunk.chunkKey));
    const obsolete = (existing?.chunks ?? []).filter(chunk => !next.has(chunk.chunkKey));
    if (obsolete.length) await tx.documentChunk.deleteMany({ where: { id: { in: obsolete.map(chunk => chunk.id) } } });
    const created = prepared.filter(chunk => !old.has(chunk.chunkKey)).map(chunk => ({ ...chunk, id: randomUUID(), documentId: document.id }));
    if (created.length) await tx.documentChunk.createMany({ data: created.map(({ terms: _terms, ...chunk }) => chunk) });
    const retained = prepared.filter(chunk => old.has(chunk.chunkKey));
    for (const chunk of retained) {
      const previous = old.get(chunk.chunkKey)!;
      if (previous.ordinal !== chunk.ordinal) await tx.documentChunk.update({ where: { id: previous.id }, data: { ordinal: chunk.ordinal } });
    }
    const rebuild = Boolean(expected) || (existing && existing.indexVersion !== DOCUMENT_INDEX_VERSION);
    if (rebuild) await tx.documentTerm.deleteMany({ where: { chunk: { documentId: document.id } } });
    const indexed = rebuild ? prepared.map(chunk => ({ ...chunk, id: old.get(chunk.chunkKey)?.id ?? created.find(item => item.chunkKey === chunk.chunkKey)!.id })) : created;
    const terms = indexed.flatMap(chunk => chunk.terms.map(term => ({ chunkId: chunk.id, term })));
    // Keep parameter batches bounded; the enclosing transaction preserves the previous index on failure.
    for (let offset = 0; offset < terms.length; offset += 500) await tx.documentTerm.createMany({ data: terms.slice(offset, offset + 500) });
    if (!expected && (!existing || existing.contentHash !== contentHash || existing.collection !== document.collection)) {
      await recordWorkspaceEvent(tx, { kind: existing ? "document.updated" : "document.imported", entityId: document.id, label: document.filename });
    }
    return {
      document: await tx.knowledgeDocument.findUniqueOrThrow({ where: { id: document.id }, select: documentSummarySelect }),
      change: expected ? "reindexed" : existing ? "updated" : "created", added: created.length, removed: obsolete.length, retained: retained.length,
    };
  });
}

export async function getDocument(id: string) {
  const document = await db.knowledgeDocument.findFirst({ where: { id }, select: { ...documentSummarySelect, chunks: { orderBy: { ordinal: "asc" }, select: { id: true, text: true, ordinal: true, pageNumber: true } } } });
  if (!document) throw new ApiError({ code: "NOT_FOUND", message: t("lib.documents.notFound") });
  return document;
}

export async function reindexDocument(id: string) {
  const document = await db.knowledgeDocument.findFirst({ where: { id } });
  if (!document) throw new ApiError({ code: "NOT_FOUND", message: t("lib.documents.notFound") });
  return indexDocument({ ...document, pages: documentPagesSchema.parse(document.pages) }, { id, contentHash: document.contentHash });
}

export async function deleteDocument(id: string) {
  const result = await db.knowledgeDocument.deleteMany({ where: { id } });
  if (!result.count) throw new ApiError({ code: "NOT_FOUND", message: t("lib.documents.notFound") });
}
