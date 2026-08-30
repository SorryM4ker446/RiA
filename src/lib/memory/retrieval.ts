import { db } from "@/db";
import { cosineSimilarity, embedText, toEmbeddingVector } from "@/lib/ai/embedding";

type RankingPolicy = {
  candidateLimit: number;
  excludeToolMemories: boolean;
  manualWeight: number;
  recencyWeight: number;
};

// Context recall and explicit knowledge search retain their existing selection rules.
export const CONTEXT_MEMORY_POLICY: RankingPolicy = {
  candidateLimit: 100, excludeToolMemories: false, manualWeight: 0.4, recencyWeight: 0.2,
};
export const KNOWLEDGE_MEMORY_POLICY: RankingPolicy = {
  candidateLimit: 50, excludeToolMemories: true, manualWeight: 0.2, recencyWeight: 0,
};

export function tokenizeQuery(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/g).map((token) => token.trim()).filter(Boolean);
}

export function keywordScore(queryTokens: string[], text: string): number {
  if (!queryTokens.length) return 0;
  const normalized = text.toLowerCase();
  return queryTokens.filter((token) => normalized.includes(token)).length / queryTokens.length;
}

export function scoreMemory(
  memory: { key: string; value: string; score: number | null; embedding: unknown; updatedAt: Date },
  queryTokens: string[],
  queryEmbedding: number[] | null,
  policy: RankingPolicy,
  now = Date.now(),
): number {
  const lexical = keywordScore(queryTokens, `${memory.key} ${memory.value}`);
  const semantic = Math.max(0, cosineSimilarity(queryEmbedding, toEmbeddingVector(memory.embedding)));
  const daysAgo = (now - memory.updatedAt.getTime()) / (1000 * 60 * 60 * 24);
  const recency = Math.max(0, 1 - daysAgo / 30) * policy.recencyWeight;
  return Math.max(lexical, semantic * 0.85) + recency + (memory.score ?? 0) * policy.manualWeight;
}

export function rankByScore<T>(items: T[], score: (item: T) => number, limit: number): T[] {
  return items.filter((item) => score(item) > 0).sort((a, b) => score(b) - score(a)).slice(0, limit);
}

export async function getMemorySearchCandidates(userId: string, query: string, policy: RankingPolicy) {
  const queryTokens = tokenizeQuery(query);
  const queryEmbedding = await embedText(query);
  const rows = await db.memory.findMany({
    where: {
      userId,
      ...(policy.excludeToolMemories ? { NOT: [{ key: { startsWith: "tool:" } }] } : {}),
    },
    orderBy: [{ updatedAt: "desc" }],
    take: policy.candidateLimit,
  });
  return {
    queryTokens,
    candidates: rows.map((memory) => ({ memory, relevance: scoreMemory(memory, queryTokens, queryEmbedding, policy) })),
  };
}
