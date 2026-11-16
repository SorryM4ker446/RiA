import { db } from "@/db";
import { DOCUMENT_INDEX_VERSION } from "@/lib/documents/chunks";
import { indexDocumentEmbeddings, selectedDocumentEmbeddingModel, semanticCoverage } from "@/lib/documents/semantic";
import { reindexDocument } from "@/lib/documents/store";
import { reindexStaleEmbeddings } from "@/lib/knowledge/entry-reindex";
import { ApiError, normalizeApiError } from "@/lib/server/api-error";
import { t } from "@/lib/locale";
import { runBackgroundDataOperation } from "@/lib/server/data-operations";
import { describeProviderFailure, providerNameOf } from "@/lib/models/provider-errors";

/**
 * Keeps the knowledge base searchable by meaning without anyone having to ask. While an
 * embedding model is chosen, what has no current vector gets one, a batch at a time:
 * documents first, then knowledge entries. Choosing the model is the consent to send
 * the knowledge base's content to it.
 *
 * Saved vectors are the record of progress, so an interrupted run loses nothing and the
 * next one carries on. A failure stops the run rather than trying every document against
 * a provider that is refusing, and does not retry on its own until something asks again.
 */
/** Why the last run stopped, as the person should read it, and where they can fix it when that is a setting. */
type IndexingFailure = { message: string; fix?: "apiKeys" | "models" };
const state = globalThis as typeof globalThis & { documentIndexing?: { running: Promise<void> | null; again: boolean; failed: string | null; failure?: IndexingFailure | null } };
const work = state.documentIndexing ??= { running: null, again: false, failed: null, failure: null };

/** Moved or re-imported meanwhile, or built by hand at the same moment: that document's turn, not a failure. */
const skippable = (error: unknown) => error instanceof ApiError && (error.code === "CONFLICT" || error.code === "NOT_FOUND");

async function indexPending() {
  const modelRef = await selectedDocumentEmbeddingModel();
  if (!modelRef) return;
  // Vectors belong to chunks, so an index from an older version is rebuilt first. No model is involved.
  const outdated = await db.knowledgeDocument.findMany({ where: { NOT: { indexVersion: DOCUMENT_INDEX_VERSION } }, select: { id: true } });
  for (const { id } of outdated) {
    await runBackgroundDataOperation(() => reindexDocument(id)).catch(error => { if (!skippable(error)) throw error; });
  }
  const documents = await db.knowledgeDocument.findMany({ select: { id: true, contentHash: true, _count: { select: { chunks: true } } } });
  const { counts } = await semanticCoverage(documents.map(document => document.id));
  for (const document of documents) {
    if ((counts.get(document.id) ?? 0) >= document._count.chunks) continue;
    for (;;) {
      const current = await selectedDocumentEmbeddingModel();
      if (current?.providerId !== modelRef.providerId || current.modelId !== modelRef.modelId) { work.again = true; return; }
      const result = await runBackgroundDataOperation(() => indexDocumentEmbeddings(document.id, document.contentHash, modelRef)).catch(error => {
        if (skippable(error)) return null;
        throw error;
      });
      if (!result?.remaining) break;
    }
  }
  // Entries keep vectors of their own in the same space. A pass that writes none while
  // some are missing means the provider refused, so the run stops like a document's would.
  for (;;) {
    const current = await selectedDocumentEmbeddingModel();
    if (current?.providerId !== modelRef.providerId || current.modelId !== modelRef.modelId) { work.again = true; return; }
    const entries = await runBackgroundDataOperation(() => reindexStaleEmbeddings());
    if (!entries.remaining) break;
    if (!entries.reindexed) throw entries.error !== undefined ? describeProviderFailure(entries.error, providerNameOf(modelRef.providerId)) : new ApiError({ code: "UPSTREAM_FAILED", message: t("lib.documents.entriesNotEmbedded") });
  }
}

/** Starts the work if it is not running; a request during a run gets one more pass, for what it brought. */
export function scheduleDocumentIndexing() {
  if (work.running) { work.again = true; return; }
  work.failed = null;
  work.failure = null;
  work.running = (async () => {
    try {
      do { work.again = false; await indexPending(); } while (work.again);
    } catch (error) {
      // A rejected key or a model the provider dropped is a setting to fix, and says which.
      const described = normalizeApiError(describeProviderFailure(error, providerNameOf((await selectedDocumentEmbeddingModel().catch(() => null))?.providerId)));
      const fix = (described.details as { fix?: unknown } | undefined)?.fix;
      work.failed = described.code;
      work.failure = { message: described.message, ...(fix === "apiKeys" || fix === "models" ? { fix } : {}) };
      try { console.error("documents.auto-index.failed", work.failed); } catch { /* already harmless */ }
    } finally { work.running = null; }
  })();
}

/** Opening the library picks up what a restart left, but does not keep retrying a failure. */
export function resumeDocumentIndexing(pending: boolean) {
  if (pending && !work.running && !work.failed) scheduleDocumentIndexing();
}

export const documentIndexingStatus = () => ({ running: Boolean(work.running), failed: work.failed, ...(work.failure ? { failure: work.failure } : {}) });
export const documentIndexingSettled = () => work.running ?? Promise.resolve();
