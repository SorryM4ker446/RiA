import { db } from "@/db";
import { embedTextWithModel } from "@/lib/ai/embedding";
import { Prisma } from "@prisma/client";
import { CONTEXT_MEMORY_POLICY, getMemorySearchCandidates, rankByScore } from "@/lib/memory/retrieval";
import { recordWorkspaceEvent } from "@/lib/activity/events";

export type SaveMemoryInput = {
  key: string;
  value: string;
  score?: number;
  /**
   * Who is writing this. The assistant's own inferences are stored as
   * unconfirmed candidates: they are visible and editable, but they do not
   * enter the model's context until the user accepts them.
   */
  source?: "manual" | "assistant";
  /**
   * What happens when the key already holds different text. Editing a memory
   * replaces it; a new fact saved from a conversation keeps both, under a
   * numbered key, so it cannot silently overwrite an unrelated memory.
   */
  onConflict?: "replace" | "keep-both";
};

export type GetRelevantMemoriesInput = {
  query: string;
  limit?: number;
  /** Minimum keyword or semantic match before recency and manual weight count. */
  minMatch?: number;
  /** The previous user message, so a short follow-up still finds what it refers to. */
  followUp?: string;
  signal?: AbortSignal;
};

export async function saveMemory(input: SaveMemoryInput) {
  const normalizedKey = input.key.trim();
  const normalizedValue = input.value.trim();

  if (!normalizedKey || !normalizedValue) {
    throw new Error("key and value are required");
  }

  // Best-effort embedding; falls back to null (keyword-only retrieval) on failure.
  const { embedding, modelRef } = await embedTextWithModel(`${normalizedKey} ${normalizedValue}`);

  const source = input.source ?? "manual";
  const confirmed = source === "manual";

  // An inference the user never saw does not take the place of something they
  // accepted. Left alone, the update would replace the confirmed text with the
  // assistant's, relabel it as inferred, and leave it confirmed — so the
  // rejected candidate would keep entering the model's context in place of the
  // memory the user agreed to.
  return db.$transaction(async tx => {
  let key = normalizedKey;
  let existing = await tx.memory.findUnique({ where: { key } });
  if (input.onConflict === "keep-both" && existing && existing.value !== normalizedValue) {
    for (let suffix = 2; existing && existing.value !== normalizedValue; suffix++) {
      key = `${normalizedKey} (${suffix})`;
      existing = await tx.memory.findUnique({ where: { key } });
    }
  }
  if (!confirmed && existing?.confirmed) return existing;
  const saved = await tx.memory.upsert({
    where: { key },
    update: {
      value: normalizedValue,
      source,
      // Writing an entry by hand is also how a candidate gets accepted, so an
      // edit does not silently leave it waiting.
      confirmed: confirmed ? true : undefined,
      ...(input.score !== undefined ? { score: input.score } : {}),
      // Never retain an embedding for an old value when embedding the new text fails.
      embedding: embedding ?? Prisma.DbNull,
      embeddingModelId: embedding ? modelRef?.modelId : null,
      embeddingModelProvider: embedding ? modelRef?.providerId : null,
    },
    create: {
      key,
      value: normalizedValue,
      score: input.score ?? 0.5,
      source,
      confirmed,
      ...(embedding ? { embedding } : {}),
      embeddingModelId: embedding ? modelRef?.modelId : null,
      embeddingModelProvider: embedding ? modelRef?.providerId : null,
    },
  });
  if (confirmed && !existing?.confirmed) await recordWorkspaceEvent(tx, { kind: "memory.confirmed", entityId: saved.id, label: saved.key });
  return saved;
  });
}

export async function getRelevantMemories(input: GetRelevantMemoriesInput) {
  const query = input.query.trim();
  if (!query) return [];
  if (input.signal?.aborted) return [];

  const limit = input.limit ?? 5;
  const { candidates } = await getMemorySearchCandidates(query, CONTEXT_MEMORY_POLICY, input.signal, input.followUp);
  const relevant = input.minMatch ? candidates.filter((item) => item.match >= input.minMatch!) : candidates;
  const used = rankByScore(relevant, (item) => item.relevance, limit).map(({ memory }) => ({
    id: memory.id, key: memory.key, value: memory.value, score: memory.score, updatedAt: memory.updatedAt,
  }));
  // Recorded so the interface can say which memories actually did something,
  // instead of a user having to guess whether an entry is still relevant.
  if (used.length > 0) {
    await db.memory.updateMany({ where: { id: { in: used.map((entry) => entry.id) } }, data: { lastUsedAt: new Date() } }).catch(() => {
      // Bookkeeping must never be the reason a turn fails.
    });
  }
  return used;
}
