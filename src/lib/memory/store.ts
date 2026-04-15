import { db } from "@/db";

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

type RankedMemory = {
  id: string;
  key: string;
  value: string;
  score: number | null;
  updatedAt: Date;
  relevance: number;
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

function computeRelevance(memory: {
  key: string;
  value: string;
  score: number | null;
  updatedAt: Date;
}, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;

  const memoryText = `${memory.key} ${memory.value}`.toLowerCase();
  const overlap = queryTokens.filter((token) => memoryText.includes(token)).length;
  const overlapScore = overlap / queryTokens.length;

  const daysAgo = (Date.now() - memory.updatedAt.getTime()) / (1000 * 60 * 60 * 24);
  const recencyBoost = Math.max(0, 1 - daysAgo / 30) * 0.2;
  const manualScoreBoost = (memory.score ?? 0) * 0.4;

  return overlapScore + recencyBoost + manualScoreBoost;
}

export async function saveMemory(input: SaveMemoryInput) {
  const normalizedKey = input.key.trim();
  const normalizedValue = input.value.trim();

  if (!normalizedKey || !normalizedValue) {
    throw new Error("key and value are required");
  }

  const existing = await db.memory.findFirst({
    where: {
      userId: input.userId,
      key: normalizedKey,
    },
  });

  if (existing) {
    return db.memory.update({
      where: { id: existing.id },
      data: {
        value: normalizedValue,
        score: input.score ?? existing.score ?? 0.5,
        updatedAt: new Date(),
      },
    });
  }

  return db.memory.create({
    data: {
      userId: input.userId,
      key: normalizedKey,
      value: normalizedValue,
      score: input.score ?? 0.5,
    },
  });
}

export async function getRelevantMemories(input: GetRelevantMemoriesInput) {
  const query = input.query.trim();
  if (!query) return [];

  const limit = input.limit ?? 5;
  const queryTokens = tokenize(query);

  const memories = await db.memory.findMany({
    where: { userId: input.userId },
    orderBy: [{ updatedAt: "desc" }],
    take: 100,
  });

  const ranked = memories
    .map<RankedMemory>((memory) => ({
      ...memory,
      relevance: computeRelevance(memory, queryTokens),
    }))
    .filter((memory) => memory.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);

  return ranked.map(({ relevance: _relevance, ...memory }) => memory);
}

