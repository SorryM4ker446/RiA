import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { BrowserWindow } from "electron";
import { createWindowTransitions } from "../../electron/window-transitions";

function fixture() {
  const events = new EventEmitter();
  const calls: string[] = [], scripts: string[] = [], releases: (() => void)[] = [];
  let destroyed = false, minimized = false, maximized = false;
  const target = Object.assign(events, {
    isDestroyed: () => destroyed, isVisible: () => !minimized, isMinimized: () => minimized, isMaximized: () => maximized,
    minimize: () => { calls.push("minimize"); minimized = true; },
    maximize: () => { calls.push("maximize"); maximized = true; },
    unmaximize: () => { calls.push("unmaximize"); maximized = false; },
    close: () => { calls.push("close"); },
    webContents: { isDestroyed: () => destroyed, executeJavaScript: (script: string) => {
      scripts.push(script);
      return script.includes("const effect =") ? new Promise<void>(resolve => releases.push(resolve)) : Promise.resolve();
    } },
  });
  const errors: unknown[] = [];
  const transitions = createWindowTransitions(target as unknown as BrowserWindow, error => errors.push(error));
  return { target, calls, scripts, releases, errors, transitions, destroy: () => { destroyed = true; events.emit("closed"); }, restore: () => { minimized = false; events.emit("restore"); } };
}

test("minimize waits for its visual transition and restoration clears the effect", async () => {
  const app = fixture();
  app.transitions.request("minimize");
  assert.deepEqual(app.calls, []);
  assert.match(app.scripts[0], /prefers-reduced-motion: reduce/);
  app.releases.shift()!(); await setImmediate();
  assert.deepEqual(app.calls, ["minimize"]);
  app.restore();
  assert.match(app.scripts.at(-1)!, /const effect = "restore"/);
  app.releases.shift()!(); await setImmediate();
  assert.match(app.scripts.at(-1)!, /cancel\(\)/);
  app.destroy();
});

test("maximize and restore use native geometry once and coalesce repeated clicks while honoring close", async () => {
  const app = fixture();
  app.transitions.request("toggle-maximize");
  app.transitions.request("toggle-maximize");
  app.transitions.request("minimize");
  app.transitions.request("close");
  app.transitions.request("minimize");
  app.releases.shift()!(); await setImmediate();
  assert.deepEqual(app.calls, ["maximize"]);
  app.releases.shift()!(); await setImmediate();
  assert.match(app.scripts.at(-1)!, /const effect = "close"/);
  let closeAllowed = false;
  app.target.close = () => { closeAllowed = app.transitions.isClosing(); app.calls.push("close"); };
  app.releases.shift()!(); await setImmediate();
  assert.deepEqual(app.calls, ["maximize", "close"]);
  assert.equal(closeAllowed, true);
  assert.equal(app.transitions.isClosing(), false);
  app.transitions.request("toggle-maximize");
  app.releases.shift()!(); await setImmediate();
  assert.equal(app.calls.at(-1), "unmaximize");
  app.releases.shift()!(); await setImmediate();
  assert.deepEqual(app.errors, []);
  app.destroy();
});

test("a stalled renderer cannot block a native close and disposal cancels queued actions", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = fixture();
  app.transitions.request("close");
  t.mock.timers.tick(300); await setImmediate();
  assert.deepEqual(app.calls, ["close"]);
  assert.match(app.scripts.at(-1)!, /cancel\(\)/);
  app.transitions.request("toggle-maximize");
  app.transitions.request("close");
  app.destroy(); await setImmediate();
  t.mock.timers.tick(1000); await setImmediate();
  assert.deepEqual(app.calls, ["close"]);
  assert.equal(app.target.listenerCount("restore"), 0);
  assert.equal(app.target.listenerCount("show"), 0);
});

test("native close policy remains authoritative and rejected visual effects do not prevent actions", async () => {
  const app = fixture();
  app.target.webContents.executeJavaScript = async () => { throw new Error("renderer unavailable"); };
  app.transitions.request("close"); await setImmediate();
  assert.deepEqual(app.calls, ["close"]);
  // A native close handler may hide the window to the tray rather than destroy
  // it. A subsequent native action still works, without a retained close guard.
  app.transitions.request("minimize"); await setImmediate();
  assert.deepEqual(app.calls, ["close", "minimize"]);
  assert.equal(app.transitions.isClosing(), false);
  app.destroy();
});

test("native maximize events animate without changing bounds and obsolete entrances cannot cancel newer effects", async () => {
  const app = fixture();
  app.target.emit("maximize");
  app.target.emit("unmaximize");
  assert.equal(app.releases.length, 2);
  assert.match(app.scripts.at(-1)!, /const effect = "reframe-in"/);
  app.releases.shift()!(); await setImmediate();
  assert.match(app.scripts.at(-1)!, /const effect = "reframe-in"/);
  app.releases.shift()!(); await setImmediate();
  assert.match(app.scripts.at(-1)!, /cancel\(\)/);
  assert.deepEqual(app.calls, []);
  app.destroy();
  assert.equal(app.target.listenerCount("maximize"), 0);
  assert.equal(app.target.listenerCount("unmaximize"), 0);
});
