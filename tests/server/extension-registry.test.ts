import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { registryEntry } from "../helpers/registry-fixture";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { searchRegistry, getRegistryServer, REGISTRY_LIMITS } = await import("@/lib/extensions/registry");
const root = await import("@/app/api/extensions/registry/route");
const detail = await import("@/app/api/extensions/registry/detail/route");
let cookie: string;
const signal = () => new AbortController().signal;
const query = () => ({ search: randomUUID() });
const json = (value: unknown, status = 200) => Response.json(value, { status });
const req = (params = "", auth = cookie, headers = {}) => new NextRequest(`http://localhost/api/extensions/registry${params}`, { headers: { cookie: auth, ...headers } });
beforeEach(() => { cookie = localAccessCookie(); globalThis.__privateAiRateLimitStore?.clear(); });
after(async () => { await db.$disconnect(); cleanup(); });

test("official registry search forwards bounded search/cursor parameters without workspace credentials or endpoint probes", async t => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const entry = registryEntry("search", { remotes: [{ type: "streamable-http", url: "http://127.0.0.1:9123/mcp" }] });
  t.mock.method(globalThis, "fetch", async (url, init) => { calls.push({ url: String(url), init }); return json({ servers: [entry], metadata: { nextCursor: "opaque/page:2" } }); });
  const data = await searchRegistry({ search: "registry search", cursor: "opaque/page:1" }, signal());
  assert.equal(data.items[0].title, "Registry search"); assert.equal(data.items[0].remotes[0].unavailableReason, null);
  assert.equal(data.nextCursor, "opaque/page:2"); assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, "https://registry.modelcontextprotocol.io");
  assert.deepEqual(Object.fromEntries(url.searchParams), { limit: "20", version: "latest", search: "registry search", cursor: "opaque/page:1" });
  assert.deepEqual(calls[0].init?.headers, { Accept: "application/json" });
  assert.equal(calls[0].init?.credentials, "omit"); assert.equal(calls[0].init?.redirect, "error");
  assert.equal(await db.extension.count(), 0);
});

test("discovery distinguishes supported remotes from local packages, SSE, URL templates and unsupported headers", async t => {
  const entries = [
    registryEntry("headers", { websiteUrl: "javascript:alert(1)", repository: { url: "https://user:password@example.invalid/" }, remotes: [{ type: "streamable-http", url: "https://service.example.invalid/mcp", headers: [
      { name: "Authorization", value: "Bearer {token}", isRequired: true }, { name: "X-Secret", value: "publisher-secret-example", isSecret: true }, { name: "X-Mode", value: "compact" },
    ] }] }),
    registryEntry("sse", { remotes: [{ type: "sse", url: "https://service.example.invalid/sse" }] }),
    registryEntry("template", { remotes: [{ type: "streamable-http", url: "https://{tenant}.example.invalid/mcp" }] }),
    registryEntry("query", { remotes: [{ type: "streamable-http", url: "https://service.example.invalid/mcp?key=example" }] }),
    registryEntry("host", { remotes: [{ type: "streamable-http", url: "https://service.example.invalid/mcp", headers: [{ name: "Host", value: "other.invalid" }] }] }),
    registryEntry("local", { remotes: [], packages: [{ registryType: "npm", identifier: "@fixture/local", version: "1.0.0", transport: { type: "stdio" } }] }),
    registryEntry("deprecated", {}, "deprecated"), registryEntry("deleted", {}, "deleted"), { server: { name: "broken" } },
  ];
  t.mock.method(globalThis, "fetch", async () => json({ servers: [...entries, entries[0]] }));
  const data = await searchRegistry(query(), signal());
  assert.equal(data.items.length, 7); assert.equal(data.skipped, 3);
  const headers = data.items[0].remotes[0].headers;
  assert.deepEqual(headers.map(item => item.value), ["", "", "compact"]); assert.equal(headers[0].required, true);
  assert.equal(data.items[0].repositoryUrl, null); assert.equal(data.items[0].websiteUrl, null);
  assert.equal(data.items[0].remotes[0].unavailableReason, null);
  for (const server of data.items.slice(1, 5)) assert.ok(server.remotes[0].unavailableReason);
  assert.equal(data.items[5].packages[0].identifier, "@fixture/local"); assert.equal(data.items[6].status, "deprecated");
});

test("details pin an exact server/version and reject mismatched identities, removed entries and malformed metadata", async t => {
  const calls: string[] = []; let value: unknown = registryEntry("exact");
  t.mock.method(globalThis, "fetch", async url => { calls.push(String(url)); return json(value); });
  const data = await getRegistryServer({ name: "io.github.ria-fixture/exact", version: "1.2.3" }, signal());
  assert.equal(data.version, "1.2.3");
  assert.equal(calls[0], "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.ria-fixture%2Fexact/versions/1.2.3");
  for (const row of [registryEntry("wrong"), registryEntry("removed", {}, "deleted"), { unexpected: true }]) {
    value = row;
    await assert.rejects(getRegistryServer({ name: `io.github.ria-fixture/${randomUUID()}`, version: "1.2.3" }, signal()), { code: "UPSTREAM_FAILED" });
  }
});

test("successful metadata is cached for one hour, returned as independent values and refreshed after expiry", async t => {
  let clock = Date.now(), calls = 0;
  t.mock.method(Date, "now", () => clock);
  t.mock.method(globalThis, "fetch", async () => { calls++; return json({ servers: [registryEntry("cache")] }); });
  const input = query(); const first = await searchRegistry(input, signal()); first.items[0].title = "changed locally";
  assert.equal((await searchRegistry(input, signal())).items[0].title, "Registry cache"); assert.equal(calls, 1);
  clock += REGISTRY_LIMITS.cacheMs + 1;
  await searchRegistry(input, signal()); assert.equal(calls, 2);
});

test("bounded cache eviction cannot change the result of a fresh registry request", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return json({ servers: [] }); });
  const first = query(); await searchRegistry(first, signal());
  for (let i = 0; i < REGISTRY_LIMITS.cacheEntries; i++) await searchRegistry(query(), signal());
  await searchRegistry(first, signal()); assert.equal(calls, REGISTRY_LIMITS.cacheEntries + 2);
});

test("registry failures remain actionable and are not retried or cached", async t => {
  let calls = 0;
  const responses = [new Response("not JSON"), json({ wrong: [] }), json({}, 503), json({}, 404), json({ servers: [] })];
  t.mock.method(globalThis, "fetch", async () => { calls++; return responses.shift()!; });
  const input = query();
  for (const code of ["UPSTREAM_FAILED", "UPSTREAM_FAILED", "UPSTREAM_FAILED", "NOT_FOUND"]) await assert.rejects(searchRegistry(input, signal()), { code });
  assert.equal((await searchRegistry(input, signal())).items.length, 0); assert.equal(calls, 5);
});

test("oversized registry bodies are cancelled whether or not a content length was supplied", async t => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(REGISTRY_LIMITS.responseBytes + 1)); }, cancel() { cancelled = true; } });
    t.mock.method(globalThis, "fetch", async () => new Response(body, declared ? { headers: { "content-length": String(REGISTRY_LIMITS.responseBytes + 1) } } : undefined));
    await assert.rejects(searchRegistry(query(), signal()), { code: "UPSTREAM_FAILED" }); assert.equal(cancelled, true);
    t.mock.restoreAll();
  }
});

test("cancellation releases a stalled response and never commits a partial cache entry", async t => {
  const controller = new AbortController(); let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new TextEncoder().encode('{"servers":')); }, cancel() { cancelled = true; } });
  let reading!: () => void; const began = new Promise<void>(resolve => { reading = resolve; });
  t.mock.method(globalThis, "fetch", async () => { reading(); return new Response(body); });
  const input = query(); const pending = searchRegistry(input, controller.signal); await began;
  controller.abort(new DOMException("Cancelled", "AbortError"));
  await assert.rejects(pending, { name: "AbortError" }); assert.equal(cancelled, true);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => json({ servers: [] }));
  assert.deepEqual((await searchRegistry(input, signal())).items, []);
});

test("timeouts and non-advancing cursors cannot leave an unbounded discovery request", async t => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => controller.signal);
  let fetched!: () => void; const began = new Promise<void>(resolve => { fetched = resolve; });
  t.mock.method(globalThis, "fetch", async (_url, init) => { fetched(); return new Promise((_resolve, reject) => { init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }); }); });
  const pending = searchRegistry(query(), signal()); await began; controller.abort();
  await assert.rejects(pending, { code: "TIMEOUT" });
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => json({ servers: [], metadata: { nextCursor: "same" } }));
  await assert.rejects(searchRegistry({ ...query(), cursor: "same" }, signal()), { code: "UPSTREAM_FAILED" });
});

test("discovery routes enforce local access, query bounds, host checks and a shared request quota", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return json({ servers: [] }); });
  assert.equal((await root.GET(req("", ""))).status, 401);
  assert.equal((await root.GET(req("", cookie, { host: "outside.invalid" }))).status, 403);
  for (const params of ["?search=a&search=b", "?url=https://outside.invalid", `?search=${"x".repeat(101)}`, `?cursor=${"x".repeat(2049)}`]) assert.equal((await root.GET(req(params))).status, 400);
  assert.equal((await detail.GET(req("?name=../outside&version=1"))).status, 400);
  assert.equal((await detail.GET(req("?name=io.github.ria-fixture/server/extra&version=1"))).status, 400);
  assert.equal((await detail.GET(req("?name=io.github.ria-fixture/echo&version=latest"))).status, 400);
  assert.equal((await detail.GET(req("?name=io.github.ria-fixture/echo&version=.."))).status, 400);
  assert.equal(calls, 0);
  globalThis.__privateAiRateLimitStore?.clear();
  const path = `?search=${randomUUID()}`;
  for (let i = 0; i < 30; i++) assert.equal((await root.GET(req(path))).status, 200);
  const limited = await root.GET(req(path)); assert.equal(limited.status, 429); assert.ok(limited.headers.get("retry-after")); assert.equal(calls, 1);
});
