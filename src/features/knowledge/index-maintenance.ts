import type { DocumentSummary } from "./document-client";
import { documentRequest, DocumentRequestError } from "./document-client";

export type IndexProgress = { id: string; filename: string; status: "waiting" | "indexing" | "complete" | "failed" | "paused" | "cancelled"; indexed: number; total: number; error?: string };

/** One explicit, bounded operation. Resume reads persisted batches; never retries writes. */
export async function maintainDocumentIndexes(documents: DocumentSummary[], signal: AbortSignal, publish: (items: IndexProgress[]) => void,
  request: typeof documentRequest = documentRequest) {
  const items: IndexProgress[] = documents.map(document => ({ id: document.id, filename: document.filename, status: "waiting", indexed: document.semantic?.indexed ?? 0, total: document._count.chunks }));
  const emit = () => publish(items.map(item => ({ ...item })));
  let requests = 0;
  emit();
  try {
    for (const [index, document] of documents.entries()) {
      signal.throwIfAborted(); const item = items[index]; const modelRef = document.semantic?.modelRef;
      if (!modelRef) { item.status = "failed"; item.error = "请先选择并配置 embedding 模型。"; emit(); continue; }
      if (item.indexed === item.total && document.semantic?.lexicalCurrent !== false) { item.status = "complete"; emit(); continue; }
      item.status = "indexing"; emit();
      try {
        // Refresh local table chunks before embedding old document indices.
        if (document.semantic?.lexicalCurrent === false) {
          item.status = "paused"; item.error = "请先对该文档执行本地重新索引，再继续语义构建。"; emit(); continue;
        }
        for (let batch = 0; batch < 8; batch++) {
          signal.throwIfAborted();
          if (requests === 12) { item.status = "paused"; item.error = "本轮已达到 12 次请求上限；保存的批次可继续。"; emit(); return items; }
          requests++;
          const progress = await request<{ indexed: number; total: number; remaining: number }>(`/api/documents/${document.id}/embeddings`, {
            method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true, contentHash: document.contentHash, modelRef }),
          });
          signal.throwIfAborted(); item.indexed = progress.indexed; item.total = progress.total;
          if (!progress.remaining) { item.status = "complete"; break; }
          emit();
        }
        if (item.status === "indexing") { item.status = "paused"; item.error = "本轮文档批次已结束，保存的进度可继续。"; }
      } catch (error) {
        signal.throwIfAborted();
        item.status = error instanceof DocumentRequestError && error.status === 429 ? "paused" : "failed";
        item.error = error instanceof Error ? error.message : "索引失败。";
        if (error instanceof DocumentRequestError && error.retryAfter) item.error += ` 请在 ${error.retryAfter} 秒后主动继续。`;
        if (item.status === "paused" || error instanceof DocumentRequestError && error.status === 409) { emit(); return items; }
      }
      emit();
    }
  } catch (error) {
    if (!signal.aborted) throw error;
    for (const item of items) if (item.status === "waiting" || item.status === "indexing") item.status = "cancelled";
    emit();
  }
  return items;
}
