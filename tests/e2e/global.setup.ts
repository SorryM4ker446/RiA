import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TEST_ACCESS_TOKEN } from "../helpers/workspace-entry";

/**
 * Prepares the access credential for the suite that shares one web server.
 *
 * The workspace has no login page. The shared server is started with a pinned
 * credential, so a run only has to install the matching cookie before any
 * browser context or API request context is created.
 */
export const STORAGE_STATE = resolve(".desktop-data/test/playwright-storage-state.json");

export default function globalSetup() {
  mkdirSync(dirname(STORAGE_STATE), { recursive: true });
  writeFileSync(STORAGE_STATE, `${JSON.stringify({
    cookies: [{
      name: "local_access",
      value: TEST_ACCESS_TOKEN,
      domain: "localhost",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    }],
    origins: [],
  }, null, 2)}\n`);
}
