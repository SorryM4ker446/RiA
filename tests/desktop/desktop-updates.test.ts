import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as paths from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const { outputText } = ts.transpileModule(readFileSync(new URL("../../electron/desktop-updates.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});

function fixture({ enabled = true, packaged = true, smoke = false, launch = async () => {} } = {}) {
  const state = { phase: "available", availableVersion: "1.2.4", checkedAt: null as string | null };
  const calls: string[] = [];
  const timeouts: (() => void)[] = [];
  const intervals: (() => void)[] = [];
  const resumes: (() => void)[] = [];
  const exports = {} as typeof import("../../electron/desktop-updates");
  const modules = {
    "node:path": paths,
    "electron": {
      app: { isPackaged: packaged },
      Notification: { isSupported: () => false },
      powerMonitor: { on: (_event: string, fn: () => void) => resumes.push(fn) },
    },
    "./runtime-state": { smokeTest: smoke, runtime: {
      settingsStore: { getAutoCheckUpdates: () => enabled },
      updateService: {
        async check() {
          calls.push("check");
          state.checkedAt = new Date().toISOString();
          return state;
        },
        getState: () => state,
        apply: () => { calls.push("apply"); },
      },
    } },
    "./updater": { installationRoot: paths.dirname, launchInstaller: launch },
    "./desktop-presence": { quitFromTray: () => calls.push("quit") },
  };
  runInNewContext(outputText, {
    exports,
    process: { platform: "win32", execPath: process.execPath, pid: process.pid, env: {} },
    require: (name: keyof typeof modules) => modules[name],
    setTimeout: (fn: () => void) => timeouts.push(fn),
    setInterval: (fn: () => void) => { intervals.push(fn); return { unref() {} }; },
  });
  return { ...exports, calls, timeouts, intervals, resumes };
}

test("startup immediately checks once without starting the offered update", async () => {
  const desktop = fixture();
  desktop.scheduleUpdateChecks();
  await Promise.resolve();
  assert.deepEqual(desktop.calls, ["check"]);
  assert.equal(desktop.timeouts.length, 0);
  assert.equal(desktop.intervals.length, 1);
  desktop.resumes[0]();
  assert.deepEqual(desktop.calls, ["check"]);
  for (const options of [{ enabled: false }, { packaged: false }, { smoke: true }]) {
    const stopped = fixture(options);
    stopped.scheduleUpdateChecks();
    assert.deepEqual(stopped.calls, []);
  }
});

test("RiA only schedules its quit after the installer handoff succeeds", async () => {
  const plan = { installer: "setup.exe", installLog: "install.log", resultFile: "result.json" };
  let ready!: () => void;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  const desktop = fixture({ launch: () => waiting });
  const launch = desktop.launchUpdateInstaller(plan);
  assert.equal(desktop.timeouts.length, 0);
  ready();
  await launch;
  assert.equal(desktop.timeouts.length, 1);
  desktop.timeouts[0]();
  assert.deepEqual(desktop.calls, ["quit"]);

  const failed = fixture({ launch: async () => { throw new Error("launcher not ready"); } });
  await assert.rejects(failed.launchUpdateInstaller(plan), /launcher not ready/);
  assert.equal(failed.timeouts.length, 0);
});
