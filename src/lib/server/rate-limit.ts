import { t } from "@/lib/locale";
import { ApiError } from "@/lib/server/api-error";
import { DEFAULT_IMAGE_REQUESTS_PER_MINUTE } from "@/lib/models/preferences-schema";

/*
 * Per-minute quotas for the local service. It serves one person on their own
 * computer, so a quota is there to stop a runaway loop, not to ration what the
 * person asks for: importing a folder, attaching a handful of files or indexing
 * a large library must fit well inside them. Calls that spend money (images,
 * video, evaluation runs) stay tighter.
 */
export const RATE_LIMIT_POLICIES = {
  chat: { limit: 30, windowMs: 60_000 },
  tools: { limit: 30, windowMs: 60_000 },
  fileUndo: { limit: 30, windowMs: 60_000 },
  // Read by every card of changed files as it appears, so it allows far more.
  fileUndoStatus: { limit: 600, windowMs: 60_000 },
  image: { limit: DEFAULT_IMAGE_REQUESTS_PER_MINUTE, windowMs: 60_000 },
  video: { limit: 3, windowMs: 60_000 },
  upload: { limit: 120, windowMs: 60_000 },
  // A folder imported as a batch sends one request per document.
  documents: { limit: 60, windowMs: 60_000 },
  documentPreview: { limit: 30, windowMs: 60_000 },
  // Adding, removing or scanning a synced folder; the scans themselves are not counted.
  knowledgeFolders: { limit: 30, windowMs: 60_000 },
  documentExport: { limit: 20, windowMs: 60_000 },
  reminders: { limit: 10, windowMs: 60_000 },
  tasks: { limit: 30, windowMs: 60_000 },
  documentReferences: { limit: 120, windowMs: 60_000 },
  conversationSearch: { limit: 30, windowMs: 60_000 },
  mediaRegeneration: { limit: 6, windowMs: 60_000 },
  conversationExport: { limit: 6, windowMs: 60_000 },
  conversationBulkDelete: { limit: 10, windowMs: 60_000 },
  backups: { limit: 6, windowMs: 60_000 },
  backupChunks: { limit: 120, windowMs: 60_000 },
  modelSettings: { limit: 20, windowMs: 60_000 },
  assistantTemplates: { limit: 30, windowMs: 60_000 },
  documentEvaluation: { limit: 2, windowMs: 60_000 },
  modelCatalog: { limit: 8, windowMs: 60_000 },
  // Each explicit request embeds at most 32 document chunks, so indexing a
  // library by hand is many requests; the provider's own limits still apply.
  documentEmbeddings: { limit: 60, windowMs: 60_000 },
  // Every memory search embeds the query, so it is a metered model call like
  // any other. The routes that reach one had no quota at all while the heavier
  // reindex next to them did, which is the wrong way round.
  memory: { limit: 30, windowMs: 60_000 },
  // Granting a folder opens a standing permission, so it is deliberately slower
  // than the operations that use one.
  directoryGrants: { limit: 10, windowMs: 60_000 },
  extensions: { limit: 30, windowMs: 60_000 },
  extensionRegistry: { limit: 30, windowMs: 60_000 },
  skillMarketplace: { limit: 30, windowMs: 60_000 },
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
  __riaRateLimitStore?: Map<string, RateLimitRecord>;
};

const rateLimitStore = globalStore.__riaRateLimitStore ?? new Map<string, RateLimitRecord>();
if (!globalStore.__riaRateLimitStore) {
  globalStore.__riaRateLimitStore = rateLimitStore;
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
export function enforceRateLimit(policy: keyof typeof RATE_LIMIT_POLICIES, limit: number = RATE_LIMIT_POLICIES[policy].limit) {
  const result = checkRateLimit({ key: policy, windowMs: RATE_LIMIT_POLICIES[policy].windowMs, limit });
  if (!result.allowed) {
    throw new ApiError({
      code: "RATE_LIMITED",
      message: t("lib.server.rateLimited"),
      details: { retryAfterSeconds: result.retryAfterSeconds },
      headers: { "Retry-After": String(result.retryAfterSeconds), "X-RateLimit-Remaining": "0" },
    });
  }
}
