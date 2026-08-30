import assert from "node:assert/strict";
import { test } from "node:test";
import { chatApi, createChatTransport, filesToUploadParts, persistConversationMessage } from "@/features/chat/api-client";

test("chat API client preserves actionable API errors and handles non-JSON failures", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code: "RATE_LIMITED", message: "Too many requests", details: { retryAfterSeconds: 12 } } }, { status: 429 }));
  await assert.rejects(chatApi.listConversations(), /12 秒后可重试/);
  t.mock.method(globalThis, "fetch", async () => new Response("Bad gateway", { status: 502 }));
  await assert.rejects(chatApi.listMessages("chat"), /读取历史消息失败/);
});

test("chat transport bounds loaded history while retaining the active turn and regeneration metadata", async (t) => {
  let sent;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  });
  const messages = Array.from({ length: 125 }, (_, i) => ({ id: `message-${i}`, role: i % 2 ? "assistant" : "user", parts: [{ type: "text", text: `text-${i}` }] }));
  const transport = createChatTransport("chat", { selectedChatModel: "model", manualToolsOnly: true, modelMode: "chat" });
  await transport.sendMessages({ chatId: "sdk-chat", messages, trigger: "regenerate-message", messageId: "message-124" });
  assert.equal(sent.messages.length, 100);
  assert.equal(sent.messages.at(-1).id, "message-124");
  assert.equal(sent.messageId, "message-124");
  assert.equal(sent.trigger, "regenerate-message");
  assert.equal(sent.chatId, "chat");
  assert.equal(sent.manualToolsOnly, true);
  assert.equal(messages.length, 125);
});

test("conversation detail lookup distinguishes missing records from transient failures", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code: "NOT_FOUND", message: "Missing" } }, { status: 404 }));
  assert.deepEqual(await chatApi.getConversation("missing"), { data: null });
  t.mock.method(globalThis, "fetch", async () => new Response("Failed", { status: 500 }));
  await assert.rejects(chatApi.getConversation("existing"), /读取会话失败/);
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
