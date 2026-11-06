import { db } from "@/db";
import { cosineSimilarity, embedTextWithModel, toEmbeddingVector } from "@/lib/ai/embedding";
import type { ModelRef } from "@/lib/models/preferences-schema";

type RankingPolicy = {
  excludeToolMemories: boolean;
  manualWeight: number;
  recencyWeight: number;
};

/** The local API's lookup of entries, which keeps its own ranking. */
export const LOOKUP_ENTRY_POLICY: RankingPolicy = {
  excludeToolMemories: false, manualWeight: 0.4, recencyWeight: 0.2,
};
export const SEARCH_ENTRY_POLICY: RankingPolicy = {
  excludeToolMemories: true, manualWeight: 0.2, recencyWeight: 0,
};
/**
 * Matching this many of the query's words is a full keyword match. A long
 * message is not diluted below the threshold by words a memory cannot share,
 * while a single shared word in a longer message still is not enough.
 */
const KEYWORD_SATURATION = 4;

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
  return queryTokens.filter((token) => normalized.includes(token)).length / Math.min(queryTokens.length, KEYWORD_SATURATION);
}

/**
 * How well a memory matches the query itself, before recency and manual weight: the share of
 * the query's words it contains, and its similarity in meaning on the embedding model's own scale.
 */
export function memoryMatch(
  memory: { key: string; value: string; embedding: unknown; embeddingModelId?: string | null; embeddingModelProvider?: string | null },
  queryTokens: string[],
  queryEmbedding: number[] | null,
  queryModelRef?: ModelRef | null,
): { lexical: number; semantic: number } {
  const lexical = keywordScore(queryTokens, `${memory.key} ${memory.value}`);
  // A vector is only comparable with one written by the same provider and model.
  const sameSpace = Boolean(queryModelRef && memory.embeddingModelId === queryModelRef.modelId && memory.embeddingModelProvider === queryModelRef.providerId);
  const semantic = Math.max(0, sameSpace ? cosineSimilarity(queryEmbedding, toEmbeddingVector(memory.embedding)) : 0);
  return { lexical, semantic };
}

export function scoreMemory(
  memory: { key: string; value: string; score: number | null; embedding: unknown; embeddingModelId?: string | null; embeddingModelProvider?: string | null; updatedAt: Date },
  queryTokens: string[],
  queryEmbedding: number[] | null,
  policy: RankingPolicy,
  now = Date.now(),
  queryModelRef?: ModelRef | null,
): number {
  const lexical = keywordScore(queryTokens, `${memory.key} ${memory.value}`);
  // A vector is only comparable with one written by the same provider and model.
  // A row with no recorded provider is left out rather than assumed: comparing
  // it would mean comparing vectors from spaces that may not match.
  const sameSpace = Boolean(queryModelRef && memory.embeddingModelId === queryModelRef.modelId && memory.embeddingModelProvider === queryModelRef.providerId);
  const semantic = Math.max(0, sameSpace ? cosineSimilarity(queryEmbedding, toEmbeddingVector(memory.embedding)) : 0);
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

/**
 * Scores every confirmed entry against the query. All of them are compared: an entry
 * that is old, or that shares no word with the query, is still found by meaning.
 */
export async function getEntrySearchCandidates(query: string, policy: RankingPolicy, signal?: AbortSignal, embedQuery?: () => ReturnType<typeof embedTextWithModel>) {
  const { embedding, modelRef } = await (embedQuery ? embedQuery() : embedTextWithModel(query, signal));
  const queryTokens = tokenizeQuery(query);
  // An entry the user has not accepted is not evidence. Candidates stay visible
  // in the interface but never reach a model until they are confirmed.
  const scope = {
    confirmed: true,
    ...(policy.excludeToolMemories ? { NOT: [{ key: { startsWith: "tool:" } }] } : {}),
  };
  if (!queryTokens.length && !embedding) return { queryTokens, candidates: [] };
  const candidates = await db.memory.findMany({ where: scope, orderBy: [{ updatedAt: "desc" }, { id: "desc" }] });
  const now = Date.now();
  return {
    queryTokens,
    candidates: candidates.map((memory) => ({
      memory,
      match: memoryMatch(memory, queryTokens, embedding, modelRef),
      relevance: scoreMemory(memory, queryTokens, embedding, policy, now, modelRef),
    })),
  };
}
