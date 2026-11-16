import type { TestContext } from "node:test";

/**
 * Model retries wait for real (0.5 s doubling up to 32 s, ten times). A test
 * about what is retried, or how a failure ends, lets each of those waits
 * through at once and counts attempts instead; every other timer is untouched.
 */
export function skipRetryWaits(t: TestContext) {
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", ((handler: () => void, ms?: number, ...args: unknown[]) =>
    schedule(handler, new Error().stack?.includes("waitForRetry") ? 0 : ms, ...args)) as typeof setTimeout);
}
