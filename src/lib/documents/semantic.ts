import { db } from "@/db";
import { Prisma } from "@prisma/client";
import { embedTextsWithModel } from "@/lib/ai/embedding";
import { getModelPreferences, modelInLibrary } from "@/lib/models/preferences";
import { getModelProvider } from "@/lib/models/providers";
import type { ModelRef } from "@/lib/models/preferences-schema";
import { ApiError } from "@/lib/server/api-error";
import { documentEmbeddingText } from "@/lib/documents/lexical";
import { hashDocumentContent } from "@/lib/documents/chunks";

export const DOCUMENT_EMBEDDING_BATCH = 32;
export function validDocumentVector(value: unknown): number[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 4096 || value.some(item => typeof item !== "number" || !Number.isFinite(item))) return null;
  return value.some(item => item !== 0) ? value as number[] : null;
}
export async function selectedDocumentEmbeddingModel(): Promise<ModelRef | null> {
  const ref = (await getModelPreferences()).embedding;
  return ref && getModelProvider(ref.providerId).isConfigured() && await modelInLibrary("embedding", ref) ? ref : null;
}
export async function semanticCoverage(ids: string[]) {
  const modelRef = await selectedDocumentEmbeddingModel();
  const counts = new Map<string, number>();
  const details = new Map<string, { stale: number; differentModel: number; invalid: number }>();
  let after: string | undefined;
  if (modelRef && ids.length) while (true) {
    const rows = await db.documentChunk.findMany({ where: { documentId: { in: ids }, embedding: { not: Prisma.AnyNull }, ...(after ? { id: { gt: after } } : {}) },
      take: 64, orderBy: { id: "asc" }, include: { document: { select: { filename: true, collection: true } } } });
    for (const row of rows) {
      const info = details.get(row.documentId) ?? { stale: 0, differentModel: 0, invalid: 0 };
      if (row.embeddingModelProvider !== modelRef.providerId || row.embeddingModelId !== modelRef.modelId) info.differentModel++;
      else if (!validDocumentVector(row.embedding)) info.invalid++;
      else if (row.embeddingContextHash !== hashDocumentContent(documentEmbeddingText(row, row.document))) info.stale++;
      else counts.set(row.documentId, (counts.get(row.documentId) ?? 0) + 1);
      details.set(row.documentId, info);
    }
    if (rows.length < 64) break;
    after = rows.at(-1)!.id;
  }
  return { modelRef, counts, details };
}

const activeIndexes = (globalThis as typeof globalThis & { documentSemanticIndexes?: Set<string> }).documentSemanticIndexes ??= new Set<string>();
export async function indexDocumentEmbeddings(id: string, expectedHash: string, expectedModel: ModelRef, signal?: AbortSignal) {
  if (activeIndexes.has(id)) throw new ApiError({ code: "CONFLICT", message: "该文档正在构建语义索引。" });
  activeIndexes.add(id);
  try {
    signal?.throwIfAborted();
    const modelRef = await selectedDocumentEmbeddingModel();
    if (!modelRef) throw new ApiError({ code: "CONFIGURATION_ERROR", message: "请先在模型设置中选择并配置 embedding 模型。" });
    if (modelRef.providerId !== expectedModel.providerId || modelRef.modelId !== expectedModel.modelId) throw new ApiError({ code: "CONFLICT", message: "Embedding 模型已改变，请重新开始构建。" });
    const document = await db.knowledgeDocument.findUnique({ where: { id }, include: { chunks: { orderBy: { ordinal: "asc" } } } });
    if (!document) throw new ApiError({ code: "NOT_FOUND", message: "文档已删除。" });
    if (document.contentHash !== expectedHash) throw new ApiError({ code: "CONFLICT", message: "文档已更新，请重新开始构建。" });
    const pending = document.chunks.filter(chunk => !validDocumentVector(chunk.embedding) || chunk.embeddingModelId !== modelRef.modelId || chunk.embeddingModelProvider !== modelRef.providerId || chunk.embeddingContextHash !== hashDocumentContent(documentEmbeddingText(chunk, document)));
    const batch = pending.slice(0, DOCUMENT_EMBEDDING_BATCH);
    if (!batch.length) return { indexed: document.chunks.length, total: document.chunks.length, remaining: 0, modelRef };
    const timeout = AbortSignal.timeout(30_000);
    const embeddingSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const texts = batch.map(chunk => documentEmbeddingText(chunk, document));
    const result = await embedTextsWithModel(texts, embeddingSignal);
    signal?.throwIfAborted();
    if (timeout.aborted) throw new ApiError({ code: "TIMEOUT", message: "向量生成超时；已完成的索引可继续使用。" });
    const vectors = result.embeddings.map(validDocumentVector);
    if (result.modelRef?.providerId !== modelRef.providerId || result.modelRef?.modelId !== modelRef.modelId) throw new ApiError({ code: "UPSTREAM_FAILED", message: "向量模型调用失败或配置改变；本批索引未写入。" });
    if (vectors.length !== batch.length || vectors.some(vector => !vector || vector.length !== vectors[0]?.length)) throw new ApiError({ code: "UPSTREAM_FAILED", message: "向量模型返回了无效数据；本批索引未写入。" });
    const selected = await selectedDocumentEmbeddingModel();
    if (selected?.providerId !== modelRef.providerId || selected.modelId !== modelRef.modelId) throw new ApiError({ code: "CONFLICT", message: "Embedding 模型已改变，请重新开始构建。" });
    await db.$transaction(async tx => {
      signal?.throwIfAborted();
      const current = await tx.knowledgeDocument.findUnique({ where: { id } });
      if (!current || current.contentHash !== expectedHash || current.collection !== document.collection || current.indexVersion !== document.indexVersion) throw new ApiError({ code: "CONFLICT", message: "文档已更新或删除；过期索引未写入。" });
      for (let index = 0; index < batch.length; index++) {
        const changed = await tx.documentChunk.updateMany({ where: { id: batch[index].id, text: batch[index].text, heading: batch[index].heading }, data: {
          embedding: vectors[index]!, embeddingModelId: modelRef.modelId, embeddingModelProvider: modelRef.providerId, embeddingContextHash: hashDocumentContent(texts[index]),
        } });
        if (changed.count !== 1) throw new ApiError({ code: "CONFLICT", message: "片段已改变；过期索引未写入。" });
      }
      signal?.throwIfAborted();
    });
    return { indexed: document.chunks.length - pending.length + batch.length, total: document.chunks.length, remaining: pending.length - batch.length, modelRef };
  } finally { activeIndexes.delete(id); }
}
