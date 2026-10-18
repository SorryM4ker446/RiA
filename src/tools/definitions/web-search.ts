import { readLimitedJson } from "@/lib/models/catalog-read";
import { z } from "zod";
import { resolveSearchRoute, executeProviderSearch, ProviderSearchUnavailableError, searchResultLimit } from "./provider-search";
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
  source: "tavily" | "deepseek-native" | "deepseek-search" | "openrouter";
};

export type WebSearchOutput = {
  /**
   * Set when no lookup was made, and why. Absent on a search that ran. A
   * caller cannot tell "found nothing" from "never looked" without it.
   */
  skipped?: "resultBudget" | "budget" | "notConfigured" | "temporarilyUnavailable" | "runStopped";

  query: string;
  results: WebSearchResultItem[];
  responseTime?: number;
  requestId?: string;
  provider?: WebSearchResultItem["source"];
  fallbackFrom?: WebSearchResultItem["source"];
  evidenceSummary?: string;
  usage?: { searchRequests: number | null; costUsd: number | null };
};

const DEFAULT_TAVILY_API_BASE_URL = "https://api.tavily.com";
const TAVILY_TIMEOUT_SECONDS = 12;

type TavilySearchResponse = {
  query?: string;
  responseTime?: number;
  requestId?: string;
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
  }>;
};

function normalizeSnippet(value: string | undefined): string {
  return (typeof value === "string" ? value : "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function resolveTavilyApiBaseUrl(): string {
  const configuredUrl = process.env.TAVILY_SEARCH_URL?.trim();
  if (!configuredUrl) {
    return DEFAULT_TAVILY_API_BASE_URL;
  }

  return configuredUrl.replace(/\/search\/?$/, "").replace(/\/$/, "");
}

function throwTavilyError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);

  if (/timed out|timeout|ECONNABORTED/i.test(message)) {
    throw new ApiError({
      code: "TIMEOUT",
      message: "Tavily search timed out.",
    });
  }

  if (/\b(401|403)\b|unauthorized|forbidden|api key|apikey|authorization/i.test(message)) {
    throw new ApiError({
      code: "CONFIGURATION_ERROR",
      message: "Tavily search is not authorized.",
    });
  }

  throw new ApiError({
    code: "UPSTREAM_FAILED",
    message: "Failed to reach Tavily search.",
  });
}

export async function runWebSearch(input: WebSearchInput, signal?: AbortSignal, modelRef?: ModelRef): Promise<WebSearchOutput> {
  const route = resolveSearchRoute(modelRef);
  if (route && route !== "tavily" && modelRef) {
    const ref = modelRef;
    const started = Date.now();
    try { return await withModelLease("chat", ref, async () => {
      const admission = await beginModelAttempt({ mode: "chat", ref, source: "tool", prompt: input.query, maxOutputTokens: 2048, signal });
      try {
        const result = await executeProviderSearch(route, input, ref, signal);
        await recordModelAttempt({ attemptId: admission.id, source: "tool", mode: "chat", modelId: ref.modelId, modelProvider: ref.providerId, started, usage: result.usage, metadata: result.metadata });
        return result.output;
      } catch (error) {
        await recordModelAttempt({ attemptId: admission.id, source: "tool", mode: "chat", modelId: ref.modelId, modelProvider: ref.providerId, started, error });
        throw error;
      }
    }); } catch (error) {
      // Only an explicitly unsupported endpoint permits fallback. Do not bypass
      // access policies or duplicate a search whose execution is uncertain.
      if (!(error instanceof ProviderSearchUnavailableError) || !process.env.TAVILY_API_KEY?.trim() || signal?.aborted) throw error;
      return { ...await runTavilySearch(input, signal), fallbackFrom: route };
    }
  }
  return runTavilySearch(input, signal);
}

async function runTavilySearch(input: WebSearchInput, signal?: AbortSignal): Promise<WebSearchOutput> {
  const maxResults = input.maxResults === undefined ? undefined : Math.min(input.maxResults, searchResultLimit("tavily")!);
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) {
    throw new ApiError({
      code: "CONFIGURATION_ERROR",
      message: "TAVILY_API_KEY is not configured.",
    });
  }

  if (signal?.aborted) throw new ApiError({ code: "TIMEOUT", message: "Web search was cancelled." });

  const deadline = AbortSignal.timeout(TAVILY_TIMEOUT_SECONDS * 1000);
  const abortSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let payload: TavilySearchResponse;
  try {
    const response = await fetch(`${resolveTavilyApiBaseUrl()}/search`, {
      method: "POST", redirect: "error", cache: "no-store", signal: abortSignal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: input.query.trim(), max_results: maxResults, search_depth: "basic", include_answer: false, include_raw_content: false }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Tavily HTTP ${response.status}`); }
    const raw = await readLimitedJson(response, 2 * 1024 * 1024) as Record<string, unknown>;
    if (!Array.isArray(raw.results)) throw new Error("Invalid Tavily results");
    payload = { ...raw, responseTime: typeof raw.response_time === "number" ? raw.response_time : undefined, requestId: typeof raw.request_id === "string" ? raw.request_id : undefined } as TavilySearchResponse;
  } catch (error) {
    if (abortSignal.aborted) throw new ApiError({ code: "TIMEOUT", message: "Web search was cancelled or timed out." });
    throwTavilyError(error);
  }

  const seen = new Set<string>();
  const results = (payload.results ?? [])
    .filter((item) => {
      if (typeof item?.url !== "string" || typeof item.title !== "string" || !item.title.trim()) return false;
      const url = item.url.trim();
      try { const parsed = new URL(url); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return false; } catch { return false; }
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    })
    .slice(0, maxResults)
    .map((item) => ({
      title: item.title?.trim() || item.url || "Untitled",
      url: item.url!.trim(),
      snippet: normalizeSnippet(item.content),
      score: typeof item.score === "number" ? Number(item.score.toFixed(3)) : null,
      source: "tavily" as const,
    }));

  return {
    provider: "tavily",
    query: payload.query?.trim() || input.query.trim(),
    results,
    ...(typeof payload.responseTime === "number" ? { responseTime: payload.responseTime } : {}),
    ...(payload.requestId ? { requestId: payload.requestId } : {}),
  };
}
