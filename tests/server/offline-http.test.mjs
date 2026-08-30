import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

const fixture = new URL("../helpers/offline-http.mjs", import.meta.url).href;
for (const enabled of [false, true]) {
  test(`isolated HTTP fixtures ${enabled ? "simulate the provider" : "disable the provider"} and deny unmatched fetch requests`, { timeout: 10_000 }, async (t) => {
    const source = `
      import assert from 'node:assert/strict';
      for (const url of ['https://outside.invalid/', 'http://127.0.0.1:65500/', 'https://openrouter.ai/api/v1/unknown']) {
        await assert.rejects(fetch(url), error => error.cause?.code === 'UND_MOCK_ERR_MOCK_NOT_MATCHED');
      }
      const call = (content = 'Synthetic prompt') => fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'offline', stream: true, messages: [{ role: 'user', content }] })
      });
      if (process.env.PRIVATE_AI_HTTP_FIXTURE === '1') {
        const response = await call();
        assert.equal(response.headers.get('content-type'), 'text/event-stream');
        assert.match(await response.text(), /Synthetic prompt/);
        assert.match(await (await call('Follow-up prompt')).text(), /Follow-up prompt/);
      } else {
        await assert.rejects(call(), error => error.cause?.code === 'UND_MOCK_ERR_MOCK_NOT_MATCHED');
      }
    `;
    const child = spawn(process.execPath, ["--import", fixture, "--input-type=module", "--eval", source], {
      env: { ...process.env, NODE_OPTIONS: "", APP_RUNTIME: "test", PRIVATE_AI_HTTP_FIXTURE: enabled ? "1" : "0" },
      windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    t.after(async () => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
      await new Promise((resolve) => { child.once("exit", resolve); child.kill(); });
    });
    let diagnostics = "";
    child.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-4000); });
    const calls = [];
    child.on("message", (call) => calls.push(call));
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, 0, diagnostics);
    assert.equal(calls.length, enabled ? 2 : 0);
    if (enabled) assert.deepEqual(Object.keys(calls[0]).sort(), ["messages", "stream", "type"]);
  });
}
