import { Prisma } from "@prisma/client";
import { db } from "@/db";
import { embedTextsWithModel } from "@/lib/ai/embedding";
import { getModelPreferences } from "@/lib/models/preferences";
import { modelRefKey } from "@/lib/models/preferences-schema";

/**
 * Vectors are only comparable within the space that produced them, so a
 * memory embedded by one model is not evidence about another. Changing the
 * embedding model therefore leaves earlier memories without usable semantic
 * recall — they keep working through keyword scoring, which is why this is not
 * an error, but it is a silent downgrade the user deserves to see and be able
 * to undo.
 *
 * Rebuilding is explicit and bounded: it is never triggered automatically,
 * because each pass is a paid request per memory.
 */

const BATCH_SIZE = 50;
const MAX_ROWS_PER_RUN = 1000;

export async function currentEmbeddingRef() {
  const preferences = await getModelPreferences();
  return preferences.embedding;
}

export async function staleEmbeddingSummary() {
  const ref = await currentEmbeddingRef();
  const rows = await db.memory.findMany({ select: { id: true, embeddingModelId: true, embeddingModelProvider: true } });
  const stale = rows.filter(row => !row.embeddingModelId
    || (ref ? row.embeddingModelId !== ref.modelId || row.embeddingModelProvider !== ref.providerId : true));
  return { total: rows.length, stale: stale.length, embedding: ref ? modelRefKey(ref) : null };
}

export async function reindexStaleEmbeddings(): Promise<{ reindexed: number; remaining: number; embedding: string | null }> {
  const ref = await currentEmbeddingRef();
  const summary = await staleEmbeddingSummary();
  if (!ref) return { reindexed: 0, remaining: summary.stale, embedding: null };
  if (summary.stale === 0) return { reindexed: 0, remaining: 0, embedding: modelRefKey(ref) };

  const rows = await db.memory.findMany({ orderBy: { updatedAt: "desc" }, take: MAX_ROWS_PER_RUN, select: { id: true, key: true, value: true, embeddingModelId: true, embeddingModelProvider: true } });
  const targets = rows.filter(row => !row.embeddingModelId || row.embeddingModelId !== ref.modelId || row.embeddingModelProvider !== ref.providerId);

  let reindexed = 0;
  for (let index = 0; index < targets.length; index += BATCH_SIZE) {
    const batch = targets.slice(index, index + BATCH_SIZE);
    const { embeddings, modelRef } = await embedTextsWithModel(batch.map(row => `${row.key} ${row.value}`));
    await db.$transaction(batch.map((row, offset) => {
      const embedding = embeddings[offset];
      // A failed batch leaves the row without a vector rather than storing one
      // for a model that did not produce it. Keyword scoring still finds it.
      if (!embedding || !modelRef) {
        return db.memory.update({ where: { id: row.id }, data: { embedding: Prisma.DbNull, embeddingModelId: null, embeddingModelProvider: null } });
      }
      reindexed += 1;
      return db.memory.update({ where: { id: row.id }, data: { embedding, embeddingModelId: modelRef.modelId, embeddingModelProvider: modelRef.providerId } });
    }));
  }

  return { reindexed, remaining: (await staleEmbeddingSummary()).stale, embedding: modelRefKey(ref) };
}
