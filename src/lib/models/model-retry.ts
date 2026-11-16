import { ApiError } from "@/lib/server/api-error";
import { canFallback } from "./usage";

/**
 * Retries of one model after a transient failure, on the same terms as Claude
 * Code: up to ten, waiting from half a second and doubling to at most 32
 * seconds, with up to a quarter more at random so calls that failed together do
 * not all come back at once. A provider's Retry-After is honoured instead.
 */
export const MODEL_RETRIES = 10;
/** While another model could answer instead, a failing one is tried three more times before it takes over. */
export const QUICK_RETRIES = 3;
/** A provider asking for a longer wait is treated as unavailable rather than held. */
export const MAX_RETRY_DELAY_MS = 60_000;
const BASE_RETRY_DELAY_MS = 500;
export const MAX_BACKOFF_MS = 32_000;
const JITTER = 0.25;

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
 * Retried: request timeouts (408), conflicts (409), rate limits, server errors
 * and connection failures. Never retried: cancellation, other client errors, a
 * missing model and an account out of balance, none of which waiting will change.
 */
export function retryDelay(error: unknown, retries: number, signal?: AbortSignal, limit = MODEL_RETRIES, random: () => number = Math.random): number | null {
  if (retries >= limit || signal?.aborted) return null;
  const status = object(error).statusCode;
  const transient = !(error instanceof ApiError) && (status === 408 || status === 409)
    || (canFallback(error, signal) && status !== 404 && status !== 402);
  if (!transient) return null;
  const requested = retryAfterMs(error);
  if (requested !== null) return requested <= MAX_RETRY_DELAY_MS ? requested : null;
  const backoff = Math.min(BASE_RETRY_DELAY_MS * 2 ** retries, MAX_BACKOFF_MS);
  return Math.round(backoff * (1 + JITTER * random()));
}

export function waitForRetry(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
