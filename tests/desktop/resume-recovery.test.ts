import assert from "node:assert/strict";
import { test } from "node:test";
import { createResumeRecovery } from "../../electron/resume-recovery";

function fixture() {
  const events: string[] = [];
  let current: object | null = {}, quitting = false, healthy = true;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const resume = createResumeRecovery({ current: () => current, quitting: () => quitting,
    healthy: async () => { events.push("health"); await gate; return healthy; },
    refreshSession: async () => { events.push("session"); },
    restart: async () => { events.push("restart"); }, poll: async () => { events.push("poll"); }, failed: () => { events.push("failed"); },
  });
  return { events, resume, release, replace: () => { current = {}; }, quit: () => { quitting = true; }, failHealth: () => { healthy = false; } };
}
test("duplicate resume events share one health check and refresh session before polling", async () => {
  const f = fixture(); const first = f.resume(); assert.equal(f.resume(), first); f.release(); await first;
  assert.deepEqual(f.events, ["health", "session", "poll"]);
});
test("an unhealthy resumed service uses the existing restart path once", async () => {
  const f = fixture(); f.failHealth(); const first = f.resume(); f.resume(); f.release(); await first;
  assert.deepEqual(f.events, ["health", "restart"]);
});
test("a delayed health result cannot restart a replaced service or a quitting app", async () => {
  for (const action of ["replace", "quit"] as const) {
    const f = fixture(); f.failHealth(); const first = f.resume(); f[action](); f.release(); await first;
    assert.deepEqual(f.events, ["health"]);
  }
});
