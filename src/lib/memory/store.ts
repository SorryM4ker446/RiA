import { db } from "@/db";
import { cosineSimilarity, embedText, toEmbeddingVector } from "@/lib/ai/embedding";

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

function keywordOverlapScore(memoryText: string, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const overlap = queryTokens.filter((token) => memoryText.includes(token)).length;
  return overlap / queryTokens.length;
}

function computeRelevance(params: {
  memory: {
    key: string;
    value: string;
    score: number | null;
    embedding: unknown;
    updatedAt: Date;
  };
  queryTokens: string[];
  queryEmbedding: number[] | null;
}): number {
  const { memory, queryTokens, queryEmbedding } = params;
  const memoryText = `${memory.key} ${memory.value}`.toLowerCase();

  const keywordScore = keywordOverlapScore(memoryText, queryTokens);
  const memoryEmbedding = toEmbeddingVector(memory.embedding);
  const semanticScore =
    queryEmbedding && memoryEmbedding
      ? Math.max(0, cosineSimilarity(queryEmbedding, memoryEmbedding))
      : 0;

  // Either a lexical hit or a semantic hit counts; semantic matches are
  // slightly discounted so exact keyword hits still rank first.
  const lexicalScore = Math.max(keywordScore, semanticScore * 0.85);

  const daysAgo = (Date.now() - memory.updatedAt.getTime()) / (1000 * 60 * 60 * 24);
  const recencyBoost = Math.max(0, 1 - daysAgo / 30) * 0.2;
  const manualScoreBoost = (memory.score ?? 0) * 0.4;

  return lexicalScore + recencyBoost + manualScoreBoost;
}

export async function saveMemory(input: SaveMemoryInput) {
  const normalizedKey = input.key.trim();
  const normalizedValue = input.value.trim();

  if (!normalizedKey || !normalizedValue) {
    throw new Error("key and value are required");
  }

  // Best-effort embedding; falls back to null (keyword-only retrieval) on failure.
  const embedding = await embedText(`${normalizedKey} ${normalizedValue}`);

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
        ...(embedding ? { embedding } : {}),
      },
    });
  }

  return db.memory.create({
    data: {
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
  const queryTokens = tokenize(query);
  const queryEmbedding = await embedText(query);

  const memories = await db.memory.findMany({
    where: { userId: input.userId },
    orderBy: [{ updatedAt: "desc" }],
    take: 100,
  });

  const ranked: RankedMemory[] = memories
    .map((memory) => ({
      id: memory.id,
      key: memory.key,
      value: memory.value,
      score: memory.score,
      updatedAt: memory.updatedAt,
      relevance: computeRelevance({
        memory: {
          key: memory.key,
          value: memory.value,
          score: memory.score,
          embedding: memory.embedding,
          updatedAt: memory.updatedAt,
        },
        queryTokens,
        queryEmbedding,
      }),
    }))
    .filter((memory) => memory.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);

  return ranked.map(({ relevance: _relevance, ...memory }) => memory);
}
