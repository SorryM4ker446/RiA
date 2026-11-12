import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { TaskReminderPoller, createTaskNotificationDelivery, inAppPath } = require("../../electron-dist/task-reminders.js");
const task = { id: "notice", title: "task-finished", detail: "Morning note", href: "/chat?conversationId=chat-1" };
const connection = () => ({ origin: "http://127.0.0.1:12345", cookie: "desktop_session=test-placeholder" });

test("desktop reminder polling uses authenticated loopback requests, coalesces wakeups and stops cleanly", async t => {
  const delivered = [], requests = [], warnings = [];
  let release;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    await new Promise(resolve => { release = resolve; });
    return Response.json({ data: [task] });
  });
  const poller = new TaskReminderPoller({ connection, supported: () => true, deliver: value => delivered.push(value), logger: { warn: message => warnings.push(message) } });
  try {
    poller.start();
    const a = poller.poll(), b = poller.poll();
    assert.equal(a, b);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://127.0.0.1:12345/api/tasks/notifications");
    assert.equal(requests[0].options.headers.Cookie, connection().cookie);
    assert.equal(requests[0].options.redirect, "error");
    const stopping = poller.stop();
    release();
    await Promise.allSettled([a, b, stopping]);
    assert.deepEqual(delivered, [task]);
    await poller.poll();
    assert.equal(requests.length, 1);
    assert.deepEqual(warnings, []);
  } finally { release?.(); await poller.stop(); }
});

test("unsupported notifications claim nothing and transient failures are retried on later checks", async t => {
  let supported = false, fail = true, calls = 0;
  const delivered = [], warnings = [];
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return fail ? new Response("sensitive response", { status: 503 }) : Response.json({ data: [task] });
  });
  const poller = new TaskReminderPoller({ connection, supported: () => supported, deliver: value => delivered.push(value), logger: { warn: message => warnings.push(message) } });
  try {
    poller.start();
    await poller.poll();
    assert.equal(calls, 0);
    supported = true;
    await poller.poll();
    assert.equal(delivered.length, 0);
    fail = false;
    await poller.poll();
    assert.deepEqual(delivered, [task]);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].includes("sensitive"), false);
    await poller.stop();
    poller.start();
    await poller.poll();
    assert.equal(calls, 3);
  } finally { await poller.stop(); }
});

test("desktop notification responses are bounded and notification failures do not expose task content", async t => {
  let data = Array.from({ length: 11 }, () => task);
  const warnings = [], delivered = [];
  t.mock.method(globalThis, "fetch", async () => Response.json({ data }));
  const poller = new TaskReminderPoller({ connection, supported: () => true, deliver: value => {
    if (value.id === "throw") throw new Error("sensitive title");
    delivered.push(value);
  }, logger: { warn: message => warnings.push(message) } });
  try {
    poller.start();
    await poller.poll();
    assert.equal(delivered.length, 0);
    data = [{ ...task, detail: 42 as unknown as string }];
    await poller.poll();
    data = [{ ...task, id: "throw" }, task];
    await poller.poll();
    assert.deepEqual(delivered, [task]);
    assert.equal(warnings.length, 3);
    assert.equal(warnings.join().includes("sensitive"), false);
  } finally { await poller.stop(); }
});

test("native notifications say what happened to which task, focus on click and keep a bounded object history", () => {
  const notifications = [], warnings = [];
  const opened: Array<string | null> = [];
  class FakeNotification extends EventEmitter {
    options;
    shown;
    closed;
    constructor(options) { super(); this.options = options; notifications.push(this); }
    show() { this.shown = true; }
    close() { this.closed = true; this.emit("close"); }
  }
  let locale = "zh-CN";
  const deliver = createTaskNotificationDelivery(FakeNotification, (path: string | null) => opened.push(path), { warn: message => warnings.push(message) }, () => locale);
  for (let i = 0; i < 31; i++) deliver(task);
  assert.equal(notifications[0].closed, true);
  assert.equal(notifications.at(-1).shown, true);
  assert.equal(notifications.at(-1).options.title, "任务已完成");
  assert.equal(notifications.at(-1).options.body, "Morning note");
  notifications.at(-1).emit("click");
  assert.deepEqual(opened, ["/chat?conversationId=chat-1"], "a click opens the task's conversation");
  notifications.at(-1).emit("failed", {}, "sensitive OS error");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes("sensitive"), false);
  locale = "en-US";
  deliver({ ...task, title: "task-needs-approval" });
  assert.equal(notifications.at(-1).options.title, "A task needs your approval");
  deliver({ ...task, title: "from-a-later-version", detail: null });
  assert.equal(notifications.at(-1).options.title, "Task update", "an unknown notice still says a task has news");
  assert.equal(notifications.at(-1).options.body, "");
});

test("a notification only ever opens a page inside the app", () => {
  assert.equal(inAppPath("/chat?conversationId=chat-1"), "/chat?conversationId=chat-1");
  assert.equal(inAppPath("/tasks"), "/tasks");
  for (const unsafe of [null, "", "https://example.invalid/", "//example.invalid/x", "javascript:alert(1)", "chat", "/\\example.invalid"]) {
    assert.equal(inAppPath(unsafe), null, String(unsafe));
  }
});
