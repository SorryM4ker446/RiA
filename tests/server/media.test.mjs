import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database.mjs";
import { testPng, testVideo, languageModel, providerState } from "../helpers/model-provider.mjs";

const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const { createSession } = await import("@/lib/auth/session");
const storage = await import("@/lib/media/storage");
const { prepareMessageMedia } = await import("@/lib/media/messages");
const { encodeMediaMessage, decodeMediaMessage } = await import("@/lib/media/message-codec");
const { encodePersistedUserMessage, decodePersistedUserMessage } = await import("@/lib/ai/ui-message");
const { saveChatMessage, listChatMessagePage, deleteChat } = await import("@/lib/chat/store");
const listChatMessages = async (userId, chatId) => (await listChatMessagePage(userId, chatId, { limit: 50 }))?.data;
const { MEDIA_LIMITS } = await import("@/lib/media/limits");
const { readLimitedBody } = await import("@/lib/server/request-body");
const upload = await import("@/app/api/media/upload/route");
const media = await import("@/app/api/media/[id]/route");
const mediaStats = await import("@/app/api/media/route");
const mediaCleanup = await import("@/app/api/media/cleanup/route");
const imageRoute = await import("@/app/api/image/route");
const videoRoute = await import("@/app/api/video/route");
const chatRoute = await import("@/app/api/chat/route");
const messageRoute = await import("@/app/api/conversations/[id]/messages/[messageId]/route");
const { proxy } = await import("@/proxy");

let user, cookie;
const context = (id, messageId) => ({ params: Promise.resolve({ id, messageId }) });
function request(path, method = "GET", body, session = cookie, headers = {}) {
  return new NextRequest(`http://localhost${path}`, { method, headers: { cookie: session || "", ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function multipart(files) {
  const body = new FormData();
  for (const file of files) body.append("files", file);
  // Route handlers receive wire bytes, not the client's live FormData encoder.
  // Fully encode fixtures so cancelling an oversized request cannot race that encoder.
  const encoded = new Response(body);
  return new NextRequest("http://localhost/api/media/upload", {
    method: "POST", headers: { cookie, "content-type": encoded.headers.get("content-type") },
    body: await encoded.arrayBuffer(),
  });
}
async function createImage() { return storage.createMediaAsset({ userId: user.id, bytes: testPng, mediaType: "image/png", kind: "attachment" }); }
async function newChat() { return db.chat.create({ data: { userId: user.id, title: "Media test" } }); }
function imageContent(asset) { return encodeMediaMessage({ type: "image-result", assetId: asset.id, modelId: "test", text: "Stored image" }); }
beforeEach(async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
  process.env.OPENROUTER_API_KEY = "";
  user = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  cookie = `app_session=${await createSession(user.id)}`;
});
after(async () => { await db.$disconnect(); cleanup(); });

test("upload stores bytes outside the runtime and reads require ownership", async () => {
  const response = await upload.POST(await multipart([new File([testPng], "photo.png", { type: "image/png" })]));
  assert.equal(response.status, 201);
  const asset = (await response.json()).data[0];
  assert.equal(asset.url, `/api/media/${asset.assetId}`);
  assert.deepEqual(readFileSync(join(process.env.MEDIA_DIRECTORY, asset.relativePath)), testPng);
  assert.equal(JSON.stringify(asset).includes("base64"), false);
  const served = await media.GET(request(asset.url), context(asset.assetId));
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), testPng);
  assert.equal((await media.GET(request(asset.url, "GET", undefined, ""), context(asset.assetId))).status, 401);
  const other = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  const otherCookie = `app_session=${await createSession(other.id)}`;
  assert.equal((await media.GET(request(asset.url, "GET", undefined, otherCookie), context(asset.assetId))).status, 404);
  assert.equal((await media.DELETE(request(asset.url, "DELETE", undefined, otherCookie), context(asset.assetId))).status, 404);
});

test("media supports HEAD and bounded byte ranges for video playback", async () => {
  const asset = await storage.createMediaAsset({ userId: user.id, bytes: testVideo, mediaType: "video/mp4", kind: "generated-video" });
  const head = await media.HEAD(request(`/api/media/${asset.id}`), context(asset.id));
  assert.equal(head.headers.get("content-length"), String(testVideo.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const range = await media.GET(request(`/api/media/${asset.id}`, "GET", undefined, cookie, { range: "bytes=4-7" }), context(asset.id));
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "ftyp");
  const suffix = await media.GET(request(`/api/media/${asset.id}`, "GET", undefined, cookie, { range: "bytes=-4" }), context(asset.id));
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), testVideo.subarray(-4));
  for (const value of ["bytes=999-", "bytes=2-1", "bytes=-0", "bytes=0-1,3-4", "bytes=-"]) {
    assert.equal((await media.GET(request(`/api/media/${asset.id}`, "GET", undefined, cookie, { range: value }), context(asset.id))).status, 416);
  }
});

test("upload rejects unsupported, mismatched, excessive and oversized attachments before writing", async () => {
  for (const files of [
    [new File(["<svg/>"], "x.svg", { type: "image/svg+xml" })],
    [new File(["not a png"], "x.png", { type: "image/png" })],
    Array.from({ length: 5 }, () => new File([testPng], "x.png", { type: "image/png" })),
    [new File([new Uint8Array(MEDIA_LIMITS.attachmentBytes + 1)], "big.png", { type: "image/png" })],
    Array.from({ length: 3 }, () => new File([new Uint8Array(7 * 1024 * 1024)], "total.png", { type: "image/png" })),
  ]) {
    const response = await upload.POST(await multipart(files));
    assert.ok([400, 413].includes(response.status));
  }
  assert.equal(await db.mediaAsset.count({ where: { userId: user.id } }), 0);
});

test("body limits are enforced even without Content-Length", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(6)); },
    cancel() { cancelled = true; },
  });
  const req = new Request("http://localhost", { method: "POST", body: stream, duplex: "half" });
  assert.equal(req.headers.get("content-length"), null);
  await assert.rejects(readLimitedBody(req, 10), (error) => error.code === "PAYLOAD_TOO_LARGE");
  assert.equal(cancelled, true);
  const tooLarge = request("/api/image", "POST", { prompt: "x".repeat(MEDIA_LIMITS.jsonBodyBytes) });
  assert.equal((await imageRoute.POST(tooLarge)).status, 413);
});

test("image and video generation persist assets and pass reference image bytes to providers", async () => {
  const input = await createImage();
  const url = `/api/media/${input.id}`;
  process.env.OPENROUTER_API_KEY = "test-provider-placeholder";
  for (const [route, path, body, kind] of [
    [imageRoute, "/api/image", { prompt: "Image", inputImages: [{ url, mediaType: "image/png" }] }, "generated-image"],
    [videoRoute, "/api/video", { prompt: "Video", inputImage: { url, mediaType: "image/png" } }, "generated-video"],
  ]) {
    const response = await route.POST(request(path, "POST", body));
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const result = await response.json();
    assert.equal(result.dataUrl, undefined);
    assert.equal(result.videoUrl, undefined);
    const stored = await storage.getMediaAsset(user.id, result.asset.assetId);
    assert.equal(stored.kind, kind);
    assert.equal(stored.description, body.prompt);
    assert.ok(existsSync(join(process.env.MEDIA_DIRECTORY, stored.relativePath)));
  }
  assert.ok(providerState.imageCalls.at(-1).files[0].data instanceof Uint8Array);
  assert.ok(providerState.videoCalls.at(-1).image.data instanceof Uint8Array);
});

test("generation rejects remote, data, traversal and other-user image references", async () => {
  const other = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  const asset = await storage.createMediaAsset({ userId: other.id, bytes: testPng, mediaType: "image/png", kind: "attachment" });
  const count = providerState.imageCalls.length;
  for (const url of ["https://example.invalid/image.png", "http://127.0.0.1/private", "file:///secret", "data:image/png;base64,AAAA", "/api/media/../secret", `/api/media/${asset.id}`]) {
    const response = await imageRoute.POST(request("/api/image", "POST", { prompt: "test", inputImages: [{ url }] }));
    assert.ok([400, 404].includes(response.status));
  }
  assert.equal(providerState.imageCalls.length, count);
});

test("chat persists attachment references while giving the model authenticated bytes", async () => {
  const asset = await createImage();
  const chat = await newChat();
  process.env.OPENROUTER_API_KEY = "test-provider-placeholder";
  const response = await chatRoute.POST(request("/api/chat", "POST", { chatId: chat.id, manualToolsOnly: true, messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Describe this image" }, { type: "file", url: `/api/media/${asset.id}`, mediaType: "image/png" }] }] }));
  assert.equal(response.status, 200);
  await response.text();
  const stored = await db.message.findFirst({ where: { chatId: chat.id, role: "user" } });
  assert.equal(stored.content.includes("base64"), false);
  assert.equal(decodePersistedUserMessage(stored.content).files[0].assetId, asset.id);
  assert.equal(await db.messageMedia.count({ where: { assetId: asset.id } }), 1);
  const modelImage = languageModel.doStreamCalls.at(-1).prompt.flatMap((entry) => Array.isArray(entry.content) ? entry.content : []).find((part) => part.type === "file" && part.mediaType === "image/png");
  assert.deepEqual(typeof modelImage.data === "string" ? Buffer.from(modelImage.data, "base64") : Buffer.from(modelImage.data), testPng);
});

test("shared media survives deletion of one conversation and has a fresh cleanup grace period", async () => {
  const asset = await createImage();
  const first = await newChat(), second = await newChat();
  for (const chat of [first, second]) await saveChatMessage({ chatId: chat.id, role: "assistant", content: imageContent(asset) });
  await assert.rejects(storage.deleteMediaAsset(user.id, asset.id), (error) => error.code === "CONFLICT");
  await deleteChat(user.id, first.id);
  assert.deepEqual(await storage.readMediaAsset(await storage.getMediaAsset(user.id, asset.id)), testPng);
  assert.equal(await db.messageMedia.count({ where: { assetId: asset.id } }), 1);
  await db.mediaAsset.update({ where: { id: asset.id }, data: { lastUsedAt: new Date(0) } });
  await deleteChat(user.id, second.id);
  assert.equal((await storage.cleanupMedia(user.id)).removedCount, 0);
  assert.equal((await storage.getMediaStats(user.id)).unreferencedCount, 1);
  await storage.deleteMediaAsset(user.id, asset.id);
  assert.equal(existsSync(join(process.env.MEDIA_DIRECTORY, asset.relativePath)), false);
});

test("message edits replace asset references transactionally", async () => {
  const asset = await createImage(), chat = await newChat();
  const message = await saveChatMessage({ chatId: chat.id, role: "assistant", content: imageContent(asset) });
  const response = await messageRoute.PATCH(request("/api/message", "PATCH", { content: "Image removed" }), context(chat.id, message.id));
  assert.equal(response.status, 200);
  assert.equal(await db.messageMedia.count({ where: { assetId: asset.id } }), 0);
  await storage.deleteMediaAsset(user.id, asset.id);
  await assert.rejects(prepareMessageMedia(user.id, imageContent(asset)), (error) => error.code === "NOT_FOUND");
});

test("legacy base64 messages migrate on read without losing data or duplicating assets", async () => {
  const chat = await newChat();
  const dataUrl = `data:image/png;base64,${testPng.toString("base64")}`;
  const image = await db.message.create({ data: { chatId: chat.id, role: "assistant", content: encodeMediaMessage({ type: "image-result", dataUrl, modelId: "old", text: "Old image" }) } });
  await db.message.create({ data: { chatId: chat.id, role: "user", content: encodePersistedUserMessage({ type: "user-message", text: "Old attachment", files: [{ url: dataUrl, mediaType: "image/png" }] }) } });
  const rows = await listChatMessages(user.id, chat.id);
  assert.ok(rows.every((row) => !row.content.includes("base64")));
  const normalized = decodeMediaMessage(rows.find((row) => row.id === image.id).content);
  assert.deepEqual(await storage.readMediaAsset(await storage.getMediaAsset(user.id, normalized.assetId)), testPng);
  await listChatMessages(user.id, chat.id);
  assert.equal(await db.mediaAsset.count({ where: { userId: user.id } }), 2);
  assert.equal(await db.messageMedia.count({ where: { message: { chatId: chat.id } } }), 2);
});

test("missing legacy media stays intact and legacy video paths cannot traverse directories", async () => {
  const chat = await newChat();
  const contents = [encodeMediaMessage({ type: "image-result", dataUrl: "data:image/png;base64,BAD", modelId: "old", text: "Original" }), encodeMediaMessage({ type: "video-result", videoUrl: "/generated-videos/../secret.mp4", modelId: "old", text: "Original video" })];
  for (const content of contents) await db.message.create({ data: { chatId: chat.id, role: "assistant", content } });
  assert.deepEqual((await listChatMessages(user.id, chat.id)).map((row) => row.content), contents);
  assert.equal(await db.mediaAsset.count({ where: { userId: user.id } }), 0);
});

test("existing legacy videos import into protected storage and raw public URLs are blocked", async () => {
  mkdirSync(process.env.LEGACY_VIDEO_DIRECTORY, { recursive: true });
  const filename = `123-${randomUUID()}.mp4`;
  writeFileSync(join(process.env.LEGACY_VIDEO_DIRECTORY, filename), testVideo);
  const chat = await newChat();
  await db.message.create({ data: { chatId: chat.id, role: "assistant", content: encodeMediaMessage({ type: "video-result", videoUrl: `/generated-videos/${filename}`, modelId: "old", text: "Old video" }) } });
  const [message] = await listChatMessages(user.id, chat.id);
  const asset = await storage.getMediaAsset(user.id, decodeMediaMessage(message.content).assetId);
  assert.deepEqual(await storage.readMediaAsset(asset), testVideo);
  assert.equal(proxy(request(`/generated-videos/${filename}`)).status, 404);
  assert.ok(existsSync(join(process.env.LEGACY_VIDEO_DIRECTORY, filename)));
});

test("cleanup removes only aged unreferenced media and managed orphan files for the current user", async () => {
  const stale = await createImage(), referenced = await createImage(), recent = await createImage();
  const chat = await newChat();
  await saveChatMessage({ chatId: chat.id, role: "assistant", content: imageContent(referenced) });
  await db.mediaAsset.updateMany({ where: { id: { in: [stale.id, referenced.id] } }, data: { lastUsedAt: new Date(0) } });
  const directory = dirname(join(process.env.MEDIA_DIRECTORY, stale.relativePath));
  const loose = join(directory, `.tmp-${randomUUID()}`);
  const unrelated = join(directory, "notes.txt");
  writeFileSync(loose, "interrupted write"); writeFileSync(unrelated, "preserve");
  utimesSync(loose, new Date(0), new Date(0));
  const result = await storage.cleanupMedia(user.id);
  assert.equal(result.removedCount, 2);
  assert.equal(result.failedCount, 0);
  assert.equal(existsSync(loose), false);
  assert.ok(existsSync(unrelated));
  for (const asset of [referenced, recent]) assert.ok(existsSync(join(process.env.MEDIA_DIRECTORY, asset.relativePath)));
});

test("media paths reject database traversal and filesystem junctions", async () => {
  const asset = await createImage();
  await db.mediaAsset.update({ where: { id: asset.id }, data: { relativePath: "../outside.png" } });
  assert.equal((await media.GET(request(`/api/media/${asset.id}`), context(asset.id))).status, 404);
  const original = process.env.MEDIA_DIRECTORY;
  const junction = join(dirname(original), `linked-${randomUUID()}`);
  symlinkSync(original, junction, process.platform === "win32" ? "junction" : "dir");
  try {
    process.env.MEDIA_DIRECTORY = junction;
    await assert.rejects(createImage(), (error) => error.code === "NOT_FOUND");
  } finally { process.env.MEDIA_DIRECTORY = original; unlinkSync(junction); }
});

test("storage statistics and cleanup are authenticated and isolated to the current user", async () => {
  const own = await createImage();
  const otherUser = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  const other = await storage.createMediaAsset({ userId: otherUser.id, bytes: testPng, mediaType: "image/png", kind: "attachment" });
  await db.mediaAsset.updateMany({ where: { id: { in: [own.id, other.id] } }, data: { lastUsedAt: new Date(0) } });
  assert.equal((await mediaStats.GET(request("/api/media", "GET", undefined, ""))).status, 401);
  assert.equal((await mediaCleanup.POST(request("/api/media/cleanup", "POST", undefined, ""))).status, 401);
  const stats = await mediaStats.GET(request("/api/media"));
  assert.equal(stats.status, 200);
  const data = (await stats.json()).data;
  assert.equal(data.assetCount, 1);
  assert.equal(data.totalBytes, testPng.length);
  assert.equal(data.reclaimableCount, 1);
  const cleaned = await mediaCleanup.POST(request("/api/media/cleanup", "POST"));
  assert.deepEqual((await cleaned.json()).data, { removedCount: 1, freedBytes: testPng.length, failedCount: 0 });
  assert.deepEqual(await storage.readMediaAsset(await storage.getMediaAsset(otherUser.id, other.id)), testPng);
});
