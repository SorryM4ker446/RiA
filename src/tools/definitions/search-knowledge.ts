import { getEntrySearchCandidates, SEARCH_ENTRY_POLICY, rankByScore } from "@/lib/knowledge/entry-retrieval";
import { z } from "zod";
import { embedTextWithModel } from "@/lib/ai/embedding";
import type { DocumentDiagnostics } from "@/lib/documents/diagnostics";
import { documentEmbeddingQuery, retrieveDocuments } from "@/lib/documents/retrieval";
import { documentSourceSchema, documentSourceUrl, type DocumentSource } from "@/lib/documents/types";

/**
 * Results when the model does not ask for a number. A quarter of the places go to the
 * paragraphs around the best hits, so at four only three passages were ranked hits, and a
 * fourth-ranked answer was lost; six keeps five.
 */
const DEFAULT_TOP_K = 6;

export const searchKnowledgeInputSchema = z.strictObject({
  query: z.string().trim().max(2000).min(1, "query is required"),
  topK: z.number().int().min(1).max(8).optional().default(DEFAULT_TOP_K),
});

export type SearchKnowledgeInput = z.infer<typeof searchKnowledgeInputSchema>;

/** A document result carries its text in `reference`; an entry, which has none, in `snippet`. */
export type SearchKnowledgeItem = {
  id: string;
  title: string;
  snippet?: string;
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
  /** What the model should know about how far to trust an empty or thin result. */
  note?: string;
};

/** The share of the query's words an entry must contain to hold a place by keywords alone. */
const ENTRY_PLACE_KEYWORDS = 0.3;
const QUERY_EMBEDDING_TIMEOUT_MS = 12_000;

/**
 * Says what an empty or thin result means. Without it "nothing found" reads the same
 * whether the library lacks the answer or this search could only match exact words.
 */
function searchNote(diagnostics: DocumentDiagnostics): string | undefined {
  if (diagnostics.outcome === "empty-library") return "No documents are available to this search.";
  if (diagnostics.semantic === "failed") return "Search by meaning failed this time, so this is keyword matching only. If it misses, search again with words the documents are likely to use.";
  if (diagnostics.semantic === "not-configured" || diagnostics.semantic === "unindexed") return "Search by meaning is not available yet, so this is keyword matching only. If it misses, search again with words the documents are likely to use.";
  if (diagnostics.semantic === "ready" && diagnostics.compatibleVectors < diagnostics.corpusChunks) return "Search by meaning covers only part of the documents so far; the rest match by keyword only.";
  return undefined;
}

export async function searchKnowledge(
  input: SearchKnowledgeInput,
  options: { collections?: string[]; signal?: AbortSignal } = {},
): Promise<SearchKnowledgeOutput> {
  const query = input.query.trim();
  const topK = input.topK ?? DEFAULT_TOP_K;
  // One query vector serves documents and entries: each call is a billed request.
  let embedded: ReturnType<typeof embedTextWithModel> | undefined;
  const embedQuery = () => {
    const timeout = AbortSignal.timeout(QUERY_EMBEDDING_TIMEOUT_MS);
    return embedded ??= embedTextWithModel(documentEmbeddingQuery(query), options.signal ? AbortSignal.any([options.signal, timeout]) : timeout);
  };
  // An entry belongs to no topic, so a search kept to chosen topics leaves entries out.
  const { candidates } = options.collections?.length
    ? { candidates: [] as Awaited<ReturnType<typeof getEntrySearchCandidates>>["candidates"] }
    : await getEntrySearchCandidates(query, SEARCH_ENTRY_POLICY, options.signal, embedQuery);
  const entries = rankByScore(candidates, item => item.relevance, topK);

  const retrieved = await retrieveDocuments(query, topK, options.collections, options.signal, undefined, embedQuery);
  const documentResults: SearchKnowledgeItem[] = retrieved.sources.map(item => ({ id: item.chunkId, title: item.filename, source: "document", score: item.score, reference: documentSourceSchema.parse(item), url: documentSourceUrl(item) }));
  const entryResult = ({ memory: row, relevance }: (typeof candidates)[number]): SearchKnowledgeItem => ({ id: row.id, title: row.key, snippet: row.value, source: "entry", score: relevance });
  // Documents keep their fused order and adjacent context, and entry scores are not on
  // their scale, so neither can rank the other. Matching entries keep a place of their
  // own instead: a saved fact must not vanish because several passages matched as well.
  // By meaning, an entry matches when it is as close as the documents that made the list:
  // that is the same model's scale, whatever its absolute numbers.
  const documentSimilarity = retrieved.sources.flatMap(item => item.semanticScore ? [item.semanticScore] : []);
  const closeEnough = documentSimilarity.length ? Math.min(...documentSimilarity) : Number.POSITIVE_INFINITY;
  const placed = entries.filter(item => item.match.lexical >= ENTRY_PLACE_KEYWORDS || item.match.semantic >= closeEnough).slice(0, Math.max(1, Math.floor(topK / 4)));
  const spare = entries.filter(item => !placed.includes(item));
  const room = topK - placed.length;
  const ranked = [...documentResults.slice(0, room), ...placed.map(entryResult), ...spare.map(entryResult)].slice(0, topK)
    .map(item => ({ ...item, score: Number(item.score.toFixed(3)) }));
  const note = searchNote(retrieved.diagnostics);

  return {
    query,
    diagnostics: retrieved.diagnostics,
    total: ranked.length,
    results: ranked,
    ...(note ? { note } : {}),
  };
}
