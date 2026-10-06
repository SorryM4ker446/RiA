import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";

import { createTestDatabase } from "../helpers/database";

const cleanup = createTestDatabase();
const { openRouterProvider } = await import("@/lib/models/providers/openrouter");
const { deepseekProvider } = await import("@/lib/models/providers/deepseek");
const { CatalogFetchError } = await import("@/lib/models/providers/types");
const { defaultModelPreferences, modelRefKey, preferencesSchema, upgradeModelPreferences } = await import("@/lib/models/preferences-schema");
const { db } = await import("@/db");
const { createScheduledJob } = await import("@/lib/scheduler/jobs");
const { runDueScheduledJob } = await import("@/lib/scheduler/runner");

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Every reason a catalog read can fail, as the adapter reports it. */
async function fetchFailure(run: () => Promise<unknown>) {
  const error = await run().then(() => null, (thrown: unknown) => thrown);
  assert.ok(error instanceof CatalogFetchError, `expected a CatalogFetchError, got ${String(error)}`);
  return error.reason;
}

/**
 * A body that starts arriving and then stops, which is what a reset connection
 * looks like to the reader. Verified against a real socket: `readLimitedJson`
 * lets this out as a plain `TypeError`, not a `BodyReadError`, which is the
 * whole reason the adapters have to tell the two apart themselves.
 */
function truncatedBodyResponse() {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"data":[{"id":"openai/gpt-offline"')); },
    pull(controller) { controller.error(new TypeError("terminated")); }
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

// --- a body that stops arriving is this machine's connection, not bad JSON -----

test("an OpenRouter catalog whose body stops mid-stream is a read failure, not a malformed catalog", async (t) => {
  t.mock.method(globalThis, "fetch", (async () => truncatedBodyResponse()) as FetchStub);

  assert.equal(
    await fetchFailure(() => openRouterProvider.fetchCatalog("chat", new AbortController().signal)),
    "network",
    "a connection that dies while the catalog is arriving is not something the user can act on by changing their model list"
  );
});

test("an OpenRouter catalog that really is malformed is still reported as such", async (t) => {
  // The read-failure classification must not swallow the shape failures, or a
  // provider that changed its response would be reported forever as a network
  // problem and never be looked at.
  t.mock.method(globalThis, "fetch", (async () => jsonResponse({ data: { models: "wrong" } })) as FetchStub);
  assert.equal(await fetchFailure(() => openRouterProvider.fetchCatalog("chat", new AbortController().signal)), "invalidShape");

  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", (async () => new Response("<html>maintenance</html>", { status: 200 })) as FetchStub);
  assert.equal(await fetchFailure(() => openRouterProvider.fetchCatalog("chat", new AbortController().signal)), "notJson");
});

test("a DeepSeek catalog whose connection is reset mid-body is a read failure", async (t) => {
  // Exercised against a socket that really is closed under the response, not
  // against a stubbed reader: the claim under test is that an infrastructure
  // failure is recognised as one.
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"data":[{"id":"deepseek-v4-pro"');
    setTimeout(() => response.socket?.destroy(), 30);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.DEEPSEEK_API_KEY = "test-key";
  t.after(() => {
    server.close();
    delete process.env.DEEPSEEK_BASE_URL;
  });

  assert.equal(
    await fetchFailure(() => deepseekProvider.fetchCatalog("chat", new AbortController().signal)),
    "network",
    "the adapter says the catalog could not be read, which is what a reset connection is"
  );
});

test("a DeepSeek catalog that really is malformed is still reported as such", async (t) => {
  t.mock.method(globalThis, "fetch", (async () => jsonResponse({ data: [{ id: "not a model id" }] })) as FetchStub);
  assert.equal(
    await fetchFailure(() => deepseekProvider.fetchCatalog("chat", new AbortController().signal)),
    "emptyCatalog",
    "a catalog that parsed but held nothing usable is a different problem from one that could not be read"
  );
});

// --- rates are keyed per provider, and stay that way through an upgrade -------

test("the same model reached through two providers keeps two rates", () => {
  const settings = preferencesSchema.parse({
    ...defaultModelPreferences(),
    rates: {
      [modelRefKey({ providerId: "openrouter", modelId: "vendor/shared-model" })]: { inputPerMillion: 3, outputPerMillion: 15, perRequest: null },
      [modelRefKey({ providerId: "deepseek", modelId: "shared-model" })]: { inputPerMillion: 1, outputPerMillion: 2, perRequest: null }
    }
  });

  assert.equal(settings.rates["openrouter:vendor/shared-model"].inputPerMillion, 3);
  assert.equal(settings.rates["deepseek:shared-model"].inputPerMillion, 1);
  assert.notEqual(modelRefKey({ providerId: "openrouter", modelId: "x" }), modelRefKey({ providerId: "deepseek", modelId: "x" }));
});

test("upgrading a provider-agnostic document qualifies its rate keys without merging them", () => {
  const libraryEntry = {
    providerId: "openrouter", modelId: "vendor/shared-model", name: "Shared", description: "", modes: ["chat"],
    supportsImageInput: false, endpointImageInput: null, supportsTools: true, contextLength: 200000, pricing: {},
    addedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString()
  };
  const legacy = {
    version: 2,
    defaultMode: "chat",
    chat: { modelId: "vendor/shared-model", fallbackId: null },
    image: { modelId: null, fallbackId: null },
    video: { modelId: null, fallbackId: null },
    embeddingModelId: null,
    library: [libraryEntry],
    rates: { "vendor/shared-model": { inputPerMillion: 3, outputPerMillion: 15, perRequest: null } },
    backupRetentionDays: 30,
    backupMaxCount: 10
  };

  const upgraded = upgradeModelPreferences(legacy);
  assert.deepEqual(Object.keys(upgraded.rates), ["openrouter:vendor/shared-model"]);
  assert.equal(upgraded.rates["openrouter:vendor/shared-model"].inputPerMillion, 3);
});

// --- the daily brief's notice is one row per day, however often the job runs ---

const CHAT_MODEL = "anthropic/claude-offline";

function chatCompletion() {
  return jsonResponse({
    id: "offline-completion",
    model: CHAT_MODEL,
    choices: [{ index: 0, message: { role: "assistant", content: "离线回答：一切照旧。" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
  });
}

async function withBriefLibrary(run: () => Promise<void>) {
  const libraryEntry = {
    providerId: "openrouter", modelId: CHAT_MODEL, name: "Claude Offline", description: "", modes: ["chat"],
    supportsImageInput: false, endpointImageInput: null, supportsTools: true, contextLength: 200000, pricing: {},
    addedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString()
  };
  const ref = { providerId: "openrouter" as const, modelId: CHAT_MODEL };
  await db.workspacePreference.upsert({
    where: { id: "local" },
    create: { id: "local", settings: preferencesSchema.parse({ ...defaultModelPreferences(), chat: { model: ref, fallback: null }, library: [libraryEntry] }) },
    update: { settings: preferencesSchema.parse({ ...defaultModelPreferences(), chat: { model: ref, fallback: null }, library: [libraryEntry] }) }
  });
  await run();
}

beforeEach(async () => {
  await db.workspaceReview.deleteMany({});
  await db.workspaceEvent.deleteMany({});
  await db.scheduledJob.deleteMany({});
  await db.appNotice.deleteMany({});
  await db.chat.deleteMany({});
  await db.message.deleteMany({});
  await db.modelRequest.deleteMany({});
  await db.workspacePreference.deleteMany({});
});

test("the daily brief raises one notice for a day no matter how often the job runs", async (t) => {
  // The fingerprint is the calendar day, not the instant, so a second run of
  // the same day's brief refreshes the notice it already raised instead of
  // adding another one. A fingerprint taken from the run's timestamp would make
  // every poll of a due job leave a new row behind.
  t.mock.method(globalThis, "fetch", (async () => chatCompletion()) as FetchStub);

  await withBriefLibrary(async () => {
    const job = await createScheduledJob({ kind: "dailyBrief", enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily" });
    for (const run of [0, 1, 2]) {
      await db.scheduledJob.update({ where: { id: job.id }, data: { nextRunAt: new Date(Date.now() - 60_000) } });
      const result = await runDueScheduledJob(new Date());
      assert.equal(result?.outcome.ok, true, `run ${run} wrote the brief: ${JSON.stringify(result?.outcome)}`);
    }
  });

  const notices = await db.appNotice.findMany({ where: { kind: "dailyBrief" } });
  assert.equal(notices.length, 1, "one day's brief is one notice, however many times the job ran");
  const review = await db.workspaceReview.findFirstOrThrow();
  assert.equal(notices[0].fingerprint, `review:${review.id}`);
  assert.equal(await db.workspaceReview.count(), 1);
  assert.equal(await db.chat.count(), 1);
});

after(async () => {
  await db.$disconnect();
  cleanup();
});
