import { z } from "zod";
import { db } from "@/db";
import { cosineSimilarity, embedText, toEmbeddingVector } from "@/lib/ai/embedding";

export const searchKnowledgeInputSchema = z.strictObject({
  query: z.string().trim().max(2000).min(1, "query is required"),
  topK: z.number().int().min(1).max(8).optional().default(4),
});

export type SearchKnowledgeInput = z.infer<typeof searchKnowledgeInputSchema>;

export type SearchKnowledgeItem = {
  id: string;
  title: string;
  snippet: string;
  source: "memory" | "builtin";
  score: number;
};

export type SearchKnowledgeOutput = {
  query: string;
  total: number;
  results: SearchKnowledgeItem[];
};

const builtinKnowledgeBase = [
  {
    id: "builtin-memory",
    title: "Memory Module",
    content:
      "The system has short-term chat context and long-term memories stored in the memories table.",
  },
  {
    id: "builtin-chat-persistence",
    title: "Chat Persistence",
    content:
      "Chats are persisted in chats and messages tables. The frontend loads chat history from /api/conversations.",
  },
  {
    id: "builtin-tools",
    title: "Tool Calling",
    content:
      "Tools can be registered in route.ts and rendered on the frontend from message.parts with tool states.",
  },
];

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

function scoreText(queryTokens: string[], text: string): number {
  if (queryTokens.length === 0) return 0;
  const normalized = text.toLowerCase();
  const hits = queryTokens.filter((token) => normalized.includes(token)).length;
  return hits / queryTokens.length;
}

export async function searchKnowledge(
  userId: string,
  input: SearchKnowledgeInput,
): Promise<SearchKnowledgeOutput> {
  const query = input.query.trim();
  const topK = input.topK ?? 4;
  const queryTokens = tokenize(query);
  const queryEmbedding = await embedText(query);

  const memoryRows = await db.memory.findMany({
    where: {
      userId,
      NOT: [{ key: { startsWith: "tool:" } }],
    },
    orderBy: [{ updatedAt: "desc" }],
    take: 50,
  });

  const memoryResults: SearchKnowledgeItem[] = memoryRows.map((row) => {
    const keywordScore = scoreText(queryTokens, `${row.key} ${row.value}`);
    const semanticScore =
      queryEmbedding && row.embedding
        ? Math.max(0, cosineSimilarity(queryEmbedding, toEmbeddingVector(row.embedding)))
        : 0;
    const lexicalScore = Math.max(keywordScore, semanticScore * 0.85);

    return {
      id: row.id,
      title: row.key,
      snippet: row.value,
      source: "memory",
      score: lexicalScore + (row.score ?? 0) * 0.2,
    };
  });

  const builtinResults: SearchKnowledgeItem[] = builtinKnowledgeBase.map((item) => ({
    id: item.id,
    title: item.title,
    snippet: item.content,
    source: "builtin",
    score: scoreText(queryTokens, `${item.title} ${item.content}`),
  }));

  const ranked = [...memoryResults, ...builtinResults]
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((item) => ({
      ...item,
      score: Number(item.score.toFixed(3)),
    }));

  return {
    query,
    total: ranked.length,
    results: ranked,
  };
}
