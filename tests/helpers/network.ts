import { expect, type Page, type Request } from "@playwright/test";

/**
 * Connections a page keeps open for as long as it is open, to hear what
 * happens elsewhere. They never finish, so Playwright's "networkidle" never
 * comes; they are also not what a test waits for.
 */
const LONG_LIVED = [/\/api\/conversations\/events(?:\?|$)/];

/**
 * Follows the page's requests from now on. `settled()` waits as "networkidle"
 * does, until nothing but long-lived connections has been in flight for a
 * moment, so the reads a page makes after an action have all landed.
 */
export function watchNetwork(page: Page) {
  const pending = new Set<Request>();
  page.on("request", request => { if (!LONG_LIVED.some(pattern => pattern.test(request.url()))) pending.add(request); });
  page.on("requestfinished", request => pending.delete(request));
  page.on("requestfailed", request => pending.delete(request));
  // What the page that just left had in flight (prefetches, mostly) is never
  // reported as finished; it went with that page.
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) for (const request of pending) if (request.isNavigationRequest() === false) pending.delete(request); });
  return {
    async settled(quietMs = 500) {
      for (;;) {
        // Named, so a wait that never ends says what it is waiting for.
        await expect.poll(() => [...pending].map(request => `${request.method()} ${new URL(request.url()).pathname}`)).toEqual([]);
        await page.waitForTimeout(quietMs);
        if (pending.size === 0) return;
      }
    },
  };
}
