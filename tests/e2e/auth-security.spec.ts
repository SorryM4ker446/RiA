import { test as base, expect, request as playwrightRequest } from "@playwright/test";
import { startStandaloneServer } from "../helpers/standalone-server";
import { browserApi } from "../helpers/browser-api";
import { openWorkspace, TEST_ACCESS_TOKEN } from "../helpers/workspace-entry";

// This spec needs its own service, because it inspects the database directly.
const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer();
    try { await runTest(app); } finally { await app.close(); }
  },
});

/** The same cookie the run uses, but with a value the service never issued. */
function forgedStorageState(value: string) {
  return {
    cookies: [{ name: "local_access", value, domain: "localhost", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" as const }],
    origins: [],
  };
}

test("local access credential is required, and the entry point does not hand one out freely", { tag: "@integration" }, async ({ page, app }) => {
  const origin = app.origin;
  // Both contexts are deliberately outside the run's storage state, so neither
  // carries the credential the workspace issued. `newContext` otherwise
  // inherits the configured storage state.
  const anonymous = await playwrightRequest.newContext({ storageState: { cookies: [], origins: [] } });
  const forged = await playwrightRequest.newContext({ storageState: forgedStorageState("f".repeat(40)) });
  try {
    // 1. Without the credential no business endpoint answers at all.
    const unauthorized = await anonymous.post(`${origin}/api/chat`, { data: "invalid" });
    expect(unauthorized.status()).toBe(401);
    expect((await unauthorized.json()).error.code).toBe("UNAUTHORIZED");
    for (const path of ["/api/conversations", "/api/models", "/api/tasks", "/api/memory", "/api/usage"]) {
      const response = await anonymous.get(`${origin}${path}`);
      expect(response.status(), path).toBe(401);
    }
    // The refusal must not describe the local configuration.
    expect(JSON.stringify(await (await anonymous.get(`${origin}/api/models`)).json())).not.toContain("OPENROUTER");

    // 2. The entry point only answers a direct visit carrying the current code.
    expect((await anonymous.get(`${origin}/api/local-access`, { maxRedirects: 0 })).status()).toBe(403);
    expect((await anonymous.get(`${origin}/api/local-access?handshake=${"0".repeat(48)}`, { maxRedirects: 0 })).status()).toBe(403);
    // A page on another origin can neither navigate nor fetch its way to a credential.
    expect((await anonymous.get(`${origin}/api/local-access`, { headers: { origin: "https://outside.invalid" }, maxRedirects: 0 })).status()).toBe(403);

    // 3. With the credential the workspace answers, and the cookie stays out of script reach.
    await openWorkspace(page, origin);
    const access = (await page.context().cookies()).find((cookie) => cookie.name === "local_access");
    expect(access?.httpOnly).toBe(true);
    expect(access?.sameSite).toBe("Lax");
    expect((await browserApi(page, `${origin}/api/conversations`)).status).toBe(200);

    // 4. Request validation and the same-origin rule still apply to a credentialed caller.
    const malformed = await browserApi(page, `${origin}/api/chat`, "POST", {
      messages: [{ id: "message-1", role: "user", parts: [{ type: "text", text: 12 }] }],
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("VALIDATION_ERROR");

    const foreign = await playwrightRequest.newContext({
      storageState: forgedStorageState(TEST_ACCESS_TOKEN),
      extraHTTPHeaders: { origin: "https://outside.invalid" },
    });
    try {
      const response = await foreign.post(`${origin}/api/conversations`, { data: { title: "Must not be created" } });
      expect(response.status()).toBe(403);
      expect((await response.json()).error.code).toBe("FORBIDDEN");
    } finally { await foreign.dispose(); }
    expect(app.readRows("SELECT id FROM chats")).toHaveLength(0);

    // 5. A credential that merely looks right is refused.
    expect((await forged.get(`${origin}/api/conversations`)).status()).toBe(401);
  } finally {
    await anonymous.dispose();
    await forged.dispose();
  }
});
