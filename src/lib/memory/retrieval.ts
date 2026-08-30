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

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
const stopWords = new Set(["的", "了", "和", "是", "在", "我", "你", "请", "帮", "帮我", "一下", "什么", "如何", "关于", "怎么", "查询", "查找", "a", "an", "the", "is", "of", "to", "and"]);
const normalizeText = (text: string) => text.normalize("NFKC").toLowerCase();

export function tokenizeQuery(text: string): string[] {
  return [...new Set([...segmenter.segment(normalizeText(text))]
    .filter((part) => part.isWordLike && !stopWords.has(part.segment))
    .map((part) => part.segment))];
}

export function keywordScore(queryTokens: string[], text: string): number {
  if (!queryTokens.length) return 0;
  const normalized = normalizeText(text);
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
  if (lexical === 0 && semantic === 0) return 0;
  const daysAgo = (now - memory.updatedAt.getTime()) / (1000 * 60 * 60 * 24);
  const recency = Math.max(0, 1 - daysAgo / 30) * policy.recencyWeight;
  return Math.max(lexical, semantic * 0.85) + recency + (memory.score ?? 0) * policy.manualWeight;
}

export function rankByScore<T>(items: T[], score: (item: T) => number, limit: number): T[] {
  return items.map((item, index) => ({ item, index, score: score(item) }))
    .filter((entry) => Number.isFinite(entry.score) && entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit).map((entry) => entry.item);
}

export async function getMemorySearchCandidates(userId: string, query: string, policy: RankingPolicy) {
  const queryTokens = tokenizeQuery(query);
  const queryEmbedding = await embedText(query);
  const scope = { userId, ...(policy.excludeToolMemories ? { NOT: [{ key: { startsWith: "tool:" } }] } : {}) };
  if (!queryTokens.length && !queryEmbedding) return { queryTokens, candidates: [] };
  const rows = await db.memory.findMany({
    where: scope,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: policy.candidateLimit,
  });
  const lexicalRows = queryTokens.length ? await db.memory.findMany({
    where: { ...scope, OR: queryTokens.slice(0, 16).flatMap((token) => [{ key: { contains: token } }, { value: { contains: token } }]) },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: policy.candidateLimit,
  }) : [];
  const candidates = [...new Map([...rows, ...lexicalRows].map((row) => [row.id, row])).values()]
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const now = Date.now();
  return {
    queryTokens,
    candidates: candidates.map((memory) => ({ memory, relevance: scoreMemory(memory, queryTokens, queryEmbedding, policy, now) })),
  };
}
