import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database.mjs";
import { testPng, testVideo, providerState, getImageModel, getVideoModel } from "../helpers/model-provider.mjs";

const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const { createSession } = await import("@/lib/auth/session");
const { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } = await import("@/config/model");
const storage = await import("@/lib/media/storage");
const { saveChatMessage } = await import("@/lib/chat/store");
const { encodeMediaMessage } = await import("@/lib/media/message-codec");
const routes = {
  library: await import("@/app/api/media/library/route"), details: await import("@/app/api/media/[id]/details/route"),
  regenerate: await import("@/app/api/media/[id]/regenerate/route"), media: await import("@/app/api/media/[id]/route"),
  image: await import("@/app/api/image/route"), video: await import("@/app/api/video/route"),
};
let user, other, cookie, otherCookie;
const context = id => ({ params: Promise.resolve({ id }) });
const req = (url, method = "GET", body, session = cookie, headers = {}) => new NextRequest(`http://localhost${url}`, { method, headers: { cookie: session, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
async function payload(response, status = 200) { assert.equal(response.status, status, await response.clone().text()); return response.json(); }
async function image(owner = user) { return storage.createMediaAsset({ userId: owner.id, bytes: testPng, kind: "attachment", mediaType: "image/png", description: "Uploaded image" }); }
async function chat(owner = user) { return db.chat.create({ data: { userId: owner.id, title: "Media source" } }); }
async function generate(type = "image", body = {}) { return payload(await routes[type].POST(req(`/api/${type}`, "POST", { prompt: "Original prompt", ...body }))); }
async function detail(id, session = cookie) { return (await payload(await routes.details.GET(req(`/api/media/${id}/details`, "GET", undefined, session), context(id)))).data; }
async function regenerate(id, body = { confirm: true }, session = cookie) { return routes.regenerate.POST(req(`/api/media/${id}/regenerate`, "POST", body, session), context(id)); }
beforeEach(async t => {
  t.mock.method(console, "error", () => {});
  process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  globalThis.__privateAiRateLimitStore?.clear();
  providerState.imageCalls.length = 0; providerState.videoCalls.length = 0;
  user = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  other = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  cookie = `app_session=${await createSession(user.id)}`; otherCookie = `app_session=${await createSession(other.id)}`;
});
after(async () => { await db.$disconnect(); cleanup(); });

test("media library paginates equal timestamps, scopes filters and hides foreign or deleted assets", async () => {
  const rows = [];
  for (let i = 0; i < 27; i++) rows.push(await image());
  const video = await storage.createMediaAsset({ userId: user.id, bytes: testVideo, kind: "generated-video", mediaType: "video/mp4" });
  await image(other);
  await db.mediaAsset.updateMany({ where: { userId: user.id }, data: { createdAt: new Date(1000) } });
  await db.mediaAsset.update({ where: { id: rows[0].id }, data: { deletedAt: new Date() } });
  const first = await payload(await routes.library.GET(req("/api/media/library")));
  assert.equal(first.data.length, 24);
  assert.equal(JSON.stringify(first).includes("relativePath"), false);
  assert.equal((await payload(await routes.library.GET(req("/api/media/library?type=video")))).data[0].id, video.id);
  const last = first.data.at(-1).id;
  await storage.deleteMediaAsset(user.id, last);
  const second = await payload(await routes.library.GET(req(`/api/media/library?cursor=${first.pageInfo.nextCursor}`)));
  assert.equal(second.data.length, 3);
  assert.equal(new Set([...first.data, ...second.data].map(asset => asset.id)).size, 27);
  assert.deepEqual((await payload(await routes.library.GET(req("/api/media/library?type=video")))).data.map(asset => asset.id), last === video.id ? [] : [video.id]);
  for (const query of ["limit=101", "limit=0", "type=wrong", "type=image&type=video", "kind=unknown", "usage=wrong", "extra=1", `type=video&cursor=${first.pageInfo.nextCursor}`]) assert.equal((await routes.library.GET(req(`/api/media/library?${query}`))).status, 400);
  assert.equal((await routes.library.GET(req(`/api/media/library?cursor=${first.pageInfo.nextCursor}`, "GET", undefined, otherCookie))).status, 400);
});

test("new generations persist validated parameters, source chats and protected input references", async () => {
  const input = await image(), source = await chat();
  const result = await generate("image", { prompt: "  Original prompt  ", chatId: source.id, inputImages: [{ url: `/api/media/${input.id}`, mediaType: "image/png" }] });
  const output = await detail(result.asset.assetId);
  assert.equal(output.sourceChat.id, source.id); assert.equal(output.modelId, DEFAULT_IMAGE_MODEL);
  assert.deepEqual(output.generation, { version: 1, type: "image", prompt: "Original prompt", modelId: DEFAULT_IMAGE_MODEL, inputImages: [{ assetId: input.id, mediaType: "image/png" }] });
  assert.equal(output.regenerationUnavailable, null);
  assert.equal((await detail(input.id)).generationReferenceCount, 1);
  assert.equal((await routes.media.DELETE(req(`/api/media/${input.id}`, "DELETE"), context(input.id))).status, 409);
  const referenced = await payload(await routes.library.GET(req("/api/media/library?usage=referenced")));
  assert.deepEqual(referenced.data.map(asset => asset.id), [input.id]);
  assert.equal((await storage.getMediaStats(user.id)).referencedCount, 1);
});

test("image regeneration reuses owned inputs, creates a distinct file and leaves history unchanged", async () => {
  const input = await image(), source = await chat();
  const original = await generate("image", { chatId: source.id, inputImages: [{ url: `/api/media/${input.id}`, mediaType: "image/png" }] });
  const message = await saveChatMessage({ chatId: source.id, role: "assistant", content: encodeMediaMessage({ type: "image-result", assetId: original.asset.assetId, modelId: DEFAULT_IMAGE_MODEL, text: "Original answer" }) });
  const result = await payload(await regenerate(original.asset.assetId), 201);
  assert.notEqual(result.asset.assetId, original.asset.assetId);
  assert.equal(providerState.imageCalls.length, 2);
  assert.equal(providerState.imageCalls[1].prompt, providerState.imageCalls[0].prompt);
  assert.deepEqual(providerState.imageCalls[1].files, providerState.imageCalls[0].files);
  assert.equal((await db.message.findUnique({ where: { id: message.id } })).content, message.content);
  assert.equal((await detail(original.asset.assetId)).messageReferenceCount, 1);
  assert.equal((await detail(result.asset.assetId)).messageReferenceCount, 0);
  assert.deepEqual((await detail(result.asset.assetId)).generation, (await detail(original.asset.assetId)).generation);
});

test("video regeneration retains prompt, reference image, aspect ratio, duration and fps", async () => {
  const input = await image();
  const original = await generate("video", { modelId: DEFAULT_VIDEO_MODEL, prompt: "A video", aspectRatio: "9:16", duration: 5, fps: 24, inputImage: { url: `/api/media/${input.id}`, mediaType: "image/png" } });
  await payload(await regenerate(original.asset.assetId), 201);
  const recipe = (await detail(original.asset.assetId)).generation;
  assert.equal(recipe.duration, 5); assert.equal(recipe.fps, 24); assert.equal(recipe.aspectRatio, "9:16");
  for (const field of ["prompt", "duration", "fps", "aspectRatio", "image"]) assert.deepEqual(providerState.videoCalls[1][field], providerState.videoCalls[0][field]);
});

test("cleanup preserves generation dependencies and refreshes their grace period when outputs are deleted", async () => {
  const input = await image();
  const original = await generate("image", { inputImages: [{ url: `/api/media/${input.id}`, mediaType: "image/png" }] });
  await db.mediaAsset.updateMany({ where: { userId: user.id }, data: { lastUsedAt: new Date(0) } });
  const result = await storage.cleanupMedia(user.id);
  assert.equal(result.removedCount, 1);
  assert.equal(result.freedBytes, testPng.length);
  assert.ok((await storage.getMediaAsset(user.id, input.id)).lastUsedAt.getTime() > Date.now() - 30_000);
  assert.equal((await storage.cleanupMedia(user.id)).removedCount, 0);
  assert.equal(await db.mediaGenerationInput.count({ where: { assetId: original.asset.assetId } }), 0);
  await storage.deleteMediaAsset(user.id, input.id);
});

test("legacy media remains browsable without inventing recipes and source deletion leaves generated files intact", async () => {
  const legacy = await storage.createMediaAsset({ userId: user.id, bytes: testPng, kind: "generated-image", mediaType: "image/png", modelId: DEFAULT_IMAGE_MODEL, description: "Legacy prompt" });
  assert.equal((await detail(legacy.id)).generation, null);
  assert.equal((await regenerate(legacy.id)).status, 409);
  const source = await chat();
  const generated = await generate("image", { chatId: source.id });
  await db.chat.delete({ where: { id: source.id } });
  assert.equal((await detail(generated.asset.assetId)).sourceChat, null);
  await db.$disconnect();
  assert.equal((await detail(generated.asset.assetId)).generation.prompt, "Original prompt");
  assert.deepEqual(await storage.readMediaAsset(await storage.getMediaAsset(user.id, generated.asset.assetId)), testPng);
});

test("regeneration requires confirmation and validates ownership, body limits and session expiry before model use", async () => {
  const original = await generate();
  const id = original.asset.assetId;
  for (const body of [{}, { confirm: false }, { confirm: true, prompt: "Injected" }]) assert.equal((await regenerate(id, body)).status, 400);
  assert.equal((await regenerate(id, { confirm: true }, "")).status, 401);
  assert.equal((await regenerate(id, { confirm: true }, otherCookie)).status, 404);
  assert.equal((await routes.details.GET(req(`/api/media/${id}/details`, "GET", undefined, otherCookie), context(id))).status, 404);
  assert.equal((await routes.regenerate.POST(req(`/api/media/${id}/regenerate`, "POST", { confirm: true }, cookie, { "content-length": "17000" }), context(id))).status, 413);
  await db.session.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(0) } });
  assert.equal((await regenerate(id)).status, 401);
  assert.equal(providerState.imageCalls.length, 1);
});

test("regeneration shares generation quotas and enforces desktop Cookie, Host and Origin boundaries", async () => {
  const original = await generate("video");
  await payload(await regenerate(original.asset.assetId), 201); await payload(await regenerate(original.asset.assetId), 201);
  const limited = await regenerate(original.asset.assetId);
  assert.equal(limited.status, 429); assert.ok(limited.headers.get("retry-after"));
  assert.equal(providerState.videoCalls.length, 3);
  assert.equal((await routes.regenerate.POST(req(`/api/media/${original.asset.assetId}/regenerate`, "POST", { confirm: true }, cookie, { origin: "https://outside.invalid" }), context(original.asset.assetId))).status, 403);
  process.env.APP_RUNTIME = "desktop"; process.env.DESKTOP_SERVER_HOST = "127.0.0.1:4111"; process.env.DESKTOP_SESSION_TOKEN = "synthetic-desktop-cookie";
  try { assert.equal((await routes.library.GET(req("/api/media/library"))).status, 403); }
  finally { process.env.APP_RUNTIME = "test"; delete process.env.DESKTOP_SERVER_HOST; delete process.env.DESKTOP_SESSION_TOKEN; }
});

test("missing inputs or configuration fail regeneration without replacing files or messages", async () => {
  const input = await image();
  const original = await generate("image", { inputImages: [{ url: `/api/media/${input.id}`, mediaType: "image/png" }] });
  process.env.OPENROUTER_API_KEY = "";
  assert.equal((await regenerate(original.asset.assetId)).status, 503);
  process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  unlinkSync(join(process.env.MEDIA_DIRECTORY, input.relativePath));
  assert.equal((await regenerate(original.asset.assetId)).status, 404);
  assert.equal(providerState.imageCalls.length, 1);
  assert.deepEqual(await storage.readMediaAsset(await storage.getMediaAsset(user.id, original.asset.assetId)), testPng);
  await db.mediaAsset.update({ where: { id: original.asset.assetId }, data: { generation: { version: 1, type: "image", modelId: "removed/model", prompt: "Old", inputImages: [] } } });
  assert.equal((await regenerate(original.asset.assetId)).status, 409);
});

test("generation cannot assign a foreign conversation or depend on foreign input media", async () => {
  const foreignChat = await chat(other), foreignImage = await image(other);
  assert.equal((await routes.image.POST(req("/api/image", "POST", { prompt: "No write", chatId: foreignChat.id }))).status, 404);
  assert.equal((await routes.image.POST(req("/api/image", "POST", { inputImages: [{ url: `/api/media/${foreignImage.id}`, mediaType: "image/png" }] }))).status, 404);
  assert.equal(providerState.imageCalls.length, 0);
  assert.equal(await db.mediaAsset.count({ where: { userId: user.id } }), 0);
});

test("upstream regeneration failures retain original files, recipes and message references", async t => {
  for (const type of ["image", "video"]) {
    const original = await generate(type);
    const asset = await storage.getMediaAsset(user.id, original.asset.assetId);
    const source = await chat();
    const message = await saveChatMessage({ chatId: source.id, role: "assistant", content: encodeMediaMessage({ type: `${type}-result`, assetId: asset.id, modelId: original.modelId, text: "Retained result" }) });
    t.mock.method(type === "image" ? getImageModel() : getVideoModel(), "doGenerate", async () => { throw new Error("Simulated provider outage"); });
    const failed = await payload(await regenerate(asset.id), 502);
    assert.equal(failed.error.code, "UPSTREAM_FAILED");
    assert.equal(JSON.stringify(failed).includes("Simulated provider outage"), false);
    assert.deepEqual(await storage.readMediaAsset(asset), type === "image" ? testPng : testVideo);
    assert.deepEqual((await storage.getMediaAsset(user.id, asset.id)).generation, asset.generation);
    assert.equal((await db.message.findUnique({ where: { id: message.id } })).content, message.content);
    assert.equal((await detail(asset.id)).messageReferenceCount, 1);
  }
  assert.equal(await db.mediaAsset.count({ where: { userId: user.id } }), 2);
});

test("generation tolerates a removed source chat but cannot resurrect an input deleted during the provider call", async t => {
  const source = await chat();
  const model = getImageModel(), generateImage = model.doGenerate.bind(model);
  const stub = t.mock.method(model, "doGenerate", async options => { await db.chat.delete({ where: { id: source.id } }); return generateImage(options); });
  const created = await generate("image", { chatId: source.id });
  assert.equal((await detail(created.asset.assetId)).sourceChat, null);
  stub.mock.restore();
  const input = await image();
  t.mock.method(model, "doGenerate", async options => { await storage.deleteMediaAsset(user.id, input.id); return generateImage(options); });
  const failed = await routes.image.POST(req("/api/image", "POST", { prompt: "Concurrent deletion", inputImages: [{ url: `/api/media/${input.id}`, mediaType: "image/png" }] }));
  assert.equal(failed.status, 404);
  assert.equal(await db.mediaGenerationInput.count({ where: { inputAssetId: input.id } }), 0);
  assert.equal(await db.mediaAsset.count({ where: { userId: user.id } }), 1);
  const stats = await storage.getMediaStats(user.id);
  assert.equal(stats.looseFileCount, 1);
  assert.equal(stats.reclaimableCount, 0);
});
