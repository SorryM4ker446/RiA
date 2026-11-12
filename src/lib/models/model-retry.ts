import { canFallback } from "./usage";

/**
 * Retries of one model after a transient failure. With several conversations
 * answering at once a provider's rate limit is met far more often than one at a
 * time, so the waits grow to about half a minute before the call gives up.
 */
export const MODEL_RETRIES = 5;
/** While another model could answer instead, a failing one gets only a quick second try. */
export const QUICK_RETRIES = 2;
/** A provider asking for a longer wait is treated as unavailable rather than held. */
export const MAX_RETRY_DELAY_MS = 60_000;
const BASE_RETRY_DELAY_MS = 1000;

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
 * cancellation, timeouts, other client errors, a missing model and an account out of
 * balance, none of which waiting will change.
 */
export function retryDelay(error: unknown, retries: number, signal?: AbortSignal, limit = MODEL_RETRIES): number | null {
  if (retries >= limit || !canFallback(error, signal) || object(error).statusCode === 404 || object(error).statusCode === 402) return null;
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
