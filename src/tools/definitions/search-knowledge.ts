import { getEntrySearchCandidates, SEARCH_ENTRY_POLICY, rankByScore } from "@/lib/knowledge/entry-retrieval";
import { z } from "zod";
import type { RetrievalPolicy } from "@/lib/assistants/schema";
import type { DocumentDiagnostics } from "@/lib/documents/diagnostics";
import { retrieveDocuments } from "@/lib/documents/retrieval";
import { documentSourceSchema, documentSourceUrl, type DocumentSource } from "@/lib/documents/types";

export const searchKnowledgeInputSchema = z.strictObject({
  query: z.string().trim().max(2000).min(1, "query is required"),
  topK: z.number().int().min(1).max(8).optional().default(4),
});

export type SearchKnowledgeInput = z.infer<typeof searchKnowledgeInputSchema>;

export type SearchKnowledgeItem = {
  id: string;
  title: string;
  snippet: string;
  source: "entry" | "document";
  reference?: DocumentSource;
  url?: string;
  score: number;
};

export type SearchKnowledgeOutput = {
  query: string;
  total: number;
  results: SearchKnowledgeItem[];
  diagnostics: DocumentDiagnostics;
};


export async function searchKnowledge(
  input: SearchKnowledgeInput,
  options: { collections?: string[]; policy?: RetrievalPolicy; signal?: AbortSignal } = {},
): Promise<SearchKnowledgeOutput> {
  const query = input.query.trim();
  const topK = input.topK ?? 4;
  // An entry belongs to no topic, so a search kept to chosen topics leaves entries out.
  const { candidates } = options.collections?.length
    ? { candidates: [] as Awaited<ReturnType<typeof getEntrySearchCandidates>>["candidates"] }
    : await getEntrySearchCandidates(query, SEARCH_ENTRY_POLICY, options.signal);
  const memoryResults: SearchKnowledgeItem[] = candidates.map(({ memory: row, relevance }) => ({
    id: row.id, title: row.key, snippet: row.value, source: "entry", score: relevance,
  }));


  const retrieved = await retrieveDocuments(query, topK, options.collections, options.signal, options.policy);
  const documentResults: SearchKnowledgeItem[] = retrieved.sources.map(item => ({ id: item.chunkId, title: item.filename, snippet: item.snippet, source: "document", score: item.score, reference: documentSourceSchema.parse(item), url: documentSourceUrl(item) }));
  // Imported evidence retains its fused order and adjacent context. Uncalibrated
  // memory weights must not crowd it out.
  const ranked = [...documentResults, ...rankByScore(memoryResults, item => item.score, topK)].slice(0, topK)
    .map((item) => ({
      ...item,
      score: Number(item.score.toFixed(3)),
    }));

  return {
    query,
    diagnostics: retrieved.diagnostics,
    total: ranked.length,
    results: ranked,
  };
}
