import { z } from "zod";
import { resolveSearchRoute, executeProviderSearch } from "./provider-search";
import type { ModelRef } from "@/lib/models/preferences-schema";
import { withModelLease } from "@/lib/models/preferences";
import { beginModelAttempt } from "@/lib/models/call-controls";
import { recordModelAttempt } from "@/lib/models/usage";
import { ApiError } from "@/lib/server/api-error";

export const webSearchInput = z.strictObject({
  query: z.string().trim().max(2000).min(1).describe("A focused web search query. The independent DeepSeek Search API accepts at most 128 Unicode characters."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Choose a positive result count based on the question's scope. RiA imposes no per-turn result quota; each provider's API limit still applies."),
});

export type WebSearchInput = z.infer<typeof webSearchInput>;

export type WebSearchResultItem = {
  title: string;
  url: string;
  snippet: string;
  score: number | null;
  source: "deepseek-native" | "deepseek-search" | "openrouter";
};

export type WebSearchOutput = {
  /**
   * Set when no lookup was made, and why. Absent on a search that ran. A
   * caller cannot tell "found nothing" from "never looked" without it.
   */
  skipped?: "resultBudget" | "budget" | "notConfigured" | "temporarilyUnavailable" | "runStopped";

  query: string;
  results: WebSearchResultItem[];
  requestId?: string;
  provider?: WebSearchResultItem["source"];
  evidenceSummary?: string;
  usage?: { searchRequests: number | null; costUsd: number | null };
};

export async function runWebSearch(input: WebSearchInput, signal?: AbortSignal, modelRef?: ModelRef): Promise<WebSearchOutput> {
  const route = resolveSearchRoute(modelRef);
  if (!route || !modelRef) throw new ApiError({ code: "CONFIGURATION_ERROR", message: "Web search needs a selected DeepSeek or OpenRouter chat model with a configured provider key." });
  if (signal?.aborted) throw new ApiError({ code: "TIMEOUT", message: "Web search was cancelled." });
  const ref = modelRef;
  const started = Date.now();
  // A failed provider search is reported as is. It is never repeated on another
  // engine, which could bypass access policies or duplicate a billable search.
  return withModelLease("chat", ref, async () => {
    const admission = await beginModelAttempt({ mode: "chat", ref, source: "tool", prompt: input.query, maxOutputTokens: 2048, signal });
    try {
      const result = await executeProviderSearch(route, input, ref, signal);
      await recordModelAttempt({ attemptId: admission.id, source: "tool", mode: "chat", modelId: ref.modelId, modelProvider: ref.providerId, started, usage: result.usage, metadata: result.metadata });
      return result.output;
    } catch (error) {
      await recordModelAttempt({ attemptId: admission.id, source: "tool", mode: "chat", modelId: ref.modelId, modelProvider: ref.providerId, started, error });
      throw error;
    }
  });
}
