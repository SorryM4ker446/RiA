import { tavilySearch } from "@tavily/ai-sdk";
import { z } from "zod";
import { ApiError } from "@/lib/server/api-error";

export const webSearchInput = z.object({
  query: z.string().min(1).describe("The web search query."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("Optional result count. Choose fewer results for simple facts and more for broad comparisons."),
});

export type WebSearchInput = z.infer<typeof webSearchInput>;

export type WebSearchResultItem = {
  title: string;
  url: string;
  snippet: string;
  score: number | null;
  source: "tavily";
};

export type WebSearchOutput = {
  query: string;
  results: WebSearchResultItem[];
  responseTime?: number;
  requestId?: string;
};

const DEFAULT_TAVILY_API_BASE_URL = "https://api.tavily.com";
const TAVILY_TIMEOUT_SECONDS = 12;
const DEFAULT_MAX_RESULTS = 5;
const MIN_MAX_RESULTS = 1;
const MAX_MAX_RESULTS = 10;

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
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function normalizeMaxResults(value: number | undefined): number {
  if (typeof value === "undefined") {
    return DEFAULT_MAX_RESULTS;
  }

  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_RESULTS;
  }

  return Math.min(MAX_MAX_RESULTS, Math.max(MIN_MAX_RESULTS, Math.trunc(value)));
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
      details: message,
    });
  }

  if (/\b(401|403)\b|unauthorized|forbidden|api key|apikey|authorization/i.test(message)) {
    throw new ApiError({
      code: "UNAUTHORIZED",
      message: "Tavily search is not authorized.",
      status: 401,
      details: message,
    });
  }

  throw new ApiError({
    code: "UPSTREAM_FAILED",
    message: "Failed to reach Tavily search.",
    details: message,
  });
}

export async function runWebSearch(input: WebSearchInput): Promise<WebSearchOutput> {
  const maxResults = normalizeMaxResults(input.maxResults);
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) {
    throw new ApiError({
      code: "UNAUTHORIZED",
      message: "TAVILY_API_KEY is not configured.",
    });
  }

  const tool = tavilySearch({
    apiKey,
    apiBaseURL: resolveTavilyApiBaseUrl(),
    maxResults,
    searchDepth: "basic",
    includeAnswer: false,
    includeRawContent: false,
    timeout: TAVILY_TIMEOUT_SECONDS,
  });
  const executeSearch = tool.execute;
  if (!executeSearch) {
    throw new ApiError({
      code: "UPSTREAM_FAILED",
      message: "Tavily search adapter is not executable.",
    });
  }

  let payload: TavilySearchResponse;
  try {
    payload = (await executeSearch(
      {
        query: input.query.trim(),
        searchDepth: "basic",
      },
      {
        toolCallId: "webSearch",
        messages: [],
      },
    )) as TavilySearchResponse;
  } catch (error) {
    throwTavilyError(error);
  }

  const results = (payload.results ?? [])
    .filter((item) => item.url && item.title)
    .slice(0, maxResults)
    .map((item) => ({
      title: item.title?.trim() || item.url || "Untitled",
      url: item.url as string,
      snippet: normalizeSnippet(item.content),
      score: typeof item.score === "number" ? Number(item.score.toFixed(3)) : null,
      source: "tavily" as const,
    }));

  return {
    query: payload.query?.trim() || input.query.trim(),
    results,
    ...(typeof payload.responseTime === "number" ? { responseTime: payload.responseTime } : {}),
    ...(payload.requestId ? { requestId: payload.requestId } : {}),
  };
}
