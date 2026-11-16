import { z } from "zod";
import { retrievalPolicySchema } from "@/lib/assistants/schema";

import { t, tf } from "@/lib/locale";
export const documentDiagnosticsSchema = z.strictObject({
  outcome: z.enum(["empty-query", "empty-library", "no-hits", "hits"]),
  semantic: z.enum(["not-run", "not-configured", "unindexed", "ready", "failed"]),
  corpusChunks: z.number().int().nonnegative(),
  compatibleVectors: z.number().int().nonnegative(),
  scannedVectors: z.number().int().nonnegative(),
  staleVectors: z.number().int().nonnegative(),
  invalidVectors: z.number().int().nonnegative().default(0),
  lexicalCandidates: z.number().int().nonnegative(),
  semanticCandidates: z.number().int().nonnegative(),
  selectedSources: z.number().int().nonnegative().max(8),
  contextChars: z.number().int().nonnegative().max(9600),
  durationMs: z.number().nonnegative(),
  // Recorded by an earlier version, which added strong matches to a request on its own.
  withheldSources: z.number().int().nonnegative().max(8).optional(),
  // Diagnostics saved before similarity stopped having a fixed threshold still record one.
  policy: retrievalPolicySchema.extend({ semanticThreshold: z.number().optional() }),
});
export type DocumentDiagnostics = z.infer<typeof documentDiagnosticsSchema>;
export function describeDocumentDiagnostics(value: DocumentDiagnostics) {
  const outcome = { "empty-query": t("server.diagnostics.emptyQuery"), "empty-library": t("server.diagnostics.emptyLibrary"), "no-hits": t("server.diagnostics.noHits"), hits: tf("server.diagnostics.hits", { count: value.selectedSources }) }[value.outcome];
  const semantic = { "not-run": t("server.diagnostics.notRun"), "not-configured": t("server.diagnostics.notConfigured"), unindexed: t("server.diagnostics.unindexed"), ready: t("server.diagnostics.ready"), failed: t("server.diagnostics.failed") }[value.semantic];
  const withheld = value.withheldSources ? tf("server.diagnostics.withheld", { count: value.withheldSources }) : "";
  return tf("server.diagnostics.summary", { outcome, semantic, characters: value.contextChars, ms: Math.round(value.durationMs), withheld }).trim();
}
