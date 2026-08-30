import { getMemorySearchCandidates, keywordScore, KNOWLEDGE_MEMORY_POLICY, rankByScore } from "@/lib/memory/retrieval";
import { z } from "zod";
import { searchDocuments } from "@/lib/documents/retrieval";
import { documentSourceSchema, type DocumentSource } from "@/lib/documents/types";

export const searchKnowledgeInputSchema = z.strictObject({
  query: z.string().trim().max(2000).min(1, "query is required"),
  topK: z.number().int().min(1).max(8).optional().default(4),
});

export type SearchKnowledgeInput = z.infer<typeof searchKnowledgeInputSchema>;

export type SearchKnowledgeItem = {
  id: string;
  title: string;
  snippet: string;
  source: "memory" | "builtin" | "document";
  reference?: DocumentSource;
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

export async function searchKnowledge(
  userId: string,
  input: SearchKnowledgeInput,
): Promise<SearchKnowledgeOutput> {
  const query = input.query.trim();
  const topK = input.topK ?? 4;
  const { queryTokens, candidates } = await getMemorySearchCandidates(userId, query, KNOWLEDGE_MEMORY_POLICY);
  const memoryResults: SearchKnowledgeItem[] = candidates.map(({ memory: row, relevance }) => ({
    id: row.id, title: row.key, snippet: row.value, source: "memory", score: relevance,
  }));

  const builtinResults: SearchKnowledgeItem[] = builtinKnowledgeBase.map((item) => ({
    id: item.id,
    title: item.title,
    snippet: item.content,
    source: "builtin",
    score: keywordScore(queryTokens, `${item.title} ${item.content}`),
  }));

  const documentResults: SearchKnowledgeItem[] = (await searchDocuments(userId, query, topK)).map(item => ({ id: item.chunkId, title: item.filename, snippet: item.snippet, source: "document", score: item.score, reference: documentSourceSchema.parse(item) }));
  const ranked = rankByScore([...documentResults, ...memoryResults, ...builtinResults], (item) => item.score, topK)
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
