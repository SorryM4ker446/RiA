import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { setupServerProxy } from "@/lib/server/proxy";
test("the explicit desktop proxy overrides inherited proxies and leaves loopback requests local", async () => {
  const seen: string[] = [];
  const proxy = createServer((request, response) => { seen.push(request.url!); response.end("proxied"); });
  const local = createServer((_request, response) => response.end("local"));
  await Promise.all([new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve)), new Promise<void>(resolve => local.listen(0, "127.0.0.1", resolve))]);
  const port = (server: typeof proxy) => (server.address() as { port: number }).port;
  const names = ["OUTBOUND_PROXY_URL", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const original = getGlobalDispatcher();
  try {
    process.env.OUTBOUND_PROXY_URL = `http://127.0.0.1:${port(proxy)}`;
    process.env.HTTP_PROXY = process.env.HTTPS_PROXY = process.env.http_proxy = process.env.https_proxy = "http://127.0.0.1:1";
    process.env.NO_PROXY = process.env.no_proxy = "";
    setupServerProxy();
    assert.equal(await (await fetch("http://provider.invalid/test", { signal: AbortSignal.timeout(5000) })).text(), "proxied");
    assert.equal(await (await fetch(`http://127.0.0.1:${port(local)}/test`, { signal: AbortSignal.timeout(5000) })).text(), "local");
    assert.deepEqual(seen, ["http://provider.invalid/test"]);
  } finally {
    const configured = getGlobalDispatcher(); setGlobalDispatcher(original); await configured.close();
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => local.close(() => resolve()))]);
  }
});
