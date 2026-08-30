import { ApiError } from "@/lib/server/api-error";

export const RATE_LIMIT_POLICIES = {
  login: { limit: 20, windowMs: 15 * 60_000 },
  register: { limit: 5, windowMs: 60 * 60_000 },
  chat: { limit: 30, windowMs: 60_000 },
  tools: { limit: 30, windowMs: 60_000 },
  image: { limit: 6, windowMs: 60_000 },
  video: { limit: 3, windowMs: 60_000 },
  upload: { limit: 20, windowMs: 60_000 },
  documents: { limit: 6, windowMs: 60_000 },
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

export function enforceRateLimit(policy: keyof typeof RATE_LIMIT_POLICIES, userId = "local-service") {
  const result = checkRateLimit({ key: `${policy}:${userId}`, ...RATE_LIMIT_POLICIES[policy] });
  if (!result.allowed) {
    throw new ApiError({
      code: "RATE_LIMITED",
      message: "请求过于频繁，请稍后重试。",
      details: { retryAfterSeconds: result.retryAfterSeconds },
      headers: { "Retry-After": String(result.retryAfterSeconds), "X-RateLimit-Remaining": "0" },
    });
  }
}
