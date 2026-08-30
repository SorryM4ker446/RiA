import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { TaskReminderPoller, createTaskNotificationDelivery } = require("../../electron-dist/task-reminders.js");
const task = { id: "task", title: "Local task", dueDate: "2026-08-30T00:00:00Z", timeZone: "Asia/Shanghai" };
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
    assert.equal(requests[0].url, "http://127.0.0.1:12345/api/tasks/reminders");
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

test("unsupported notifications do not claim tasks and transient failures are retried on later checks", async t => {
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

test("desktop reminder responses are bounded and notification failures do not expose task content", async t => {
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
    data = [{ ...task, timeZone: "Invalid/Zone" }];
    await poller.poll();
    data = [{ ...task, id: "throw" }, task];
    await poller.poll();
    assert.deepEqual(delivered, [task]);
    assert.equal(warnings.length, 3);
    assert.equal(warnings.join().includes("sensitive"), false);
  } finally { await poller.stop(); }
});

test("native notifications show zoned deadlines, focus on click and keep a bounded object history", () => {
  const notifications = [], warnings = [];
  let focused = 0;
  class FakeNotification extends EventEmitter {
    constructor(options) { super(); this.options = options; notifications.push(this); }
    show() { this.shown = true; }
    close() { this.closed = true; this.emit("close"); }
  }
  const deliver = createTaskNotificationDelivery(FakeNotification, () => focused++, { warn: message => warnings.push(message) });
  for (let i = 0; i < 31; i++) deliver(task);
  assert.equal(notifications[0].closed, true);
  assert.equal(notifications.at(-1).shown, true);
  assert.equal(notifications.at(-1).options.title, "Local task");
  assert.match(notifications.at(-1).options.body, /8:00:00.*Asia\/Shanghai/);
  notifications.at(-1).emit("click");
  assert.equal(focused, 1);
  notifications.at(-1).emit("failed", {}, "sensitive OS error");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes("sensitive"), false);
});
