import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The printed entry and the dev asset fence must agree on the loopback host
 * spellings. A mismatch is invisible in unit tests: the page renders and the
 * API answers while every stylesheet and bundle is rejected as cross-origin.
 */
test("development launcher entry, asset allowlist and Next config stay aligned", async (t) => {
  const { readFile } = await import("node:fs/promises");
  const launcherSource = await readFile("scripts/run-with-local-db.mjs", "utf8");
  assert.match(launcherSource, /entryOrigin = .*`http:\/\/localhost:\$\{port\}`/, "the printed entry must use localhost, the host the dev server initializes");

  const config = (await import("@/../next.config.ts")).default;
  assert.deepEqual([...config.allowedDevOrigins ?? []].sort(), ["127.0.0.1", "[::1]"]);

  // The fence allows the init hostname plus this list; a loopback IP missing
  // here reproduces the unstyled-page defect through the real server below.
  t.mock.method(globalThis, "fetch", async () => new Response("Unauthorized", { status: 403 }));
  const { blockCrossSiteDEV } = await import("next/dist/server/lib/router-utils/block-cross-site-dev.js");
  const assetRequest = {
    url: "/_next/static/chunks/main-app.js",
    headers: { "sec-fetch-mode": "no-cors", "sec-fetch-site": "cross-site", referer: "http://127.0.0.1:3000/chat" },
  };
  assert.equal(blockCrossSiteDEV(assetRequest, { statusCode: 200, end() {} }, config.allowedDevOrigins, "localhost"), false, "a browser script load from 127.0.0.1 must pass the dev fence");
});
