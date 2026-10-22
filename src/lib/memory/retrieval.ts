import { db } from "@/db";
import { cosineSimilarity, embedTextWithModel, toEmbeddingVector } from "@/lib/ai/embedding";
import type { ModelRef } from "@/lib/models/preferences-schema";

type RankingPolicy = {
  excludeToolMemories: boolean;
  manualWeight: number;
  recencyWeight: number;
};

// Context recall and explicit knowledge search retain their existing selection rules.
export const CONTEXT_MEMORY_POLICY: RankingPolicy = {
  excludeToolMemories: false, manualWeight: 0.4, recencyWeight: 0.2,
};
/** Chat context only includes memories that match the request itself this well. */
export const CONTEXT_MEMORY_MIN_MATCH = 0.3;
export const KNOWLEDGE_MEMORY_POLICY: RankingPolicy = {
  excludeToolMemories: true, manualWeight: 0.2, recencyWeight: 0,
};
/**
 * A message this short ("and that one?") is read as a follow-up: the previous
 * user message is matched too, ranked a little lower. A longer message stands
 * on its own, so changing the subject does not carry the old subject's memories.
 */
export const FOLLOW_UP_MAX_WORDS = 3;
export const FOLLOW_UP_WEIGHT = 0.8;
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

/** How well a memory matches the query itself, before recency and manual weight. */
export function memoryMatch(
  memory: { key: string; value: string; embedding: unknown; embeddingModelId?: string | null; embeddingModelProvider?: string | null },
  queryTokens: string[],
  queryEmbedding: number[] | null,
  queryModelRef?: ModelRef | null,
): number {
  const lexical = keywordScore(queryTokens, `${memory.key} ${memory.value}`);
  // A vector is only comparable with one written by the same provider and model.
  const sameSpace = Boolean(queryModelRef && memory.embeddingModelId === queryModelRef.modelId && memory.embeddingModelProvider === queryModelRef.providerId);
  const semantic = Math.max(0, sameSpace ? cosineSimilarity(queryEmbedding, toEmbeddingVector(memory.embedding)) : 0);
  return Math.max(lexical, semantic * 0.85);
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

async function searchQuery(text: string, signal?: AbortSignal) {
  const { embedding, modelRef } = await embedTextWithModel(text, signal);
  return { tokens: tokenizeQuery(text), embedding, modelRef };
}

/**
 * Scores every confirmed memory against the query and, when given, the
 * message it follows up on. All of them are compared: a memory that is old,
 * or that shares no word with the query, is still found by meaning.
 */
export async function getMemorySearchCandidates(query: string, policy: RankingPolicy, signal?: AbortSignal, followUp?: string) {
  const isFollowUp = Boolean(followUp?.trim()) && tokenizeQuery(query).length <= FOLLOW_UP_MAX_WORDS;
  const [primary, previous] = await Promise.all([searchQuery(query, signal), isFollowUp ? searchQuery(followUp!, signal) : null]);
  const queryTokens = primary.tokens;
  // An entry the user has not accepted is not evidence. Candidates stay visible
  // in the interface but never reach a model until they are confirmed.
  const scope = {
    confirmed: true,
    ...(policy.excludeToolMemories ? { NOT: [{ key: { startsWith: "tool:" } }] } : {}),
  };
  const searchable = (search: Awaited<ReturnType<typeof searchQuery>> | null) => Boolean(search && (search.tokens.length || search.embedding));
  if (!searchable(primary) && !searchable(previous)) return { queryTokens, candidates: [] };
  const candidates = await db.memory.findMany({ where: scope, orderBy: [{ updatedAt: "desc" }, { id: "desc" }] });
  const now = Date.now();
  return {
    queryTokens,
    candidates: candidates.map((memory) => {
      const follow = previous ? {
        match: FOLLOW_UP_WEIGHT * memoryMatch(memory, previous.tokens, previous.embedding, previous.modelRef),
        relevance: FOLLOW_UP_WEIGHT * scoreMemory(memory, previous.tokens, previous.embedding, policy, now, previous.modelRef),
      } : { match: 0, relevance: 0 };
      return {
        memory,
        match: Math.max(memoryMatch(memory, primary.tokens, primary.embedding, primary.modelRef), follow.match),
        relevance: Math.max(scoreMemory(memory, primary.tokens, primary.embedding, policy, now, primary.modelRef), follow.relevance),
      };
    }),
  };
}
