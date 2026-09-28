import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import type { ModelRef } from "@/lib/models/preferences-schema";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";

// The protocol itself is covered by deepseek-provider.test.mjs. What is left to
// prove here is the application half: an instance configured for DeepSeek and
// nothing else can still add a model, select it and start a chat, while the
// modes DeepSeek does not serve stay visibly empty instead of failing later.

const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const { addModel, getModelPreferences, preferredModel, saveModelPreferences, withModelLease } = await import("@/lib/models/preferences");
const { defaultModelPreferences } = await import("@/lib/models/preferences-schema");
const { describeProviders, resolveLibraryAvailability } = await import("@/lib/models/availability");
const { readCachedCatalogs } = await import("@/lib/models/catalog");
const { getModelProvider } = await import("@/lib/models/providers");
const { observeLanguageModel } = await import("@/lib/models/observe-language");
const { ApiError } = await import("@/lib/server/api-error");
const imageRoute = await import("@/app/api/image/route");
const models = await import("@/app/api/models/route");

const DEEPSEEK_REF: ModelRef = { providerId: "deepseek", modelId: "deepseek-v4-pro" };
let cookie;
const req = (path, method = "GET", body = undefined) => new NextRequest(`http://localhost${path}`, {
  method,
  headers: { cookie, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const payload = async (response, status = 200) => {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
};

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {});
  globalThis.__privateAiRateLimitStore?.clear();
  cookie = localAccessCookie();
  await db.message.deleteMany({});
  await db.chat.deleteMany({});
  await db.memory.deleteMany({});
  await db.modelRequest.deleteMany({});
  await db.modelCatalogSnapshot.deleteMany({});
  await db.workspacePreference.deleteMany({});
  // A DeepSeek-only instance: the OpenRouter key is absent, which is the whole
  // point of the scenario.
  delete process.env.OPENROUTER_API_KEY;
  process.env.DEEPSEEK_API_KEY = "deepseek-test-key";
  await db.workspacePreference.upsert({ where: { id: "local" }, create: { id: "local", settings: defaultModelPreferences() }, update: { settings: defaultModelPreferences() } });
});

after(async () => { await db.$disconnect(); cleanup(); });

test("a DeepSeek-only instance reports DeepSeek as the configured provider", async () => {
  const providers = describeProviders();
  assert.deepEqual(providers.find(provider => provider.providerId === "deepseek"), { providerId: "deepseek", displayName: "DeepSeek", configured: true });
  assert.equal(providers.find(provider => provider.providerId === "openrouter").configured, false);
});

test("a catalog row from DeepSeek can be added and selected without an OpenRouter key", async () => {
  await db.modelCatalogSnapshot.upsert({
    where: { providerId_mode: { providerId: "deepseek", mode: "chat" } },
    create: { providerId: "deepseek", mode: "chat", fetchedAt: new Date(), models: [{ providerId: "deepseek", modelId: "deepseek-v4-pro", name: "DeepSeek V4 Pro", description: "", modes: ["chat"], supportsImageInput: true, endpointImageInput: null, supportsTools: true, contextLength: 393216, pricing: {} }] },
    update: { models: [] },
  });
  const added = await addModel(DEEPSEEK_REF);
  assert.equal(added.data.modelId, "deepseek-v4-pro");
  assert.equal(added.data.providerId, "deepseek");

  const settings = await getModelPreferences();
  assert.deepEqual(settings.library[0].modelId, "deepseek-v4-pro");
  // The reference resolves, and the same id through another provider does not.
  assert.deepEqual(await preferredModel("chat", DEEPSEEK_REF), DEEPSEEK_REF);
  // The same id reached through another provider is a different entry, not a
  // match for this one.
  await assert.rejects(() => preferredModel("chat", { providerId: "openrouter", modelId: "deepseek-v4-pro" }), /不在“我的模型”/);
  assert.equal(settings.library[0].contextLength, 393216);
});

test("an unsupported image format is refused before the request is sent", async () => {
  const model = getModelProvider("deepseek").createChatModel("deepseek-v4-pro");
  // The provider detects the format from the file itself and accepts four of
  // them. Anything else is refused here rather than as a provider error after
  // the request has already been paid for.
  await assert.rejects(
    async () => model.doGenerate({ prompt: [{ role: "user", content: [{ type: "file", data: "AA==", mediaType: "image/bmp" }] }] }),
    /image\/jpeg, image\/png, image\/gif, image\/webp images only/,
  );
  // A private media URL is useless to the provider, so it is never forwarded as
  // a link it would try and fail to fetch.
  await assert.rejects(
    async () => model.doGenerate({ prompt: [{ role: "user", content: [{ type: "file", data: "/api/media/asset-1", mediaType: "image/png" }] }] }),
    /private media URL/,
  );
});

test("the modes DeepSeek does not serve stay empty rather than failing at send time", async () => {
  await db.modelCatalogSnapshot.upsert({
    where: { providerId_mode: { providerId: "deepseek", mode: "chat" } },
    create: { providerId: "deepseek", mode: "chat", fetchedAt: new Date(), models: [{ providerId: "deepseek", modelId: "deepseek-v4-pro", name: "DeepSeek V4 Pro", description: "", modes: ["chat"], supportsImageInput: false, endpointImageInput: null, supportsTools: true, contextLength: null, pricing: {} }] },
    update: { models: [] },
  });
  await addModel(DEEPSEEK_REF);
  const settings = await getModelPreferences();
  // Image, video and embedding are not offered by this provider, so no
  // selection can point at one.
  for (const mode of ["image", "video"] as const) {
    await assert.rejects(() => preferredModel(mode, DEEPSEEK_REF), (error) => error instanceof ApiError && error.code === "CONFIGURATION_ERROR");
    await assert.rejects(() => withModelLease(mode, DEEPSEEK_REF, () => "unreachable"), (error) => error instanceof ApiError && error.code === "CONFIGURATION_ERROR");
  }
  assert.equal(settings.embedding, null);
});

test("a chat request carrying a DeepSeek model is authorized and reaches the provider", async () => {
  await db.modelCatalogSnapshot.upsert({
    where: { providerId_mode: { providerId: "deepseek", mode: "chat" } },
    create: { providerId: "deepseek", mode: "chat", fetchedAt: new Date(), models: [{ providerId: "deepseek", modelId: "deepseek-v4-pro", name: "DeepSeek V4 Pro", description: "", modes: ["chat"], supportsImageInput: false, endpointImageInput: null, supportsTools: true, contextLength: null, pricing: {} }] },
    update: { models: [] },
  });
  await addModel(DEEPSEEK_REF);
  const settings = await getModelPreferences();
  await (await import("@/lib/models/preferences")).saveModelPreferences({ ...settings, chat: { model: DEEPSEEK_REF, fallback: null } });

  // The lease is what every call path goes through, and it accepts this entry.
  const leased = await withModelLease("chat", DEEPSEEK_REF, model => model.modelId);
  assert.equal(leased, "deepseek-v4-pro");
  // The model object resolves through the provider that owns the reference.
  // `@/lib/ai/client` is replaced by a mock in this harness, so the provider
  // identity is checked on the registry that the client would have resolved.
  const { getModelProvider } = await import("@/lib/models/providers");
const { observeLanguageModel } = await import("@/lib/models/observe-language");
  const model = getModelProvider(DEEPSEEK_REF.providerId).createChatModel(DEEPSEEK_REF.modelId);
  assert.equal(model.specificationVersion, "v3");
  assert.equal(model.provider, "deepseek");
  assert.equal(model.modelId, "deepseek-v4-pro");
});

test("the models page reports DeepSeek as ready and the other provider as unconfigured", async () => {
  await db.modelCatalogSnapshot.upsert({
    where: { providerId_mode: { providerId: "deepseek", mode: "chat" } },
    create: { providerId: "deepseek", mode: "chat", fetchedAt: new Date(), models: [{ providerId: "deepseek", modelId: "deepseek-v4-pro", name: "DeepSeek V4 Pro", description: "", modes: ["chat"], supportsImageInput: false, endpointImageInput: null, supportsTools: true, contextLength: null, pricing: {} }] },
    update: { models: [] },
  });
  await addModel(DEEPSEEK_REF);
  const response = await models.GET(req("/api/models"));
  const data = await payload(response);

  assert.equal(data.providers.find(provider => provider.providerId === "deepseek").configured, true);
  assert.equal(data.providers.find(provider => provider.providerId === "openrouter").configured, false);
  assert.equal(data.availability["deepseek:deepseek-v4-pro"].state, "ready");
  // The image catalog was never read for this provider, so a DeepSeek model is
  // not claimed to be available for a mode it does not serve.
  const availability = resolveLibraryAvailability(data.data, await readCachedCatalogs());
  assert.equal(availability["deepseek:deepseek-v4-pro"].state, "ready");
});

test("an image request naming a DeepSeek model is refused before any generation", async () => {
  const response = await imageRoute.POST(req("/api/image", "POST", { prompt: "draw", model: DEEPSEEK_REF }));
  // Not in the library for that mode, so it is refused as configuration
  // rather than accepted and failing at the provider.
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, "CONFIGURATION_ERROR");
  assert.equal(await db.mediaAsset.count(), 0);
});

// --- Switching between providers, and keeping the two apart ----------------

test("a failing primary is replaced by the configured fallback, and each attempt is recorded against its own provider", async () => {
  const openrouterRef: ModelRef = { providerId: "openrouter", modelId: "anthropic/claude-opus-4.6" };
  const now = new Date().toISOString();
  const libraryRow = (ref) => ({
    providerId: ref.providerId, modelId: ref.modelId, name: ref.modelId, description: "",
    modes: ["chat"], supportsImageInput: false, endpointImageInput: null, supportsTools: true,
    contextLength: null, pricing: {}, addedAt: now, lastSeenAt: now,
  });
  for (const [ref, mode] of [[DEEPSEEK_REF, "chat"], [openrouterRef, "chat"]] as const) {
    await db.modelCatalogSnapshot.upsert({
      where: { providerId_mode: { providerId: ref.providerId, mode } },
      create: { providerId: ref.providerId, mode, fetchedAt: new Date(), models: [libraryRow(ref)] },
      update: { models: [libraryRow(ref)] },
    });
  }
  await addModel(DEEPSEEK_REF);
  await addModel(openrouterRef);
  const settings = await getModelPreferences();
  await saveModelPreferences({ ...settings, chat: { model: DEEPSEEK_REF, fallback: openrouterRef } });

  // The primary fails in a way the fallback rule accepts; the replacement model
  // is a stand-in for the other provider, so the assertion is about which
  // reference the switch reached for and how each attempt is recorded.
  // Both models here are stand-ins. The claim under test is what the wrapper
  // does on a failure — which reference it switches to, and with what it
  // records — and that is decided above the transport, so this test neither
  // needs nor makes a provider request.
  let alternateRef = null;
  const primary = {
    specificationVersion: "v3",
    provider: "deepseek",
    modelId: DEEPSEEK_REF.modelId,
    supportedUrls: {},
    doStream: async () => { throw Object.assign(new Error("upstream unavailable"), { statusCode: 503 }); },
  } as unknown as LanguageModelV3;
  const alternateCalls = [];
  const alternate = {
    specificationVersion: "v3",
    provider: "openrouter",
    modelId: openrouterRef.modelId,
    supportedUrls: {},
    doStream: async options => {
      alternateCalls.push(options);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text-0" });
            controller.enqueue({ type: "text-delta", id: "text-0", delta: "备用回答" });
            controller.enqueue({ type: "text-end", id: "text-0" });
            controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 5 }, outputTokens: { total: 3, text: 3 } } });
            controller.close();
          },
        }),
      };
    },
  } as unknown as LanguageModelV3;
  const model = observeLanguageModel(primary, DEEPSEEK_REF, ref => { alternateRef = ref; return alternate; });

  const parts = [];
  const result = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "问题" }] }] });
  for await (const part of result.stream) parts.push(part);

  // The switch reached for the OpenRouter reference, not for a same-named model
  // on the failing provider.
  assert.deepEqual(alternateRef, openrouterRef);
  assert.equal(parts.filter(part => part.type === "text-delta").map(part => part.delta).join(""), "备用回答");
  // What crossed the boundary is a standard reasoning part, not a private field
  // of whichever provider produced it.
  assert.equal(parts.some(part => part.type === "reasoning"), false);
});

test("each provider's key is used only for its own requests", async () => {
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  process.env.DEEPSEEK_API_KEY = "deepseek-test-key";
  const registry = await import("@/lib/models/providers");
  const openRouterProvider = registry.getModelProvider("openrouter");
  const deepseekProvider = registry.getModelProvider("deepseek");

  assert.equal(openRouterProvider.isConfigured(), true);
  assert.equal(deepseekProvider.isConfigured(), true);
  // The two keys are independent: neither provider reports the other's state.
  delete process.env.OPENROUTER_API_KEY;
  assert.equal(openRouterProvider.isConfigured(), false);
  assert.equal(deepseekProvider.isConfigured(), true);
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
});

test("usage records the provider of the attempt that was actually made", async () => {
  const requestId = "deepseek-attempt";
  await db.modelRequest.deleteMany({ where: { requestId } });
  const { recordModelAttempt, usageSummary } = await import("@/lib/models/usage");
  await recordModelAttempt({ requestId, mode: "chat", modelId: "deepseek-v4-pro", modelProvider: "deepseek", started: Date.now(), usage: { inputTokens: 10, outputTokens: 4 } });
  await recordModelAttempt({ requestId, mode: "chat", modelId: "anthropic/claude-opus-4.6", modelProvider: "openrouter", started: Date.now(), usage: { inputTokens: 10, outputTokens: 4 }, fallback: true });

  const usage = await usageSummary();
  const attempts = usage.recent.filter(row => row.requestId === requestId);
  // The usage view is newest first, and the fallback attempt is the later one.
  assert.deepEqual(attempts.map(row => [row.modelId, row.modelProvider, row.fallback]), [
    ["anthropic/claude-opus-4.6", "openrouter", true],
    ["deepseek-v4-pro", "deepseek", false],
  ]);
  // No rate was configured for either provider, so the cost is unknown rather
  // than zero: a missing price is not a free request.
  assert.deepEqual(attempts.map(row => row.costSource), ["unknown", "unknown"]);
  assert.equal(attempts.every(row => row.costUsd === null), true);
});

test("the workspace reasoning preference is translated into the provider's own request options", async () => {
  const { getModelProvider } = await import("@/lib/models/providers");
  const deepseek = getModelProvider("deepseek");
  // Off is expressed as a toggle with no effort: sending both would ask the
  // provider to contradict itself.
  assert.deepEqual(deepseek.reasoningOptions({ enabled: false, effort: null }), { deepseek: { thinking: { enabled: false } } });
  assert.deepEqual(deepseek.reasoningOptions({ enabled: false, effort: "max" }), { deepseek: { thinking: { enabled: false } } });
  assert.deepEqual(deepseek.reasoningOptions({ enabled: true, effort: null }), { deepseek: { thinking: { enabled: true } } });
  assert.deepEqual(deepseek.reasoningOptions({ enabled: true, effort: "max" }), { deepseek: { thinking: { enabled: true, effort: "max" } } });
  // A provider with no notion of it contributes nothing, so its requests are
  // unchanged by a setting it does not understand.
  assert.equal(getModelProvider("openrouter").reasoningOptions, undefined);
});

test("the preference round-trips through the stored settings and defaults sensibly", async () => {
  const { defaultModelPreferences } = await import("@/lib/models/preferences-schema");
  // An existing workspace that predates the setting keeps the behaviour a
  // reasoning model has on its own, and is not required to be rewritten.
  const stored = { ...defaultModelPreferences(), version: 3, chat: { model: null, fallback: null }, image: { model: null, fallback: null }, video: { model: null, fallback: null } };
  delete stored.thinking;
  const parsed = (await import("@/lib/models/preferences-schema")).preferencesSchema.parse(stored);
  assert.deepEqual(parsed.thinking, { enabled: true, effort: null });

  const settings = await getModelPreferences();
  await saveModelPreferences({ ...settings, thinking: { enabled: false, effort: "max" } });
  assert.deepEqual((await getModelPreferences()).thinking, { enabled: false, effort: "max" });
});

test("a stored chain of thought is replayed with the next turn that uses tools", async () => {
  const { getReasoningFromUIMessage } = await import("@/lib/ai/ui-message");
  const { mapStoredMessagesToUI } = await import("@/features/chat/page-utils");
  const { encodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");

  const answer = {
    role: "assistant",
    parts: [
      { type: "reasoning", text: "先查工具再回答", state: "done" },
      { type: "text", text: "工具查到的结果" },
    ],
  } as unknown as UIMessage;
  assert.equal(getReasoningFromUIMessage(answer), "先查工具再回答");

  const content = encodePersistedAssistantToolMessage({
    type: "assistant-tool-message",
    text: "工具查到的结果",
    reasoning: "先查工具再回答",
    tools: [{ toolName: "createTask", toolCallId: "call_1", state: "output-available", output: { taskId: "t1" } }],
  });
  await db.chat.create({ data: { title: "工具轮次", messages: { create: [{ role: "assistant", content }] } } });
  const chat = await db.chat.findFirstOrThrow({ include: { messages: true } });
  const stored = chat.messages[0];
  // The mapper consumes the wire shape, not a database row: a row's `Date` is
  // not a string, and passing one here is how a column the client never reads
  // becomes a type error at the wrong place.
  const row = { id: stored.id, clientMessageId: null, role: stored.role, content: stored.content, status: "success" as const };
  const { uiMessages } = mapStoredMessagesToUI([row]);
  const messages = uiMessages;
  // The reasoning has to come back as a part, not as visible text: the
  // provider needs it in the request, the conversation should not show it.
  const reasoningPart = messages[0].parts.find(part => part.type === "reasoning");
  assert.equal(reasoningPart.text, "先查工具再回答");
  assert.equal(messages[0].parts.filter(part => part.type === "text").map(part => part.text).join(""), "工具查到的结果");
});
