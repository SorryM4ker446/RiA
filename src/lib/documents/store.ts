import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { buildDocumentChunks, DOCUMENT_INDEX_VERSION, hashDocumentContent } from "@/lib/documents/chunks";
import { DOCUMENT_LIMITS, documentPagesSchema, type DocumentPage } from "@/lib/documents/types";
import { tokenizeQuery } from "@/lib/memory/retrieval";
import { ApiError } from "@/lib/server/api-error";

export const documentSummarySelect = {
  id: true, filename: true, format: true, byteSize: true, characterCount: true,
  indexVersion: true, indexedAt: true, createdAt: true, updatedAt: true,
  _count: { select: { chunks: true } },
} as const;

type DocumentInput = { filename: string; format: string; byteSize: number; pages: DocumentPage[] };
export async function indexDocument(userId: string, input: DocumentInput, expected?: { id: string; contentHash: string }) {
  const pages = documentPagesSchema.parse(input.pages);
  const characterCount = pages.reduce((sum, page) => sum + page.text.length, 0);
  if (characterCount > DOCUMENT_LIMITS.characters) throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: "文档不能超过十万字符。" });
  const prepared = buildDocumentChunks(pages).map(chunk => ({ ...chunk, terms: tokenizeQuery(`${input.filename} ${chunk.text}`).filter(term => term.length <= 100) }));
  const contentHash = hashDocumentContent(JSON.stringify(pages));
  return db.$transaction(async tx => {
    const existing = await tx.knowledgeDocument.findUnique({ where: { userId_filename: { userId, filename: input.filename } }, include: { chunks: true } });
    if (expected && (!existing || existing.id !== expected.id || existing.contentHash !== expected.contentHash)) {
      throw new ApiError({ code: "CONFLICT", message: "文档已被修改或删除，请刷新后重试。" });
    }
    if (!existing && await tx.knowledgeDocument.count({ where: { userId } }) >= DOCUMENT_LIMITS.documentsPerUser) {
      throw new ApiError({ code: "CONFLICT", message: "每个用户最多保存 100 份文档，请先删除不再需要的文档。" });
    }
    if (existing?.contentHash === contentHash && existing.indexVersion === DOCUMENT_INDEX_VERSION && !expected) {
      return { document: await tx.knowledgeDocument.findUniqueOrThrow({ where: { id: existing.id }, select: documentSummarySelect }), change: "unchanged", added: 0, removed: 0, retained: existing.chunks.length };
    }
    const data = { filename: input.filename, format: input.format, byteSize: input.byteSize, pages, contentHash, characterCount, indexVersion: DOCUMENT_INDEX_VERSION, indexedAt: new Date() };
    const document = existing
      ? await tx.knowledgeDocument.update({ where: { id: existing.id }, data })
      : await tx.knowledgeDocument.create({ data: { ...data, userId } });
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
    return {
      document: await tx.knowledgeDocument.findUniqueOrThrow({ where: { id: document.id }, select: documentSummarySelect }),
      change: expected ? "reindexed" : existing ? "updated" : "created", added: created.length, removed: obsolete.length, retained: retained.length,
    };
  });
}

export async function getDocument(userId: string, id: string) {
  const document = await db.knowledgeDocument.findFirst({ where: { id, userId }, select: { ...documentSummarySelect, chunks: { orderBy: { ordinal: "asc" }, select: { id: true, text: true, ordinal: true, pageNumber: true } } } });
  if (!document) throw new ApiError({ code: "NOT_FOUND", message: "文档不存在或已删除。" });
  return document;
}

export async function reindexDocument(userId: string, id: string) {
  const document = await db.knowledgeDocument.findFirst({ where: { id, userId } });
  if (!document) throw new ApiError({ code: "NOT_FOUND", message: "文档不存在或已删除。" });
  return indexDocument(userId, { ...document, pages: documentPagesSchema.parse(document.pages) }, { id, contentHash: document.contentHash });
}

export async function deleteDocument(userId: string, id: string) {
  const result = await db.knowledgeDocument.deleteMany({ where: { id, userId } });
  if (!result.count) throw new ApiError({ code: "NOT_FOUND", message: "文档不存在或已删除。" });
}
