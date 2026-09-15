import { expect, type Page } from "@playwright/test";

/**
 * Access credential for browser tests.
 *
 * A harness that starts its own service pins this value through a token file
 * next to the database, so a spec can reach the service it started, or the
 * configured web server, without a login form.
 */
export const TEST_ACCESS_TOKEN = "00000000000000000000000000000000feedface";

/**
 * Storage state for a browser that never obtained the local credential.
 *
 * A context created without this inherits the run's configured storage state,
 * which would silently carry a valid credential and make a refusal check pass
 * for the wrong reason.
 */
export const NO_CREDENTIAL_STATE = { cookies: [], origins: [] };

/**
 * The host the application actually uses.
 *
 * The exported application resolves its own origin as `localhost`, so page code
 * calls `http://localhost:<port>/api/...` even when the address bar shows
 * `127.0.0.1`. A cookie stored for one name is not sent to the other, so specs
 * open the application through the same host the runtime uses.
 */
export function localHostOrigin(origin: string) {
  const url = new URL(origin);
  url.hostname = "localhost";
  return url.origin;
}

/**
 * Opens the local workspace and establishes the run's access credential.
 *
 * There is no login. The cookie is set for the host the page actually lands on,
 * because that is the origin the application then calls.
 */
export async function openWorkspace(page: Page, origin: string) {
  await page.goto(`${localHostOrigin(origin)}/chat`);
  await expect(page).toHaveURL(/\/chat$/);

  const landed = new URL(page.url());
  await page.context().addCookies([
    {
      name: "local_access",
      value: TEST_ACCESS_TOKEN,
      domain: landed.hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.reload();
}
