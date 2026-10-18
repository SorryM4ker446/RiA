import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { BrowserWindow } from "electron";
import { createStartupPresentation } from "../../electron/startup-presentation";

function fixture(options = { enabled: true, show: true }) {
  const events = new EventEmitter(), contents = new EventEmitter();
  let destroyed = false, shows = 0;
  const window = Object.assign(events, { isDestroyed: () => destroyed, show: () => { shows++; } });
  Object.defineProperty(window, "webContents", { get: () => { if (destroyed) throw new Error("Object has been destroyed"); return contents; } });
  const errors: unknown[] = [];
  const startup = createStartupPresentation(window as unknown as BrowserWindow, { ...options, onError: error => errors.push(error) });
  return {
    startup, errors, shows: () => shows, ready: () => events.emit("ready-to-show"),
    navigate: (isMainFrame = true, isSameDocument = false) => contents.emit("did-start-navigation", { isMainFrame, isSameDocument }),
    close: () => { destroyed = true; events.emit("closed"); },
    listeners: () => events.listenerCount("ready-to-show") + contents.listenerCount("did-start-navigation"),
  };
}

test("the first window waits for the themed startup frame and shows exactly once", async () => {
  const app = fixture();
  app.navigate(); app.ready();
  assert.equal(app.shows(), 0);
  const token = app.startup.claim(); assert.ok(token);
  assert.equal(app.startup.claim(), null);
  assert.equal(await app.startup.present("wrong-token"), false);
  assert.equal(app.shows(), 0);
  assert.equal(await app.startup.present(token), true);
  assert.equal(app.shows(), 1);
  assert.equal(await app.startup.present(token), true);
  assert.equal(app.shows(), 1);
  app.navigate(); assert.equal(app.startup.claim(), null);
  app.close(); assert.equal(app.listeners(), 0);
});

test("renderer readiness before native painting cannot reveal an unpainted window", async () => {
  const app = fixture();
  const pending = app.startup.present(app.startup.claim());
  assert.equal(app.shows(), 0);
  app.ready(); assert.equal(await pending, true);
  assert.equal(app.shows(), 1); app.close();
});

test("an absent or stalled startup renderer cannot keep the application hidden", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = fixture();
  const token = app.startup.claim();
  app.ready();
  t.mock.timers.tick(1999); assert.equal(app.shows(), 0);
  t.mock.timers.tick(1); assert.equal(app.shows(), 1);
  assert.equal(await app.startup.present(token), false);
  assert.equal(app.startup.claim(), null); app.close();
});

test("replacing the first document abandons its presentation while same-document navigation does not", async () => {
  const app = fixture();
  app.navigate();
  const token = app.startup.claim();
  const pending = app.startup.present(token);
  app.navigate(false); app.navigate(true, true);
  assert.equal(app.shows(), 0);
  app.navigate(); app.ready();
  assert.equal(await pending, false);
  assert.equal(app.shows(), 1); assert.equal(app.startup.claim(), null); app.close();
});

test("closing during startup clears pending readiness and removes listeners", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = fixture();
  const pending = app.startup.present(app.startup.claim());
  app.close(); assert.equal(await pending, false);
  app.ready(); t.mock.timers.tick(5000);
  assert.equal(app.shows(), 0); assert.equal(app.listeners(), 0);
});

test("non-startup windows retain ready-to-show and hidden smoke windows stay hidden", () => {
  for (const show of [true, false]) {
    const app = fixture({ enabled: false, show });
    assert.equal(app.startup.claim(), null);
    app.ready(); assert.equal(app.shows(), Number(show)); app.close();
  }
});
