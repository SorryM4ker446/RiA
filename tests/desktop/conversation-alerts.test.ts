import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { ConversationAlerts, createConversationNotificationDelivery, readTurnFinished, turnNotice, conversationPath } = require("../../electron-dist/conversation-alerts.js");
const connection = () => ({ origin: "http://127.0.0.1:12345", cookie: "desktop_session=test-placeholder" });
const event = (name: string, data: object) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

/** A stream of server-sent events the test writes into. */
function eventStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(given) { controller = given; } });
  return { body, write: (text: string) => controller.enqueue(encoder.encode(text)), end: () => controller.close() };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test("an answer the user started that ends while the window is not in front becomes a notification; a task's or a stopped one does not", async t => {
  const stream = eventStream();
  const requests: { url: string; options: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => { requests.push({ url, options }); return new Response(stream.body, { headers: { "content-type": "text/event-stream" } }); });
  let inFront = false;
  const delivered: unknown[] = [];
  const alerts = new ConversationAlerts({ connection, supported: () => true, inFront: () => inFront, deliver: (turn: unknown) => delivered.push(turn), logger: { warn() {} } });
  try {
    alerts.start();
    await settle();
    assert.equal(requests[0].url, "http://127.0.0.1:12345/api/conversations/events");
    assert.equal((requests[0].options.headers as Record<string, string>).Cookie, connection().cookie);
    stream.write(event("ready", { answering: [] }));
    stream.write(event("turn", { type: "turn-started", chatId: "a", source: "chat" }));
    // Split across reads, as a network may deliver it.
    const finished = event("turn", { type: "turn-finished", chatId: "a", source: "chat", outcome: "succeeded", title: "旅行计划" });
    stream.write(finished.slice(0, 20));
    stream.write(finished.slice(20));
    stream.write(event("turn", { type: "turn-finished", chatId: "t", source: "task", outcome: "succeeded", title: "Daily" }));
    stream.write(event("turn", { type: "turn-finished", chatId: "s", source: "chat", outcome: "stopped", title: "Stopped" }));
    stream.write(event("changed", {}));
    await settle();
    // With the window in front, the sidebar says it; nothing pops up.
    inFront = true;
    stream.write(event("turn", { type: "turn-finished", chatId: "b", source: "chat", outcome: "waiting_approval", title: "Deploy" }));
    await settle();
    assert.deepEqual(delivered, [
      { chatId: "a", outcome: "succeeded", title: "旅行计划" },
      { chatId: "s", outcome: "stopped", title: "Stopped" },
    ], "stopped turns reach delivery, which says nothing about them");
  } finally { await alerts.stop(); }
});

test("a notification names the conversation and how its answer ended, and opens it when clicked", () => {
  assert.deepEqual(turnNotice({ chatId: "a", outcome: "succeeded", title: "旅行计划" }, "zh-CN"), { title: "旅行计划", body: "回答好了" });
  assert.deepEqual(turnNotice({ chatId: "a", outcome: "waiting_approval", title: null }, "en-US"), { title: "Conversation", body: "Waiting for your approval" });
  assert.equal(turnNotice({ chatId: "a", outcome: "stopped", title: "x" }, "zh-CN"), null);
  assert.equal(readTurnFinished("not json"), null);
  assert.equal(readTurnFinished(JSON.stringify({ type: "turn-finished", chatId: "a", source: "chat", outcome: "exploded" })), null);

  const shown: { options: { title: string; body: string }; emitter: EventEmitter }[] = [];
  class FakeNotification extends EventEmitter {
    constructor(public options: { title: string; body: string }) { super(); shown.push({ options, emitter: this }); }
    show() {}
    close() {}
  }
  const opened: string[] = [];
  const deliver = createConversationNotificationDelivery(FakeNotification, (path: string) => opened.push(path), { warn() {} }, () => "zh-CN");
  deliver({ chatId: "chat 1", outcome: "failed", title: "部署" });
  deliver({ chatId: "quiet", outcome: "stopped", title: "x" });
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0].options, { title: "部署", body: "没能完成回答", silent: false });
  shown[0].emitter.emit("click");
  assert.deepEqual(opened, [conversationPath("chat 1")]);
  assert.equal(opened[0], "/chat?conversationId=chat%201");
});

test("a dropped connection is followed again, and stopping ends it for good", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("refused"); });
  const warnings: string[] = [];
  const alerts = new ConversationAlerts({ connection, supported: () => true, inFront: () => false, deliver() {}, logger: { warn: (message: string) => warnings.push(message) } });
  alerts.start();
  await new Promise(resolve => setTimeout(resolve, 1_200));
  assert.ok(calls >= 2, "tried again after the first failure");
  assert.equal(warnings.length, 1, "one warning while it keeps failing, not one per try");
  await alerts.stop();
  const after = calls;
  await new Promise(resolve => setTimeout(resolve, 1_100));
  assert.equal(calls, after);
});
