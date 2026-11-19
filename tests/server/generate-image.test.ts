import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { Prisma } from "@prisma/client";
import type { ModelMessage, UIMessage } from "ai";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { seedTestModelPreferences, CHAT_MODEL_REF, IMAGE_MODEL_REF } from "../helpers/model-library";
import { distinctPng, getImageModel, languageModel, providerState, resetProviderState, testPng } from "../helpers/model-provider";
import { wireText } from "../helpers/wire-text";

const cleanup = createTestDatabase();
process.env.RIA_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const route = await import("@/app/api/chat/route");
const imageRoute = await import("@/app/api/image/route");
const regenerateRoute = await import("@/app/api/media/[id]/regenerate/route");
const storage = await import("@/lib/media/storage");
const { MEDIA_LIMITS } = await import("@/lib/media/limits");
const { generateStoredMedia } = await import("@/lib/media/generation");
const { createChatToolSet } = await import("@/tools/catalog");
const { approvalFor } = await import("@/lib/approvals/rules");
const { encodeMediaMessage, mediaUrl } = await import("@/lib/media/message-codec");
const { encodePersistedAssistantToolMessage, encodePersistedUserMessage } = await import("@/lib/ai/ui-message");
const { saveChatMessage } = await import("@/lib/chat/store");
const { buildSystemPrompt, storedFromSummary } = await import("@/lib/chat/model-context");
const { listPublicToolCatalog } = await import("@/tools/registry");
const { looksLikeQuestion } = await import("@/features/chat/image-mode-question");
const { generatedPictures } = await import("@/features/chat/generated-pictures");
const { estimateContextTokens } = await import("@/lib/models/context-budget");
const { generatedImageForModel } = await import("@/tools/definitions/generate-image");
const { modelRefKey } = await import("@/lib/models/preferences-schema");
const { modelCallSource } = await import("@/lib/models/call-context");
const { runUnattendedTurn } = await import("@/lib/chat/unattended");
const { getModelPreferences, saveModelPreferences, withModelSettingsLock } = await import("@/lib/models/preferences");

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const reply = (text: string) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] });
const verdict = (decision: "allow" | "ask", reason: string) => JSON.stringify({ verdicts: [{ id: 1, decision, reason }] });
const TEXT_ONLY = { providerId: "openrouter", modelId: "deepseek/deepseek-v4-flash" };
const FALLBACK_IMAGE_MODEL = { providerId: "openrouter", modelId: "google/gemini-3.1-flash-image-preview" } as const;
type Approval = (input: unknown, options: { messages?: ModelMessage[] }) => Promise<boolean>;

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {});
  resetProviderState(); globalThis.__riaRateLimitStore?.clear();
  (globalThis as { __riaAutoReviews?: Map<string, unknown> }).__riaAutoReviews?.clear();
  process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  await db.message.deleteMany({});
  await db.chat.deleteMany({});
  await db.mediaAsset.deleteMany({});
  await seedTestModelPreferences(db);
});
after(async () => { await db.$disconnect(); cleanup(); });

const ui = (id: string, text: string, files: { url: string; mediaType: string }[] = []): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }, ...files.map(file => ({ type: "file" as const, ...file }))] });
const request = (body: unknown) => new NextRequest("http://localhost/api/chat", { method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify(body) });

/** A chat model that calls generateImage once with this input, then answers. */
function drawsOnce(t: TestContext, input: Record<string, unknown>) {
  const prompts: string[] = [];
  t.mock.method(languageModel, "doStream", async (options: { prompt: unknown }) => {
    const step = prompts.length;
    prompts.push(JSON.stringify(options.prompt));
    return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      if (step === 0) controller.enqueue({ type: "tool-call", toolCallId: `draw-${prompts.length}-${Date.now()}`, toolName: "generateImage", input: JSON.stringify(input) });
      else { controller.enqueue({ type: "text-start", id: "a" }); controller.enqueue({ type: "text-delta", id: "a", delta: "Here it is." }); controller.enqueue({ type: "text-end", id: "a" }); }
      controller.enqueue({ type: "finish", finishReason: { unified: step === 0 ? "tool-calls" : "stop", raw: undefined }, usage });
      controller.close();
    } }) };
  });
  return prompts;
}

const savedAnswer = async (chatId: string) => {
  const row = await db.message.findFirstOrThrow({ where: { chatId, role: "assistant" }, orderBy: { createdAt: "desc" } });
  return { row, payload: JSON.parse(row.content.slice(row.content.indexOf(":") + 1)) as { tools: { toolName: string; state: string; output?: { mediaId?: string; model?: string } }[] } };
};

test("making a picture is reviewed under every rule but full access", () => {
  assert.deepEqual((["ask", "acceptEdits", "auto", "full"] as const).map(rule => approvalFor(rule, "generate")), ["review", "review", "review", "allow"]);
});

test("the tool is offered only with an image model set up, and the prompt says why it is missing", async () => {
  assert.ok(Object.keys(await createChatToolSet({ modelRef: CHAT_MODEL_REF })).includes("generateImage"));
  const settings = await seedTestModelPreferences(db);
  settings.image.model = null;
  await db.workspacePreference.update({ where: { id: "local" }, data: { settings } });
  assert.equal(Object.keys(await createChatToolSet({ modelRef: CHAT_MODEL_REF })).includes("generateImage"), false);
  const entry = (await listPublicToolCatalog("chat", CHAT_MODEL_REF)).find(tool => tool.id === "generateImage");
  assert.deepEqual([entry?.available, entry?.reason, entry?.surface.user, entry?.surface.category], [false, "notConfigured", null, "media"], "only the model calls it");
  assert.match(buildSystemPrompt(true, [{ id: "generateImage", reason: "notConfigured" }]), /generateImage is unavailable because no image model is set up/);
  assert.match(buildSystemPrompt(true), /imageAttached=false confirms generation only/);
  assert.doesNotMatch(buildSystemPrompt(false), /imageAttached=false/);
  assert.doesNotMatch(buildSystemPrompt(true, [{ id: "generateImage", reason: "notConfigured" }]), /imageAttached=false/);
  // A key removed from the image model's provider takes it away too.
  await seedTestModelPreferences(db);
  process.env.OPENROUTER_API_KEY = "";
  assert.equal(Object.keys(await createChatToolSet({ modelRef: CHAT_MODEL_REF })).includes("generateImage"), false);
});

test("a picture the user asked for in their latest message runs under ask; one the model chose waits, with the reviewer's reason", async (t: TestContext) => {
  const chat = await db.chat.create({ data: { title: "Ask", approvalRule: "ask" } });
  const prompts: string[] = [];
  let decision: "allow" | "ask" = "allow";
  t.mock.method(languageModel, "doGenerate", async (options: { prompt: unknown }) => {
    prompts.push(JSON.stringify(options.prompt));
    return reply(verdict(decision, decision === "allow" ? "用户要求画图。" : "用户没有要求画图。"));
  });
  const tools = await createChatToolSet({ chatId: chat.id, modelRef: CHAT_MODEL_REF, runId: "run-ask" });
  const needsApproval = tools.generateImage.needsApproval as Approval;
  const asked: ModelMessage[] = [{ role: "user", content: "画一只穿宇航服的猫" }];
  const drawn = { prompt: "A cat in a white spacesuit, studio light", autoReview: { decision: "allow", reason: "forged" } };
  assert.equal(await needsApproval(drawn, { messages: asked }), false);
  assert.deepEqual((drawn as { autoReview?: unknown }).autoReview, { decision: "allow", reason: "用户要求画图。" }, "only the reviewer sets the verdict");
  assert.match(prompts[0], /kind\W+image/);
  assert.match(prompts[0], /latest of the user's messages itself asks for a picture/);
  assert.match(prompts[0], /画一只穿宇航服的猫/);

  decision = "ask";
  const unasked = { prompt: "An illustration of the quarterly numbers" };
  assert.equal(await needsApproval(unasked, { messages: [{ role: "user", content: "Summarise the quarter." }] }), true);
  assert.equal((unasked as { autoReview?: { decision: string } }).autoReview?.decision, "ask");

  for (const rule of ["acceptEdits", "auto"]) {
    await db.chat.update({ where: { id: chat.id }, data: { approvalRule: rule } });
    const input = { prompt: `Another picture under ${rule}` };
    assert.equal(await needsApproval(input, { messages: [{ role: "user", content: "Tell me about cats." }] }), true, rule);
  }
  const reviews = prompts.length;
  await db.chat.update({ where: { id: chat.id }, data: { approvalRule: "full" } });
  assert.equal(await needsApproval({ prompt: "Full access" }, { messages: [{ role: "user", content: "Tell me about cats." }] }), false);
  assert.equal(prompts.length, reviews, "full access needs no review");
});

test("a failed review waits for the user", async (t: TestContext) => {
  const chat = await db.chat.create({ data: { title: "Down", approvalRule: "acceptEdits" } });
  t.mock.method(languageModel, "doGenerate", async () => { throw new Error("reviewer down"); });
  const tools = await createChatToolSet({ chatId: chat.id, modelRef: CHAT_MODEL_REF, runId: "run-down" });
  assert.equal(await (tools.generateImage.needsApproval as Approval)({ prompt: "A cat" }, { messages: [{ role: "user", content: "Draw a cat" }] }), true);
});

test("the model draws in a turn: the picture is stored, shown, kept with the answer, and handed back for the model to check", { timeout: 30_000 }, async (t: TestContext) => {
  const chat = await db.chat.create({ data: { title: "Draw", approvalRule: "full" } });
  const prompts = drawsOnce(t, { prompt: "A cat in a white spacesuit floating above the Moon", aspectRatio: "16:9" });
  const response = await route.POST(request({ chatId: chat.id, messages: [ui("draw-user", "画一只穿宇航服的猫，16:9")] }));
  assert.equal(response.status, 200);
  assert.match(await wireText(response), /Here it is\./);

  assert.equal(providerState.imageCalls.length, 1);
  assert.equal(providerState.imageCalls[0].aspectRatio, "16:9", "the requested ratio reaches the image model");
  assert.equal(providerState.imageCalls[0].prompt, "A cat in a white spacesuit floating above the Moon");
  const { row, payload } = await savedAnswer(chat.id);
  const call = payload.tools.find(tool => tool.toolName === "generateImage")!;
  assert.equal(call.state, "output-available");
  const asset = await storage.getMediaAsset(call.output!.mediaId!);
  assert.deepEqual([asset.kind, asset.sourceChatId, asset.description], ["generated-image", chat.id, "A cat in a white spacesuit floating above the Moon"]);
  assert.equal((asset.generation as { aspectRatio?: string }).aspectRatio, "16:9", "the recipe keeps the ratio for regeneration");
  assert.equal(await db.messageMedia.count({ where: { messageId: row.id, assetId: asset.id } }), 1, "the answer refers to its picture, so cleanup leaves it");
  assert.doesNotMatch(row.content, /iVBOR|base64/, "the saved answer names its picture; the bytes stay in the media store");
  await assert.rejects(storage.deleteMediaAsset(asset.id));
  // The model that can see images gets the picture back on the next step.
  assert.match(prompts[1], /"type":"image-data","data":"iVBOR/);
  assert.match(prompts[1], /imageAttached\\?":true/);
  assert.match(prompts[1], new RegExp(asset.id));
  // The conversation draws it as a picture card.
  assert.deepEqual(generatedPictures([{ type: "tool-generateImage", toolCallId: "c", state: "output-available", input: { prompt: "p" }, output: call.output }]).map(picture => picture.url), [mediaUrl(asset.id)]);
  assert.deepEqual(generatedPictures([{ type: "tool-generateImage", toolCallId: "c", state: "output-error" }]), []);
});

test("under ask, a picture the user asked for is reviewed, then made in the same turn with the verdict kept on the call", { timeout: 30_000 }, async (t: TestContext) => {
  const chat = await db.chat.create({ data: { title: "Ask draw", approvalRule: "ask" } });
  t.mock.method(languageModel, "doGenerate", async () => reply(verdict("allow", "用户要求画图。")));
  drawsOnce(t, { prompt: "A cat in a white spacesuit" });
  const response = await route.POST(request({ chatId: chat.id, messages: [ui("ask-draw", "画一只穿宇航服的猫")] }));
  assert.equal(response.status, 200);
  await response.text();
  const { payload } = await savedAnswer(chat.id);
  const call = payload.tools.find(tool => tool.toolName === "generateImage") as { state: string; input?: { autoReview?: unknown }; output?: { mediaId?: string } };
  assert.equal(call.state, "output-available", JSON.stringify(call));
  assert.deepEqual(call.input?.autoReview, { decision: "allow", reason: "用户要求画图。" });
  assert.ok(await storage.getMediaAsset(call.output!.mediaId!));
  assert.equal(providerState.imageCalls.length, 1);
});

test("a checklist reminder never replaces the user's image request in the approval review", async (t: TestContext) => {
  const chat = await db.chat.create({ data: { title: "Checklist and picture", approvalRule: "ask" } });
  const attachment = await storage.createMediaAsset({ bytes: distinctPng(15), mediaType: "image/png", kind: "attachment" });
  const reviewer = t.mock.method(languageModel, "doGenerate", async () => reply(verdict("allow", "用户要求画图。")));
  const steps: string[] = [];
  t.mock.method(languageModel, "doStream", async ({ prompt }: { prompt: unknown }) => {
    const step = steps.length;
    steps.push(JSON.stringify(prompt));
    const calls = step === 0 ? Array.from({ length: 5 }, (_, i) => ({ type: "tool-call" as const, toolCallId: `check-${i}`, toolName: "checkSubagents", input: "{}" }))
      : step === 1 ? [{ type: "tool-call" as const, toolCallId: "draw-after-checks", toolName: "generateImage", input: '{"prompt":"A red tree"}' }] : [];
    return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      for (const call of calls) controller.enqueue(call);
      if (!calls.length) {
        controller.enqueue({ type: "text-start", id: "t" });
        controller.enqueue({ type: "text-delta", id: "t", delta: "Done." });
        controller.enqueue({ type: "text-end", id: "t" });
      }
      controller.enqueue({ type: "finish", finishReason: { unified: calls.length ? "tool-calls" : "stop", raw: undefined }, usage });
      controller.close();
    } }) };
  });
  await (await route.POST(request({ chatId: chat.id, messages: [ui("draw-with-checks", "检查进度，然后画一棵红色的树。", [{ url: mediaUrl(attachment.id), mediaType: "image/png" }])] }))).text();
  assert.match(steps[1], /Note from RiA, not from the user/);
  assert.equal(reviewer.mock.callCount(), 1);
  const [reviewInput] = reviewer.mock.calls[0].arguments as unknown as [{ prompt: unknown }];
  assert.match(JSON.stringify(reviewInput.prompt), /检查进度，然后画一棵红色的树/);
  assert.doesNotMatch(JSON.stringify(reviewInput.prompt), /Note from RiA, not from the user/);
  assert.doesNotMatch(JSON.stringify(reviewInput.prompt), /Image attachment, media id/);
  assert.equal(providerState.imageCalls.length, 1);
});

test("a model that cannot see images gets the facts without the picture", { timeout: 30_000 }, async (t: TestContext) => {
  const chat = await db.chat.create({ data: { title: "Text only", approvalRule: "full" } });
  const prompts = drawsOnce(t, { prompt: "A lighthouse at dusk" });
  const response = await route.POST(request({ chatId: chat.id, model: TEXT_ONLY, messages: [ui("text-user", "Draw a lighthouse at dusk")] }));
  assert.equal(response.status, 200);
  await response.text();
  const { payload } = await savedAnswer(chat.id);
  const id = payload.tools.find(tool => tool.toolName === "generateImage")!.output!.mediaId!;
  assert.match(prompts[1], new RegExp(id));
  assert.match(prompts[1], /"imageAttached":false/);
  assert.match(prompts[1], /You did not receive the image/);
  assert.match(prompts[1], /Do not offer to inspect it by having the user send it again/);
  assert.doesNotMatch(prompts[0], /A picture just generated in this turn/);
  assert.doesNotMatch(prompts[1], /"prompt":"A lighthouse at dusk"[^}]*"imageAttached"/);
  assert.doesNotMatch(prompts[1], /image-data/);
});

test("the image result follows the current model when a fallback handles the turn", async () => {
  const asset = await storage.createMediaAsset({ bytes: distinctPng(4), mediaType: "image/png", kind: "generated-image" });
  let activeModel = CHAT_MODEL_REF;
  const tools = await createChatToolSet({ modelRef: CHAT_MODEL_REF, activeModel: () => activeModel });
  const output = { mediaId: asset.id };
  const project = tools.generateImage.toModelOutput!;
  const call = { output, toolCallId: "picture", input: { prompt: "A cat" } };
  assert.equal((await project(call)).type, "content");
  activeModel = { ...CHAT_MODEL_REF, modelId: TEXT_ONLY.modelId };
  assert.equal((await project(call)).type, "json");
  activeModel = CHAT_MODEL_REF;
  assert.equal((await project(call)).type, "content");
});

test("chat, image mode and library regeneration share one configurable quota", async (t: TestContext) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const chat = await db.chat.create({ data: { title: "Image quota", approvalRule: "full" } });
  const tools = await createChatToolSet({ chatId: chat.id, modelRef: CHAT_MODEL_REF });
  const drawInChat = (toolCallId: string) => tools.generateImage.execute!({ prompt: "Draw a tree" }, { toolCallId, messages: [] });
  const inImageMode = () => imageRoute.POST(new NextRequest("http://localhost/api/image", {
    method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Draw a tree" }),
  }));
  const original = await inImageMode();
  assert.equal(original.status, 200);
  const id = (await original.json()).asset.assetId;
  const regenerate = () => regenerateRoute.POST(new NextRequest(`http://localhost/api/media/${id}/regenerate`, {
    method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  }), { params: Promise.resolve({ id }) });
  for (let i = 0; i < 7; i++) {
    assert.equal((await regenerate()).status, 201);
  }
  for (let i = 0; i < 4; i++) {
    await drawInChat(`draw-${i}`);
  }
  assert.equal((await inImageMode()).status, 429);
  const regenerationLimited = await regenerate();
  assert.equal(regenerationLimited.status, 429);
  assert.ok(Number(regenerationLimited.headers.get("Retry-After")) > 0);
  const limited = await drawInChat("limited");
  assert.equal((limited as { skipped?: string }).skipped, "temporarilyUnavailable");
  assert.equal(providerState.imageCalls.length, 12);

  const settings = await getModelPreferences();
  await saveModelPreferences({ ...settings, callLimits: { ...settings.callLimits, imageRequestsPerMinute: 13 } });
  assert.equal((await inImageMode()).status, 200);
  assert.equal((await regenerate()).status, 429);
  assert.equal(providerState.imageCalls.length, 13);

  await saveModelPreferences({ ...settings, callLimits: { ...settings.callLimits, imageRequestsPerMinute: 3 } });
  const runTogether = async (toolCallId: string) => {
    const results = await Promise.all([inImageMode(), regenerate(), inImageMode(), regenerate(), drawInChat(toolCallId)]);
    return results.map(result => {
      if (result instanceof Response) {
        assert.ok([200, 201, 429].includes(result.status));
        return result.ok;
      }
      assert.ok(result && typeof result === "object");
      return "mediaId" in result;
    });
  };
  assert.deepEqual(await runTogether("parallel-before-reset"), Array(5).fill(false), "the lower limit applies before the old window expires");
  assert.equal(providerState.imageCalls.length, 13);

  now += 60_000;
  assert.equal((await runTogether("parallel-after-reset")).filter(Boolean).length, 3, "parallel callers share the three newly available places");
  assert.equal(providerState.imageCalls.length, 16);
});

test("an image request racing a queued lower limit cannot spend against obsolete settings", async (t: TestContext) => {
  const draw = () => generateStoredMedia("image", { prompt: "Draw a tree" }, new AbortController().signal);
  await draw();
  const settings = await getModelPreferences();
  const delegate = db.workspacePreference;
  const findUnique = delegate.findUnique;
  const oldRow = await delegate.findUnique({ where: { id: "local" } });
  assert.ok(oldRow);

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocked = withModelSettingsLock(() => gate);
  const saving = saveModelPreferences({ ...settings, callLimits: { ...settings.callLimits, imageRequestsPerMinute: 1 } });
  let saveQueued = true;
  // A read that starts before the write can deliver the old row after the save.
  t.after(() => { release(); delegate.findUnique = findUnique; });
  Reflect.set(delegate, "findUnique", (...args: Parameters<typeof findUnique>) =>
    saveQueued ? saving.then(() => oldRow) : findUnique.apply(delegate, args));
  const outcome = assert.rejects(draw(), { code: "RATE_LIMITED" });
  saveQueued = false;
  release();
  await Promise.all([blocked, saving, outcome]);
  assert.equal(providerState.imageCalls.length, 1);
});

test("a failed read tells a vision model that the finished picture could not be attached", async () => {
  const mediaId = "00000000-0000-4000-8000-000000000000";
  const result = await generatedImageForModel({ mediaId, prompt: "A lighthouse at dusk" }, true);
  assert.equal(result.type, "json");
  assert.match(JSON.stringify(result), /"imageAttached":false.*cannot verify the contents/);
  assert.doesNotMatch(JSON.stringify(result), /lighthouse/);
});

test("an image provider's balance refusal does not tell the model to configure an image model", async (t: TestContext) => {
  const chat = await db.chat.create({ data: { title: "Draw without balance", approvalRule: "full" } });
  t.mock.method(getImageModel(), "doGenerate", async () => { throw Object.assign(new Error("No balance"), { statusCode: 402 }); });
  const prompts = drawsOnce(t, { prompt: "Draw a tree" });
  await (await route.POST(request({ chatId: chat.id, messages: [ui("no-balance", "Draw a tree")] }))).text();
  assert.match(prompts[1], /"skipped":"temporarilyUnavailable"/);
  assert.match(prompts[1], /OpenRouter.*(?:余额不足|balance)/);
  assert.doesNotMatch(prompts[1], /choose a default image model/);
});

test("scheduled turns reserve image costs before generation and user-started turns can still draw", async (t: TestContext) => {
  await db.modelRequest.deleteMany({});
  await db.modelCallDay.deleteMany({});
  const settings = await seedTestModelPreferences(db);
  settings.callLimits.backgroundMaxEstimatedUsd = 0.025;
  settings.callLimits.backgroundDailyEstimatedUsd = 0.035;
  const imageKey = modelRefKey(IMAGE_MODEL_REF);
  const configureRate = async (perRequest: number | null) => {
    settings.rates[imageKey] = { inputPerMillion: null, outputPerMillion: null, perRequest };
    await db.workspacePreference.update({ where: { id: "local" }, data: { settings } });
  };
  const run = async (callSource: "scheduled" | "chat") => {
    const chat = await db.chat.create({ data: { title: "Picture task", approvalRule: "full" } });
    drawsOnce(t, { prompt: "Draw a red tree" });
    assert.equal((await runUnattendedTurn({ chatId: chat.id, text: "Draw a red tree", callSource, signal: new AbortController().signal })).status, "succeeded");
    return db.agentStep.findFirstOrThrow({ where: { run: { chatId: chat.id }, toolName: "generateImage" } });
  };

  await configureRate(null);
  assert.equal((await run("scheduled")).errorCode, "BACKGROUND_LIMIT");
  await configureRate(0.03);
  assert.equal((await run("scheduled")).errorCode, "BACKGROUND_LIMIT");
  assert.equal(providerState.imageCalls.length, 0);
  assert.equal(await db.modelRequest.count({ where: { source: "media" } }), 0);

  await configureRate(0.02);
  assert.equal((await run("scheduled")).errorCode, null);
  assert.equal((await run("scheduled")).errorCode, "BACKGROUND_LIMIT");
  assert.equal(providerState.imageCalls.length, 1);
  assert.equal((await db.modelCallDay.findFirstOrThrow({ where: { day: { not: "lock" } } })).estimatedUsd, 0.02);
  const row = await db.modelRequest.findFirstOrThrow({ where: { source: "media", mode: "image" } });
  assert.deepEqual([row.estimatedUsd, row.costUsd, row.costSource], [0.02, 0.02, "configured"]);
  assert.equal((await run("chat")).errorCode, null);
  assert.equal(providerState.imageCalls.length, 2);
  assert.equal((await db.modelCallDay.findFirstOrThrow({ where: { day: { not: "lock" } } })).estimatedUsd, 0.02);
});

test("concurrent scheduled image requests cannot both spend the last daily allowance", async () => {
  await db.modelCallDay.deleteMany({});
  const settings = await getModelPreferences();
  await saveModelPreferences({
    ...settings,
    callLimits: { ...settings.callLimits, imageRequestsPerMinute: 2, backgroundDailyEstimatedUsd: 0.03 },
    rates: { ...settings.rates, [modelRefKey(IMAGE_MODEL_REF)]: { inputPerMillion: null, outputPerMillion: null, perRequest: 0.02 } },
  });
  const draw = () => generateStoredMedia("image", { prompt: "Draw a tree" }, new AbortController().signal, { background: true });
  const results = await Promise.allSettled([draw(), draw()]);
  assert.deepEqual(results.map(result => result.status).sort(), ["fulfilled", "rejected"]);
  for (const result of results) {
    if (result.status === "rejected") assert.equal(result.reason.code, "BACKGROUND_LIMIT");
  }
  assert.equal(providerState.imageCalls.length, 1);
  assert.equal((await db.modelCallDay.findFirstOrThrow({ where: { day: { not: "lock" } } })).estimatedUsd, 0.02);
});

test("scheduled edits admit each image model at its own rate and keep the failed primary reservation", async (t: TestContext) => {
  await db.modelRequest.deleteMany({});
  await db.modelCallDay.deleteMany({});
  const settings = await getModelPreferences();
  settings.image.fallback = FALLBACK_IMAGE_MODEL;
  settings.callLimits.backgroundMaxEstimatedUsd = 0.025;
  settings.callLimits.backgroundDailyEstimatedUsd = 0.025;
  const primaryKey = modelRefKey(IMAGE_MODEL_REF);
  const fallbackKey = modelRefKey(FALLBACK_IMAGE_MODEL);
  settings.rates[primaryKey] = { inputPerMillion: null, outputPerMillion: null, perRequest: 0.01 };
  const configure = async (fallbackRate: number | null, primaryAcceptsImages = true) => {
    settings.rates[fallbackKey] = { inputPerMillion: null, outputPerMillion: null, perRequest: fallbackRate };
    settings.library = settings.library.map(item => item.modelId === IMAGE_MODEL_REF.modelId ? { ...item, endpointImageInput: primaryAcceptsImages } : item);
    await db.workspacePreference.update({ where: { id: "local" }, data: { settings } });
  };
  const input = await storage.createMediaAsset({ bytes: testPng, kind: "generated-image", mediaType: "image/png" });
  const imageModel = getImageModel();
  const generate = imageModel.doGenerate.bind(imageModel);
  let providerCalls = 0;
  t.mock.method(imageModel, "doGenerate", async (options: Parameters<typeof generate>[0]) => {
    providerCalls++;
    if (providerCalls === 1) throw Object.assign(new Error("Unavailable"), { statusCode: 503 });
    return generate(options);
  });
  const run = async () => {
    const chat = await db.chat.create({ data: { title: "Scheduled image edit", approvalRule: "full" } });
    await saveChatMessage({ chatId: chat.id, role: "user", content: "Draw a red tree" });
    await saveChatMessage({ chatId: chat.id, role: "assistant", content: encodeMediaMessage({
      type: "image-result", assetId: input.id, modelId: IMAGE_MODEL_REF.modelId, text: "Image ready",
    }) });
    const prompts = drawsOnce(t, { prompt: "Change the tree to green", referenceImages: [input.id] });
    const result = await runUnattendedTurn({ chatId: chat.id, text: "Change it to green", callSource: "scheduled", signal: new AbortController().signal });
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.match(prompts[0], new RegExp(input.id));
    return db.agentStep.findFirstOrThrow({ where: { run: { chatId: chat.id }, toolName: "generateImage" } });
  };
  const ledger = () => db.modelRequest.findMany({ where: { source: "media" }, select: {
    modelId: true, fallback: true, estimatedUsd: true, status: true,
  }, orderBy: { createdAt: "asc" } });
  const counter = async () => (await db.modelCallDay.findFirstOrThrow({ where: { day: { not: "lock" } } })).estimatedUsd;

  await configure(0.02);
  assert.equal((await run()).errorCode, "BACKGROUND_LIMIT", "the fallback fits the per-call limit but not the remaining daily allowance");
  assert.equal(providerCalls, 1);
  const failedPrimary = { modelId: IMAGE_MODEL_REF.modelId, fallback: false, estimatedUsd: 0.01, status: "error" };
  assert.deepEqual(await ledger(), [failedPrimary]);
  assert.equal(await counter(), 0.01);

  await configure(null, false);
  assert.equal((await run()).errorCode, "BACKGROUND_LIMIT", "skipping an incompatible primary still requires a known fallback rate");
  await configure(0.03, false);
  assert.equal((await run()).errorCode, "BACKGROUND_LIMIT", "the direct fallback still checks its per-call limit");
  assert.equal(providerCalls, 1);
  assert.deepEqual(await ledger(), [failedPrimary]);

  await configure(0.01, false);
  assert.equal((await run()).errorCode, null);
  assert.equal(providerCalls, 2);
  assert.equal(await counter(), 0.02);
  assert.deepEqual(await ledger(), [failedPrimary, { modelId: FALLBACK_IMAGE_MODEL.modelId, fallback: true, estimatedUsd: 0.01, status: "success" }]);
});

test("approving a picture requested by a scheduled turn still checks its background ceiling", async (t: TestContext) => {
  const settings = await seedTestModelPreferences(db);
  settings.callLimits.backgroundMaxEstimatedUsd = 0.02;
  settings.image.fallback = FALLBACK_IMAGE_MODEL;
  settings.library = settings.library.map(item => item.modelId === IMAGE_MODEL_REF.modelId ? { ...item, endpointImageInput: false } : item);
  settings.rates[modelRefKey(FALLBACK_IMAGE_MODEL)] = { inputPerMillion: null, outputPerMillion: null, perRequest: 0.03 };
  await db.workspacePreference.update({ where: { id: "local" }, data: { settings } });
  const chat = await db.chat.create({ data: { title: "Picture task needs approval", approvalRule: "ask" } });
  const input = await storage.createMediaAsset({ bytes: testPng, kind: "generated-image", mediaType: "image/png" });
  const reviewSources: string[] = [];
  t.mock.method(languageModel, "doGenerate", async () => {
    reviewSources.push(modelCallSource());
    return reply(verdict("ask", "用户没有要求画图。"));
  });
  drawsOnce(t, { prompt: "Draw an illustration of the morning news", referenceImages: [input.id] });
  const outcome = await runUnattendedTurn({ chatId: chat.id, text: "Summarise the morning news", callSource: "scheduled", signal: new AbortController().signal });
  assert.equal(outcome.status, "waiting_approval", JSON.stringify(outcome));
  assert.deepEqual(reviewSources, ["scheduled"]);
  const { messages } = await storedFromSummary(chat.id);
  const pending = messages.at(-1)?.parts.find(part => "state" in part && part.type === "tool-generateImage" && part.state === "approval-requested");
  assert.ok(pending && "approval" in pending && pending.approval);
  Object.assign(pending, { state: "approval-responded", approval: { ...pending.approval, approved: true } });
  const response = await route.POST(request({ chatId: chat.id, messages }));
  assert.equal(response.status, 200, response.ok ? undefined : await response.text());
  await response.text();
  assert.equal(providerState.imageCalls.length, 0);
  const steps = await db.agentStep.findMany({ where: { run: { chatId: chat.id }, toolName: "generateImage", errorCode: "BACKGROUND_LIMIT" } });
  assert.equal(steps.length, 1);
});

test("a later chat turn edits a large generated picture using a reference-capable fallback", { timeout: 30_000 }, async (t: TestContext) => {
  const chat = await db.chat.create({ data: { title: "Edit", approvalRule: "full" } });
  const largePicture = Buffer.alloc(MEDIA_LIMITS.attachmentBytes + 1);
  testPng.copy(largePicture);
  const imageModel = getImageModel();
  const generate = imageModel.doGenerate.bind(imageModel);
  t.mock.method(imageModel, "doGenerate", async (options: Parameters<typeof generate>[0]) => ({ ...await generate(options), images: [largePicture] }));
  drawsOnce(t, { prompt: "A cat on a sofa, daylight" });
  await (await route.POST(request({ chatId: chat.id, model: TEXT_ONLY, messages: [ui("first", "Draw a cat on a sofa")] }))).text();
  const first = await savedAnswer(chat.id);
  const id = first.payload.tools.find(tool => tool.toolName === "generateImage")!.output!.mediaId!;
  assert.equal((await storage.getMediaAsset(id)).byteSize, largePicture.byteLength);
  t.mock.restoreAll();
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {});
  const settings = await getModelPreferences();
  settings.image.fallback = FALLBACK_IMAGE_MODEL;
  settings.library = settings.library.map(item => item.modelId === IMAGE_MODEL_REF.modelId ? { ...item, endpointImageInput: null } : item);
  await db.workspacePreference.update({ where: { id: "local" }, data: { settings } });
  await db.modelRequest.deleteMany({ where: { source: "media" } });
  const prompts = drawsOnce(t, { prompt: "The same cat on the same sofa, at night", referenceImages: [id] });
  const response = await route.POST(request({ chatId: chat.id, model: TEXT_ONLY, messages: [ui("second", "Now make it night")] }));
  assert.equal(response.status, 200, response.ok ? undefined : await response.text());
  await response.text();
  assert.match(prompts[0], new RegExp(id), "the earlier turn's result names the picture");
  assert.match(prompts[0], /"imageAttached":false/, "the historical tool result declares that it carries no pixels");
  const files = providerState.imageCalls.at(-1).files;
  assert.equal(files.length, 1);
  assert.ok(largePicture.equals(files[0].data), "the fallback receives the entire original");
  const second = await savedAnswer(chat.id);
  const made = await storage.getMediaAsset(second.payload.tools.find(tool => tool.toolName === "generateImage")!.output!.mediaId!);
  assert.equal(made.modelId, FALLBACK_IMAGE_MODEL.modelId);
  assert.deepEqual((made.generation as { inputImages: { assetId: string }[] }).inputImages.map(input => input.assetId), [id], "the reference is recorded, so it is protected");
  assert.deepEqual(await db.modelRequest.findMany({ where: { source: "media" }, select: { modelId: true, fallback: true, status: true } }), [
    { modelId: FALLBACK_IMAGE_MODEL.modelId, fallback: true, status: "success" },
  ]);
});

test("a reference that is not a stored picture fails the call, without reaching the image model", async () => {
  const chat = await db.chat.create({ data: { title: "Bad ref", approvalRule: "full" } });
  const tools = await createChatToolSet({ chatId: chat.id, modelRef: CHAT_MODEL_REF });
  const execute = tools.generateImage.execute as (input: unknown, options: unknown) => Promise<unknown>;
  await assert.rejects(execute({ prompt: "A cat", referenceImages: ["00000000-0000-4000-8000-000000000000"] }, { toolCallId: "bad", messages: [] }));
  await assert.rejects(execute({ prompt: "A cat", referenceImages: ["../../secret"] }, { toolCallId: "bad2", messages: [] }));
  assert.equal(providerState.imageCalls.length, 0);
});

test("a picture deleted before its tool answer is saved does not discard the answer or its other references", async (t: TestContext) => {
  const chat = await db.chat.create({ data: { title: "Picture deleted from the library" } });
  const gone = await storage.createMediaAsset({ bytes: testPng, kind: "generated-image", mediaType: "image/png" });
  const kept = await storage.createMediaAsset({ bytes: testPng, kind: "generated-image", mediaType: "image/png" });
  const content = encodePersistedAssistantToolMessage({
    type: "assistant-tool-message",
    text: "The pictures are ready.",
    tools: [gone, kept].map(asset => ({
      toolName: "generateImage", toolCallId: asset.id, state: "output-available", input: { prompt: "A tree" }, output: { mediaId: asset.id },
    })),
  });
  const transaction = db.$transaction;
  t.after(() => { db.$transaction = transaction; });
  db.$transaction = (async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
    // Claim deletion after message preparation, before any message/reference writes.
    await db.mediaAsset.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    return transaction.call(db, work);
  }) as typeof db.$transaction;
  const answer = await saveChatMessage({ chatId: chat.id, role: "assistant", content });
  assert.equal(answer.content, content);
  assert.deepEqual(await db.messageMedia.findMany({ where: { messageId: answer.id }, select: { assetId: true } }), [{ assetId: kept.id }]);
});

test("stopping the turn reaches the image model's call", async () => {
  const chat = await db.chat.create({ data: { title: "Stop", approvalRule: "full" } });
  const tools = await createChatToolSet({ chatId: chat.id, modelRef: CHAT_MODEL_REF });
  const execute = tools.generateImage.execute as (input: unknown, options: unknown) => Promise<unknown>;
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(execute({ prompt: "A cat" }, { toolCallId: "early", abortSignal: stopped.signal, messages: [] }), (error: Error) => error.name === "AbortError");
  assert.equal(providerState.imageCalls.length, 0, "a stopped turn does not start a picture");
  let release!: () => void;
  providerState.imageGate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { providerState.imageEntered = resolve; });
  const controller = new AbortController();
  const running = execute({ prompt: "A dog" }, { toolCallId: "late", abortSignal: controller.signal, messages: [] }).catch(error => error);
  await entered;
  controller.abort();
  release();
  await running;
  assert.equal(providerState.imageCalls.at(-1).abortSignal?.aborted, true, "the provider call carries the turn's signal");
});

test("sub-agents are not given the tool", async () => {
  const tools = await createChatToolSet({ modelRef: CHAT_MODEL_REF, subagent: { parentToolCallId: "parent", userText: ["Draw a cat"] } });
  assert.equal("generateImage" in tools, false);
});

test("images in history carry their media ids: uploads, image-mode results, and for a text-only model a line in place of the picture", { timeout: 30_000 }, async (t: TestContext) => {
  const chat = await db.chat.create({ data: { title: "History" } });
  const upload = await storage.createMediaAsset({ bytes: distinctPng(7), mediaType: "image/png", kind: "attachment" });
  const made = await storage.createMediaAsset({ bytes: distinctPng(8), mediaType: "image/png", kind: "generated-image", modelId: "mock-image" });
  await saveChatMessage({ chatId: chat.id, role: "user", clientMessageId: "m-user", content: encodePersistedUserMessage({ type: "user-message", text: "A red fox", files: [{ url: mediaUrl(upload.id), mediaType: "image/png" }] }) });
  await saveChatMessage({ chatId: chat.id, role: "assistant", clientMessageId: "m-made", content: encodeMediaMessage({ type: "image-result", assetId: made.id, modelId: "mock-image", text: "图片生成完成 · mock-image" }) });
  const prompts: string[] = [];
  t.mock.method(languageModel, "doStream", async (options: { prompt: unknown }) => {
    prompts.push(JSON.stringify(options.prompt));
    return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "a" }); controller.enqueue({ type: "text-delta", id: "a", delta: "OK" }); controller.enqueue({ type: "text-end", id: "a" });
      controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage });
      controller.close();
    } }) };
  });
  const history: UIMessage[] = [
    ui("m-user", "A red fox", [{ url: mediaUrl(upload.id), mediaType: "image/png" }]),
    { id: "m-made", role: "assistant", parts: [{ type: "text", text: "图片生成完成 · mock-image" }] },
  ];
  await (await route.POST(request({ chatId: chat.id, messages: [...history, ui("m-next", "Make the fox blue")] }))).text();
  assert.match(prompts[0], new RegExp(`Image attachment, media id: ${upload.id}`));
  assert.match(prompts[0], new RegExp(`Picture made in the image mode by mock-image[^\\]]*media id: ${made.id}`));
  await (await route.POST(request({ chatId: chat.id, model: TEXT_ONLY, messages: [...history, ui("m-next-2", "Make the fox green")] }))).text();
  assert.match(prompts[1], new RegExp(`An image was attached here, media id: ${upload.id}; this model cannot see images`));
  assert.doesNotMatch(prompts[1], /data:image\/png;base64/);
});

test("a picture as base64 is estimated by its size, not as text", () => {
  const png = Buffer.alloc(400_000); png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  png.writeUInt32BE(1024, 16); png.writeUInt32BE(1024, 20);
  const base64 = png.toString("base64");
  const asPart = estimateContextTokens({ type: "tool-result", output: { type: "content", value: [{ type: "text", text: "{}" }, { type: "image-data", data: base64, mediaType: "image/png" }] } });
  const asUrl = estimateContextTokens({ type: "file", mediaType: "image/png", data: `data:image/png;base64,${base64}` });
  for (const tokens of [asPart, asUrl]) assert.ok(tokens < 2_000, `estimated at ${tokens}`);
});

test("text in the image mode that reads as a question is noticed", () => {
  for (const text of ["为什么天空是蓝色的？", "这张图好看吗", "How do I draw a cat", "what is a good poster?", "怎么画猫"]) assert.equal(looksLikeQuestion(text), true, text);
  for (const text of ["", "一只穿宇航服的猫，赛博朋克风格", "A lighthouse at dusk, oil painting", "Draw a cat"]) assert.equal(looksLikeQuestion(text), false, text);
});
