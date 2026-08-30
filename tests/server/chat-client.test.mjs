import assert from "node:assert/strict";
import { test } from "node:test";
import { chatApi, filesToUploadParts, persistConversationMessage } from "@/features/chat/api-client";

test("chat API client preserves actionable API errors and handles non-JSON failures", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code: "RATE_LIMITED", message: "Too many requests", details: { retryAfterSeconds: 12 } } }, { status: 429 }));
  await assert.rejects(chatApi.listConversations(), /12 秒后可重试/);
  t.mock.method(globalThis, "fetch", async () => new Response("Bad gateway", { status: 502 }));
  await assert.rejects(chatApi.listMessages("chat"), /读取历史消息失败/);
});

test("media generation and message persistence send private references without embedded bytes", async (t) => {
  const calls = [];
  const asset = { assetId: "asset-id", relativePath: "private/image.png", url: "/api/media/asset-id", mediaType: "image/png" };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return Response.json({ asset, modelId: "model", data: {} });
  });
  const files = [{ type: "file", url: asset.url, mediaType: asset.mediaType }];
  await chatApi.generateMedia("image", "prompt", "model", files);
  await chatApi.generateMedia("video", "prompt", "model", files);
  await persistConversationMessage({ chatId: "chat", role: "assistant", content: "saved", clientMessageId: "message" });
  assert.deepEqual(calls[0].body.inputImages, [{ url: asset.url, mediaType: asset.mediaType }]);
  assert.deepEqual(calls[1].body.inputImage, calls[0].body.inputImages[0]);
  assert.equal(calls[2].body.status, "success");
  assert.equal(JSON.stringify(calls).includes("base64"), false);
});

test("attachment upload rejects invalid files before HTTP and uses multipart for valid files", async (t) => {
  const calls = t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.ok(options.body instanceof FormData);
    assert.equal(options.headers, undefined);
    assert.equal(options.body.getAll("files").length, 1);
    return Response.json({ data: [{ url: "/api/media/asset-id", mediaType: "image/png", filename: "image.png" }] });
  });
  await assert.rejects(filesToUploadParts([new File(["text"], "note.txt", { type: "text/plain" })]));
  assert.equal(calls.mock.callCount(), 0);
  assert.deepEqual(await filesToUploadParts([new File(["bytes"], "image.png", { type: "image/png" })]), [{ type: "file", url: "/api/media/asset-id", mediaType: "image/png", filename: "image.png" }]);
});
