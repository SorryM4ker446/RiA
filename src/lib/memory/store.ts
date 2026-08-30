import { db } from "@/db";
import { embedText } from "@/lib/ai/embedding";
import { Prisma } from "@prisma/client";
import { CONTEXT_MEMORY_POLICY, getMemorySearchCandidates, rankByScore } from "@/lib/memory/retrieval";

export type SaveMemoryInput = {
  userId: string;
  key: string;
  value: string;
  score?: number;
};

export type GetRelevantMemoriesInput = {
  userId: string;
  query: string;
  limit?: number;
};

export async function saveMemory(input: SaveMemoryInput) {
  const normalizedKey = input.key.trim();
  const normalizedValue = input.value.trim();

  if (!normalizedKey || !normalizedValue) {
    throw new Error("key and value are required");
  }

  // Best-effort embedding; falls back to null (keyword-only retrieval) on failure.
  const embedding = await embedText(`${normalizedKey} ${normalizedValue}`);

  return db.memory.upsert({
    where: { userId_key: { userId: input.userId, key: normalizedKey } },
    update: {
      value: normalizedValue,
      ...(input.score !== undefined ? { score: input.score } : {}),
      // Never retain an embedding for an old value when embedding the new text fails.
      embedding: embedding ?? Prisma.DbNull,
    },
    create: {
      userId: input.userId,
      key: normalizedKey,
      value: normalizedValue,
      score: input.score ?? 0.5,
      ...(embedding ? { embedding } : {}),
    },
  });
}

export async function getRelevantMemories(input: GetRelevantMemoriesInput) {
  const query = input.query.trim();
  if (!query) return [];

  const limit = input.limit ?? 5;
  const { candidates } = await getMemorySearchCandidates(input.userId, query, CONTEXT_MEMORY_POLICY);
  return rankByScore(candidates, (item) => item.relevance, limit).map(({ memory }) => ({
    id: memory.id, key: memory.key, value: memory.value, score: memory.score, updatedAt: memory.updatedAt,
  }));
}
