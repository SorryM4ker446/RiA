import { t } from "@/lib/locale";
import { ApiError } from "@/lib/server/api-error";

export const RATE_LIMIT_POLICIES = {
  chat: { limit: 30, windowMs: 60_000 },
  tools: { limit: 30, windowMs: 60_000 },
  image: { limit: 6, windowMs: 60_000 },
  video: { limit: 3, windowMs: 60_000 },
  upload: { limit: 20, windowMs: 60_000 },
  documents: { limit: 6, windowMs: 60_000 },
  reminders: { limit: 10, windowMs: 60_000 },
  documentReferences: { limit: 120, windowMs: 60_000 },
  conversationSearch: { limit: 30, windowMs: 60_000 },
  mediaRegeneration: { limit: 6, windowMs: 60_000 },
  conversationExport: { limit: 6, windowMs: 60_000 },
  conversationBulkDelete: { limit: 10, windowMs: 60_000 },
  backups: { limit: 6, windowMs: 60_000 },
  backupChunks: { limit: 120, windowMs: 60_000 },
  modelSettings: { limit: 20, windowMs: 60_000 },
  modelCatalog: { limit: 8, windowMs: 60_000 },
  // Each run re-embeds up to a bounded batch of memories, so the budget is a
  // handful of runs per minute, not a bulk operation to retry until empty.
  memoryReindex: { limit: 2, windowMs: 60_000 },
  // Each explicit request embeds at most 32 document chunks; a full document
  // (256 chunks) can complete in eight batches without automatic retries.
  documentEmbeddings: { limit: 12, windowMs: 60_000 },
  // Every memory search embeds the query, so it is a metered model call like
  // any other. The routes that reach one had no quota at all while the heavier
  // reindex next to them did, which is the wrong way round.
  memory: { limit: 30, windowMs: 60_000 },
  // Granting a folder opens a standing permission, so it is deliberately slower
  // than the operations that use one.
  directoryGrants: { limit: 10, windowMs: 60_000 },
} as const;

type RateLimitRecord = {
  count: number;
  resetAt: number;
};

type CheckRateLimitInput = {
  key: string;
  limit: number;
  windowMs: number;
};

type CheckRateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

const globalStore = globalThis as typeof globalThis & {
  __privateAiRateLimitStore?: Map<string, RateLimitRecord>;
};

const rateLimitStore = globalStore.__privateAiRateLimitStore ?? new Map<string, RateLimitRecord>();
if (!globalStore.__privateAiRateLimitStore) {
  globalStore.__privateAiRateLimitStore = rateLimitStore;
}

function now() {
  return Date.now();
}

function cleanupExpiredEntries(currentMs: number) {
  for (const [key, record] of rateLimitStore.entries()) {
    if (record.resetAt <= currentMs) {
      rateLimitStore.delete(key);
    }
  }
}

export function checkRateLimit(input: CheckRateLimitInput): CheckRateLimitResult {
  const currentMs = now();
  const existing = rateLimitStore.get(input.key);

  if (!existing || existing.resetAt <= currentMs) {
    if (rateLimitStore.size >= 2000) {
      cleanupExpiredEntries(currentMs);
      if (rateLimitStore.size >= 2000 && !rateLimitStore.has(input.key)) {
        return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((Math.min(...Array.from(rateLimitStore.values(), (record) => record.resetAt)) - currentMs) / 1000)) };
      }
    }
    rateLimitStore.set(input.key, {
      count: 1,
      resetAt: currentMs + input.windowMs,
    });

    return {
      allowed: true,
      remaining: Math.max(0, input.limit - 1),
      retryAfterSeconds: Math.ceil(input.windowMs / 1000),
    };
  }

  if (existing.count >= input.limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - currentMs) / 1000)),
    };
  }

  existing.count += 1;
  rateLimitStore.set(input.key, existing);

  return {
    allowed: true,
    remaining: Math.max(0, input.limit - existing.count),
    retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - currentMs) / 1000)),
  };
}

/**
 * Quotas belong to the local instance, not to a caller. Every request from this
 * installation shares one bucket per policy, so opening extra windows or
 * clearing cookies cannot raise the limit.
 */
export function enforceRateLimit(policy: keyof typeof RATE_LIMIT_POLICIES) {
  const result = checkRateLimit({ key: policy, ...RATE_LIMIT_POLICIES[policy] });
  if (!result.allowed) {
    throw new ApiError({
      code: "RATE_LIMITED",
      message: t("lib.server.rateLimited"),
      details: { retryAfterSeconds: result.retryAfterSeconds },
      headers: { "Retry-After": String(result.retryAfterSeconds), "X-RateLimit-Remaining": "0" },
    });
  }
}
