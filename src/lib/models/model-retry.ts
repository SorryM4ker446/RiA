import { canFallback } from "./usage";

/** Retries of one model after a transient failure, as the provider SDKs default to. */
export const MODEL_RETRIES = 2;
/** A provider asking for a longer wait is treated as unavailable rather than held. */
export const MAX_RETRY_DELAY_MS = 60_000;
const BASE_RETRY_DELAY_MS = 500;

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }

function retryAfterMs(error: unknown, now = Date.now()): number | null {
  const headers = object(object(error).responseHeaders);
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
  if (typeof value !== "string" || !value.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/**
 * How long to wait before retrying the same model, or null when it must not be
 * retried. Only failures that happened before any output reached the caller are
 * ever passed here, so a retry cannot repeat delivered text or a tool call.
 * Retried: rate limits, server errors and connection failures. Never retried:
 * cancellation, timeouts, other client errors and a missing model.
 */
export function retryDelay(error: unknown, retries: number, signal?: AbortSignal): number | null {
  if (retries >= MODEL_RETRIES || !canFallback(error, signal) || object(error).statusCode === 404) return null;
  const requested = retryAfterMs(error);
  if (requested !== null) return requested <= MAX_RETRY_DELAY_MS ? requested : null;
  return BASE_RETRY_DELAY_MS * 2 ** retries;
}

export function waitForRetry(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
