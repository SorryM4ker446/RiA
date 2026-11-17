import { db } from "@/db";
import { Prisma } from "@prisma/client";
import { embedTextsWithModel } from "@/lib/ai/embedding";
import { getModelPreferences, modelInLibrary } from "@/lib/models/preferences";
import { getModelProvider } from "@/lib/models/providers";
import type { ModelRef } from "@/lib/models/preferences-schema";
import { ApiError } from "@/lib/server/api-error";
import { describeProviderFailure, providerNameOf, providerStatusOf } from "@/lib/models/provider-errors";
import { documentEmbeddingText } from "@/lib/documents/lexical";
import { hashDocumentContent } from "@/lib/documents/chunks";
import { decodeDocumentVector, encodeDocumentVector, MAX_VECTOR_DIMENSIONS } from "@/lib/documents/vectors";
import { documentVectorCoverage } from "@/lib/documents/vector-index";

import { t } from "@/lib/locale";
export const DOCUMENT_EMBEDDING_BATCH = 32;
/** A provider's embedding as RiA stores it, or null when it is not a usable vector. */
export function validDocumentVector(value: unknown): number[] | null {
  if (!Array.isArray(value) || !value.length || value.length > MAX_VECTOR_DIMENSIONS || value.some(item => typeof item !== "number" || !Number.isFinite(item))) return null;
  return value.some(item => item !== 0) ? value as number[] : null;
}
export async function selectedDocumentEmbeddingModel(): Promise<ModelRef | null> {
  const ref = (await getModelPreferences()).embedding;
  return ref && getModelProvider(ref.providerId).isConfigured() && await modelInLibrary("embedding", ref) ? ref : null;
}
/**
 * Loads the chosen model's vectors into the search index ahead of the first
 * search, which otherwise waits for it: seconds for a library of a hundred
 * thousand chunks. Reads only; nothing is embedded or written.
 */
export async function warmDocumentSearch() {
  const modelRef = await selectedDocumentEmbeddingModel();
  if (modelRef) await documentVectorCoverage(modelRef);
}

/**
 * How many chunks of each document can be searched by meaning with the chosen
 * model, and why the others cannot: built for another model, stale (their text
 * changed since), or unreadable. Read from the search index, which checks the
 * actual vector and its contextual hash, rather than from non-empty columns.
 */
export async function semanticCoverage(ids: string[]) {
  const modelRef = await selectedDocumentEmbeddingModel();
  const counts = new Map<string, number>();
  const details = new Map<string, { stale: number; differentModel: number; invalid: number }>();
  if (!modelRef || !ids.length) return { modelRef, counts, details };
  const wanted = new Set(ids);
  for (const [id, coverage] of await documentVectorCoverage(modelRef)) {
    if (!wanted.has(id)) continue;
    if (coverage.ready) counts.set(id, coverage.ready);
    if (coverage.stale || coverage.invalid) details.set(id, { stale: coverage.stale, differentModel: 0, invalid: coverage.invalid });
  }
  const others = await db.documentChunk.groupBy({
    by: ["documentId"],
    where: { documentId: { in: ids }, vector: { not: null }, NOT: { embeddingModelProvider: modelRef.providerId, embeddingModelId: modelRef.modelId } },
    _count: { _all: true },
  });
  for (const row of others) details.set(row.documentId, { ...(details.get(row.documentId) ?? { stale: 0, differentModel: 0, invalid: 0 }), differentModel: row._count._all });
  return { modelRef, counts, details };
}

const activeIndexes = (globalThis as typeof globalThis & { documentSemanticIndexes?: Set<string> }).documentSemanticIndexes ??= new Set<string>();
export async function indexDocumentEmbeddings(id: string, expectedHash: string, expectedModel: ModelRef, signal?: AbortSignal) {
  if (activeIndexes.has(id)) throw new ApiError({ code: "CONFLICT", message: t("server.documents.indexBusy") });
  activeIndexes.add(id);
  try {
    signal?.throwIfAborted();
    const modelRef = await selectedDocumentEmbeddingModel();
    if (!modelRef) throw new ApiError({ code: "CONFIGURATION_ERROR", message: t("server.documents.chooseEmbedding") });
    if (modelRef.providerId !== expectedModel.providerId || modelRef.modelId !== expectedModel.modelId) throw new ApiError({ code: "CONFLICT", message: t("server.documents.embeddingChanged") });
    const document = await db.knowledgeDocument.findUnique({ where: { id }, include: { chunks: { orderBy: { ordinal: "asc" } } } });
    if (!document) throw new ApiError({ code: "NOT_FOUND", message: t("errors.documentDeleted") });
    if (document.contentHash !== expectedHash) throw new ApiError({ code: "CONFLICT", message: t("errors.documentUpdatedStartIndexingAgain") });
    const pending = document.chunks.filter(chunk => !decodeDocumentVector(chunk.vector) || chunk.embeddingModelId !== modelRef.modelId || chunk.embeddingModelProvider !== modelRef.providerId || chunk.embeddingContextHash !== hashDocumentContent(documentEmbeddingText(chunk, document)));
    const batch = pending.slice(0, DOCUMENT_EMBEDDING_BATCH);
    if (!batch.length) return { indexed: document.chunks.length, total: document.chunks.length, remaining: 0, modelRef };
    const timeout = AbortSignal.timeout(30_000);
    const embeddingSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const texts = batch.map(chunk => documentEmbeddingText(chunk, document));
    const result = await embedTextsWithModel(texts, embeddingSignal);
    signal?.throwIfAborted();
    // A provider that refused says why: a rejected key or a dropped model is a setting to fix.
    if (!result.modelRef && providerStatusOf(result.error) !== undefined && !timeout.aborted) throw describeProviderFailure(result.error, providerNameOf(modelRef.providerId));
    if (timeout.aborted) throw new ApiError({ code: "TIMEOUT", message: t("server.documents.embeddingTimeout") });
    const vectors = result.embeddings.map(encodeDocumentVector);
    if (result.modelRef?.providerId !== modelRef.providerId || result.modelRef?.modelId !== modelRef.modelId) throw new ApiError({ code: "UPSTREAM_FAILED", message: t("server.documents.embeddingFailed") });
    if (vectors.length !== batch.length || vectors.some(vector => !vector || vector.byteLength !== vectors[0]?.byteLength)) throw new ApiError({ code: "UPSTREAM_FAILED", message: t("server.documents.embeddingInvalid") });
    const selected = await selectedDocumentEmbeddingModel();
    if (selected?.providerId !== modelRef.providerId || selected.modelId !== modelRef.modelId) throw new ApiError({ code: "CONFLICT", message: t("server.documents.embeddingChanged") });
    await db.$transaction(async tx => {
      signal?.throwIfAborted();
      const current = await tx.knowledgeDocument.findUnique({ where: { id } });
      if (!current || current.contentHash !== expectedHash || current.collection !== document.collection || current.indexVersion !== document.indexVersion) throw new ApiError({ code: "CONFLICT", message: t("server.documents.staleDocument") });
      for (let index = 0; index < batch.length; index++) {
        const changed = await tx.documentChunk.updateMany({ where: { id: batch[index].id, text: batch[index].text, heading: batch[index].heading }, data: {
          vector: vectors[index]!, embedding: Prisma.DbNull, embeddingModelId: modelRef.modelId, embeddingModelProvider: modelRef.providerId, embeddingContextHash: hashDocumentContent(texts[index]),
        } });
        if (changed.count !== 1) throw new ApiError({ code: "CONFLICT", message: t("server.documents.staleChunk") });
      }
      signal?.throwIfAborted();
    });
    return { indexed: document.chunks.length - pending.length + batch.length, total: document.chunks.length, remaining: pending.length - batch.length, modelRef };
  } finally { activeIndexes.delete(id); }
}
