import type { DocumentDiagnostics } from "./diagnostics";
import { documentQueryTokens } from "./retrieval";
import type { DocumentSource } from "./types";

/** Evidence this strong is added to a request without the model asking for it. */
export const AUTOMATIC_EVIDENCE = { semanticScore: 0.5, termCoverage: 0.6 } as const;

/**
 * Which retrieved evidence enters a request on its own.
 *
 * When the user scoped the conversation's knowledge, or the model cannot search
 * for itself, everything retrieved is supplied as before. Otherwise only strong
 * matches are: a weak keyword overlap, such as "build" in a coding request, is
 * left to the searchKnowledge tool instead of steering every answer. Neighbor
 * excerpts follow their anchor.
 */
export function selectAutomaticEvidence(
  retrieved: { sources: (DocumentSource & { score?: number })[]; diagnostics: DocumentDiagnostics },
  query: string,
  mode: { userScoped: boolean; canSearch: boolean },
) {
  if (mode.userScoped || !mode.canSearch) return retrieved;
  const tokens = documentQueryTokens(query);
  const strong = (source: DocumentSource) => (source.semanticScore ?? 0) >= AUTOMATIC_EVIDENCE.semanticScore
    || (tokens.length > 0 && new Set(source.matchedTerms ?? []).size / tokens.length >= AUTOMATIC_EVIDENCE.termCoverage);
  const kept = retrieved.sources.filter(source => source.anchorChunkId
    ? retrieved.sources.some(anchor => anchor.chunkId === source.anchorChunkId && strong(anchor))
    : strong(source));
  const withheld = retrieved.sources.length - kept.length;
  if (!withheld) return retrieved;
  return {
    sources: kept,
    diagnostics: { ...retrieved.diagnostics, outcome: kept.length ? retrieved.diagnostics.outcome : "no-hits" as const, selectedSources: kept.length,
      contextChars: kept.reduce((sum, source) => sum + source.snippet.length, 0), withheldSources: withheld },
  };
}
