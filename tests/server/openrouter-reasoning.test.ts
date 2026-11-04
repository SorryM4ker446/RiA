import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { createTestDatabase } from "../helpers/database";
import { CHAT_MODEL_REF, seedTestModelPreferences } from "../helpers/model-library";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { getModelProvider } = await import("@/lib/models/providers");
const { observeLanguageModel } = await import("@/lib/models/observe-language");
const { addModel, getModelPreferences } = await import("@/lib/models/preferences");
const { getCatalog } = await import("@/lib/models/catalog");

const openrouter = getModelProvider("openrouter");
const options = (preference: { enabled: boolean; effort: "low" | "high" | "max" | null }, reasoning?: { mandatory: boolean; efforts?: ("none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")[] } | null) =>
  openrouter.reasoningOptions!(preference, { reasoning });
const sentEffort = (effort: string) => ({ openrouter: { reasoning: { effort } } });
const finish = { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } };
const catalogRow = (id: string, reasoning?: unknown) => ({ id, name: id, context_length: 1000, architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: reasoning === undefined ? ["tools"] : ["tools", "reasoning"], ...(reasoning === undefined ? {} : { reasoning }) });
function stubCatalog(t: TestContext, rows: unknown[]) {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: rows }), { status: 200, headers: { "content-type": "application/json" } }));
}

beforeEach(async () => {
  process.env.OPENROUTER_API_KEY = "offline-key";
  await db.modelRequest.deleteMany({}); await db.modelCatalogSnapshot.deleteMany({}); await db.workspacePreference.deleteMany({});
  await seedTestModelPreferences(db);
});
after(async () => { await db.$disconnect(); cleanup(); });

test("with no effort chosen the request is left to the model's own default", () => {
  for (const capability of [undefined, null, { mandatory: false }, { mandatory: true, efforts: ["high" as const] }]) {
    assert.equal(options({ enabled: true, effort: null }, capability), undefined);
  }
});

test("turning reasoning off is only sent to a model known to accept it", () => {
  assert.deepEqual(options({ enabled: false, effort: "max" }, { mandatory: false, efforts: ["high", "low", "none"] }), sentEffort("none"));
  assert.deepEqual(options({ enabled: false, effort: null }, { mandatory: false }), { openrouter: { reasoning: { enabled: false } } });
  assert.equal(options({ enabled: false, effort: null }, { mandatory: true, efforts: ["high", "low"] }), undefined, "a model that must reason rejects being turned off");
  assert.equal(options({ enabled: false, effort: null }, undefined), undefined, "an entry that does not say is not risked");
  assert.equal(options({ enabled: false, effort: null }, null), undefined, "a model that does not reason has nothing to turn off");
});

test("an effort becomes the nearest level the model offers", () => {
  assert.deepEqual(options({ enabled: true, effort: "high" }, { mandatory: false, efforts: ["max", "high", "low", "none"] }), sentEffort("high"));
  assert.deepEqual(options({ enabled: true, effort: "max" }, { mandatory: true, efforts: ["xhigh", "high", "medium"] }), sentEffort("xhigh"));
  assert.deepEqual(options({ enabled: true, effort: "low" }, { mandatory: true, efforts: ["xhigh", "high", "medium"] }), sentEffort("medium"));
  assert.deepEqual(options({ enabled: true, effort: "low" }, { mandatory: false, efforts: ["high", "none"] }), sentEffort("high"), "`none` is never what an effort means");
  assert.deepEqual(options({ enabled: true, effort: "max" }, { mandatory: false }), sentEffort("high"), "without a list, a level every reasoning model takes");
  assert.deepEqual(options({ enabled: true, effort: "low" }, undefined), sentEffort("low"));
  assert.equal(options({ enabled: true, effort: "high" }, null), undefined);
});

test("the chosen options reach OpenRouter's request body", async t => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 400 });
  });
  await assert.rejects(async () => openrouter.createChatModel("example/model").doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], providerOptions: sentEffort("xhigh") }));
  assert.deepEqual(bodies[0].reasoning, { effort: "xhigh" });
});

test("each attempt carries the reasoning of the model answering it", async () => {
  const settings = await getModelPreferences();
  const backupRef = { providerId: "openrouter" as const, modelId: "example/always-reasons" };
  settings.library = settings.library.map(item => item.modelId === CHAT_MODEL_REF.modelId && item.providerId === CHAT_MODEL_REF.providerId ? { ...item, reasoning: { mandatory: false, efforts: ["high" as const, "none" as const] } } : item);
  settings.library.push({ ...settings.library.find(item => item.modelId === CHAT_MODEL_REF.modelId)!, ...backupRef, modes: ["chat"], reasoning: { mandatory: true, efforts: ["high"] } });
  settings.chat.fallback = backupRef;
  await db.workspacePreference.update({ where: { id: "local" }, data: { settings } });

  const seen: Array<[string, unknown]> = [];
  const primary = new MockLanguageModelV3({ doStream: async call => { seen.push(["primary", call.providerOptions]); throw Object.assign(new Error("no such model"), { statusCode: 404 }); } });
  const backup = new MockLanguageModelV3({ doStream: async call => { seen.push(["backup", call.providerOptions]); return { stream: new ReadableStream({ start(controller) { controller.enqueue(finish); controller.close(); } }) }; } });
  const observed = observeLanguageModel(primary as LanguageModelV3, CHAT_MODEL_REF, () => backup as LanguageModelV3, { reasoning: { enabled: false, effort: null } });
  const result = await observed.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  await result.stream.pipeTo(new WritableStream());
  assert.deepEqual(seen, [["primary", sentEffort("none")], ["backup", undefined]], "the fallback must reason, so it is not told to stop");
});

test("a call that names no reasoning preference is sent as it came", async () => {
  const seen: unknown[] = [];
  const provider = new MockLanguageModelV3({ doStream: async call => { seen.push(call.providerOptions); return { stream: new ReadableStream({ start(controller) { controller.enqueue(finish); controller.close(); } }) }; } });
  const result = await observeLanguageModel(provider as LanguageModelV3, CHAT_MODEL_REF, () => provider as LanguageModelV3).doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  await result.stream.pipeTo(new WritableStream());
  assert.deepEqual(seen, [undefined]);
});

test("the catalog's reasoning fields reach a new library entry, and a later read updates an existing one", async t => {
  const id = "example/reasoner";
  stubCatalog(t, [catalogRow(id, { mandatory: false, default_enabled: true, supported_efforts: ["high", "none", "future-level"], default_effort: "high" })]);
  await getCatalog("openrouter", "chat", true);
  assert.deepEqual((await addModel({ providerId: "openrouter", modelId: id })).data.reasoning, { mandatory: false, efforts: ["none", "high"] });

  t.mock.restoreAll();
  stubCatalog(t, [catalogRow(id, { mandatory: true })]);
  await getCatalog("openrouter", "chat", true);
  assert.deepEqual((await getModelPreferences()).library.find(item => item.modelId === id)?.reasoning, { mandatory: true }, "a model that became mandatory is no longer told to stop");

  t.mock.restoreAll();
  stubCatalog(t, [catalogRow(id, "unreadable")]);
  await getCatalog("openrouter", "chat", true);
  assert.deepEqual((await getModelPreferences()).library.find(item => item.modelId === id)?.reasoning, { mandatory: true }, "a row that no longer says leaves what was known");
});

test("a catalog row that does not reason is recorded as such, and a malformed field does not lose the row", async t => {
  stubCatalog(t, [catalogRow("example/plain"), catalogRow("example/odd", "unreadable")]);
  const { models } = await openrouter.fetchCatalog("chat", AbortSignal.timeout(5000));
  assert.deepEqual(models.map(model => [model.modelId, model.reasoning]), [["example/plain", null], ["example/odd", undefined]]);
});
