import assert from "node:assert/strict";
import { test } from "node:test";
import { beginDesktopShutdown } from "../../electron/desktop-shutdown";

test("quit removes the windows and tray before service teardown and ignores repeated requests", async () => {
  const calls: string[] = [];
  const abort = new AbortController();
  abort.signal.addEventListener("abort", () => calls.push("abort restart"));
  let finishRestart!: () => void;
  const restart = new Promise<void>((resolve) => { finishRestart = resolve; });
  const state: Parameters<typeof beginDesktopShutdown>[0] = {
    isQuitting: false,
    tray: { destroy: () => { calls.push("remove tray"); } },
    reminderPoller: { stop: async () => { calls.push("stop reminders"); } },
    conversationAlerts: { stop: async () => { calls.push("stop alerts"); } },
    restartAbort: abort,
    restartInProgress: restart,
    nextServer: null,
  };
  const hide = () => {
    assert.equal(state.isQuitting, true);
    calls.push("hide windows");
  };
  const releaseKeys = () => { calls.push("release shortcuts"); };
  const shutdown = beginDesktopShutdown(state, hide, releaseKeys);
  assert.ok(shutdown);
  assert.equal(beginDesktopShutdown(state, hide, releaseKeys), undefined);
  assert.equal(state.tray, null);
  assert.deepEqual(calls, ["hide windows", "remove tray", "release shortcuts", "abort restart", "stop reminders", "stop alerts"]);
  state.nextServer = { stop: async () => { calls.push("stop service"); } };
  finishRestart();
  await shutdown;
  assert.equal(calls.at(-1), "stop service");
});

test("a failed notification cleanup still stops the local service", async () => {
  let stopped = false;
  const shutdown = beginDesktopShutdown({
    isQuitting: false, tray: null, reminderPoller: null,
    conversationAlerts: { stop: async () => { throw new Error("failed to stop notifications"); } },
    restartAbort: null, restartInProgress: null,
    nextServer: { stop: async () => { stopped = true; } },
  }, () => {}, () => {});
  assert.ok(shutdown);
  await assert.rejects(shutdown, /failed to stop notifications/);
  assert.equal(stopped, true);
});
