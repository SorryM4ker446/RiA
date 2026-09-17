import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/local-access/route";
import { issueHandshakeCode } from "@/lib/server/local-access";
import { assertRequestSecurity } from "@/lib/server/request-security";

test("the development launcher prints a localhost entry that matches the dev asset fence", async () => {
  const launcherSource = await import("node:fs/promises").then((fs) => fs.readFile("scripts/run-with-local-db.mjs", "utf8"));
  assert.match(launcherSource, /entryOrigin = .*`http:\/\/localhost:\$\{port\}`/);
  const config = (await import("@/../next.config.ts")).default;
  assert.deepEqual(config.allowedDevOrigins?.sort(), ["127.0.0.1", "[::1]"]);
});

for (const origin of ["http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3100"]) {
  test(`local entry retains cookie scope when redirecting from ${origin}`, (t) => {
    const overrides = { APP_RUNTIME: "web", APP_ORIGIN: "", DATABASE_URL: "", LOCAL_HANDSHAKE_CODE: "" };
    const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const entryUrl = new URL("/api/local-access", origin);
    entryUrl.searchParams.set("handshake", issueHandshakeCode());
    const request = new NextRequest(entryUrl, {
      headers: { host: entryUrl.host, "sec-fetch-site": "none" },
    });
    const response = GET(request);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const target = new URL(response.headers.get("location"), entryUrl);
    assert.equal(target.origin, entryUrl.origin, "redirect must preserve the host-only cookie's origin");
    assert.equal(target.pathname, "/chat");
    assert.equal(target.search, "");
    const cookie = response.headers.get("set-cookie");
    assert.ok(cookie);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=lax/i);
    assert.doesNotMatch(cookie, /;\s*Domain=/i);
    // A browser sends this host-only cookie to the unchanged destination host.
    const apiRequest = new NextRequest(new URL("/api/conversations", target), {
      headers: { host: target.host, cookie: cookie.split(";")[0] },
    });
    assert.doesNotThrow(() => assertRequestSecurity(apiRequest));
  });
}
