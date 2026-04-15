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
    rateLimitStore.set(input.key, {
      count: 1,
      resetAt: currentMs + input.windowMs,
    });

    if (rateLimitStore.size > 2000) {
      cleanupExpiredEntries(currentMs);
    }

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
