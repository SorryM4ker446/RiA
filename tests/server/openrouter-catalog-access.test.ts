import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { getCatalog } = await import("@/lib/models/catalog");
const catalogRoute = await import("@/app/api/models/catalog/route");
const modes = ["chat", "image", "video", "embedding"] as const;

beforeEach(async (t: TestContext) => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "";
  t.after(() => { if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previousKey; });
  globalThis.__privateAiRateLimitStore?.clear();
  await db.modelCatalogSnapshot.deleteMany({});
});
after(async () => { await db.$disconnect(); cleanup(); });

test("OpenRouter catalogs require a key for initial reads and forced refreshes in every mode", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Catalog must not be requested without a key"); });
  for (const mode of modes) {
    for (const force of [false, true]) {
      const state = await getCatalog("openrouter", mode, force);
      assert.deepEqual(state.models, []); assert.equal(state.source, "empty");
      assert.equal(state.fetchedAt, null); assert.equal(state.failure, null);
    }
  }
  const cookie = localAccessCookie();
  for (const method of ["GET", "POST"] as const) {
    const req = new NextRequest(`http://localhost/api/models/catalog${method === "GET" ? "?providerId=openrouter" : ""}`, {
      method, headers: { cookie, "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({ providerId: "openrouter" }) } : {}),
    });
    const response = await catalogRoute[method](req);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.providers.find(provider => provider.providerId === "openrouter").configured, false);
    for (const mode of modes) assert.deepEqual(body.catalogs.openrouter[mode].models, []);
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(await db.modelCatalogSnapshot.count(), 0);
});

test("missing OpenRouter keys hide fresh and expired caches without deleting them and configuration restores access", async t => {
  for (const [index, mode] of modes.entries()) {
    await db.modelCatalogSnapshot.create({ data: {
      providerId: "openrouter", mode, fetchedAt: new Date(Date.now() - (index % 2 ? 48 * 60 * 60_000 : 0)),
      models: [{ providerId: "openrouter", modelId: `example/${mode}`, name: mode, description: "", modes: [mode], supportsImageInput: false, supportsTools: false, contextLength: null, pricing: {} }],
    } });
  }
  const snapshots = await db.modelCatalogSnapshot.findMany({ orderBy: { mode: "asc" } });
  const fetch = t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.headers.Authorization, "Bearer catalog-test-key");
    return Response.json({ data: [{ id: "example/refreshed", name: "Refreshed", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: {} }] });
  });
  for (const mode of modes) {
    for (const force of [false, true]) assert.deepEqual((await getCatalog("openrouter", mode, force)).models, []);
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(await db.modelCatalogSnapshot.findMany({ orderBy: { mode: "asc" } }), snapshots);
  process.env.OPENROUTER_API_KEY = "catalog-test-key";
  assert.equal((await getCatalog("openrouter", "chat")).models[0].modelId, "example/chat");
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal((await getCatalog("openrouter", "chat", true)).models[0].modelId, "example/refreshed");
  assert.equal(fetch.mock.callCount(), 1);
});
