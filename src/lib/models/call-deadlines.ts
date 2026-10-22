/** A streamed model call that sends nothing, reasoning included, for this long has stalled. */
export const MODEL_IDLE_TIMEOUT_MS = 60_000;
/** Backstop for a whole call, matching the request timeout provider SDKs default to. */
export const MODEL_CALL_DEADLINE_MS = 600_000;

/**
 * A signal that ends a streamed call when the provider goes quiet, rather than
 * after a fixed total that a long reasoning answer can exceed while still
 * progressing. `touch` on every chunk; `dispose` when the call settles. The
 * idle and total limits abort with a TimeoutError, distinct from cancellation.
 */
export function streamDeadline(signal?: AbortSignal, idleMs = MODEL_IDLE_TIMEOUT_MS, totalMs = MODEL_CALL_DEADLINE_MS) {
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(new DOMException("The model stopped responding", "TimeoutError")), idleMs);
  };
  touch();
  return {
    signal: AbortSignal.any([...(signal ? [signal] : []), idle.signal, AbortSignal.timeout(totalMs)]),
    touch,
    dispose: () => clearTimeout(timer),
  };
}
