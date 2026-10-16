import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FullConfig } from "@playwright/test";
import { TEST_ACCESS_TOKEN } from "../helpers/workspace-entry";

/**
 * Prepares the access credential for the suite that shares one web server.
 *
 * The workspace has no login page. The shared server is started with a pinned
 * credential, so a run only has to install the matching cookie before any
 * browser context or API request context is created.
 */
export default function globalSetup(config: FullConfig) {
  const storageState = config.projects[0]?.use.storageState;
  if (typeof storageState !== "string") throw new Error("E2E storage state must be a run-specific file.");
  mkdirSync(dirname(storageState), { recursive: true });
  writeFileSync(storageState, `${JSON.stringify({
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
