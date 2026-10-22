import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test, type Mock, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { seedTestModelPreferences } from "../helpers/model-library";
import { languageModel } from "../helpers/model-provider";

const cleanup = createTestDatabase();
process.env.RIA_TEST_PROVIDER = "1";
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) process.env[key] = "";
const { db } = await import("@/db");

const tools = await import("@/app/api/tools/run/route");
let cookie;
beforeEach(async (t: TestContext) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  process.env.TAVILY_API_KEY = "local-http-fixture";
  cookie = localAccessCookie();
  await db.message.deleteMany({});
  await db.chat.deleteMany({});
  await db.memory.deleteMany({});
  await db.task.deleteMany({});
  await db.knowledgeDocument.deleteMany({});
  await db.mediaAsset.deleteMany({});
  await db.modelRequest.deleteMany({});
  await db.workspacePreference.deleteMany({});
  await seedTestModelPreferences(db);
});
after(async () => { await db.$disconnect(); cleanup(); });

async function upstream(t, respond) {
  const requests = [];
  let disconnected;
  const closed = new Promise((resolve) => { disconnected = resolve; });
  const server = createServer(async (req, res) => {
    res.once("close", disconnected);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    respond(res);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  process.env.TAVILY_SEARCH_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/search`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return { requests, closed };
}
function run(maxResults = 2) {
  return tools.POST(new NextRequest("http://localhost/api/tools/run", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ tool: "webSearch", mode: "chat", input: { query: " Local HTTP search ", maxResults } }),
  }));
}
const logs = () => (console.info as Mock<(...data: any[]) => void>).mock.calls.filter((call) => call.arguments[0] === "tool.execution").map((call) => call.arguments[1]);

test("Tavily preserves counts above ten and caps only at its own twenty-result API ceiling", async t => {
  const fixture = await upstream(t, res => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ results: Array.from({ length: 24 }, (_, i) => ({ title: `Source ${i}`, url: `https://example.invalid/${i}`, content: "Evidence" })) }));
  });
  for (const [requested, expected] of [[17, 17], [50, 20]]) {
    const response = await run(requested);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.results.length, expected);
    assert.equal(fixture.requests.at(-1).body.max_results, expected);
  }
});

test("web search sends real HTTP requests, normalizes sources and records one successful execution", async (t) => {
  const fixture = await upstream(t, (res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ query: "Local HTTP search", request_id: "local-request", response_time: 0.1, images: [], results: [
      { title: "Unsafe source", url: "javascript:alert(1)", content: "Ignore" },
      { title: " Local source ", url: "https://example.invalid/source", content: " First\n  source ", score: 0.94567 },
      { title: "Duplicate", url: "https://example.invalid/source", content: "Ignore duplicate" },
      { title: "Missing URL", content: "Ignored" },
      { title: "Second source", url: "https://example.invalid/second", content: "x".repeat(700) },
      { title: "Extra source", url: "https://example.invalid/extra", content: "Outside limit" },
    ] }));
  });
  // Synthesis streams; echo its prompt to show which sources it was given.
  t.mock.method(languageModel, "doStream", async options => ({ stream: new ReadableStream({ start(controller) {
    controller.enqueue({ type: "text-start", id: "echo" });
    controller.enqueue({ type: "text-delta", id: "echo", delta: JSON.stringify(options.prompt) });
    controller.enqueue({ type: "text-end", id: "echo" });
    controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
    controller.close();
  } }) }));
  const response = await run();
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].path, "/search");
  assert.equal(fixture.requests[0].body.query, "Local HTTP search");
  assert.equal(fixture.requests[0].body.max_results, 2);
  assert.equal(payload.data.results.length, 2);
  assert.equal(payload.data.results[0].snippet, "First source");
  assert.equal(payload.data.results[0].score, 0.946);
  assert.equal(payload.data.results[1].snippet.length, 500);
  assert.match(payload.assistantText, /https:\/\/example.invalid\/source/);
  assert.deepEqual(logs().map((entry) => entry.state), ["output-available"]);
  assert.equal(await db.memory.count({ where: { key: { startsWith: "tool:webSearch:" } } }), 1);
});

for (const [status, expected, code] of [[403, 503, "CONFIGURATION_ERROR"], [500, 502, "UPSTREAM_FAILED"]]) {
  test(`web search maps upstream HTTP ${status} without leaking provider bodies or writing successful memory`, async (t) => {
    const fixture = await upstream(t, (res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ detail: { error: `${status} upstream fixture diagnostic` } })); });
    const response = await run();
    assert.equal(response.status, expected);
    const body = await response.json();
    assert.equal(body.error.code, code);
    assert.equal(JSON.stringify(body).includes("fixture diagnostic"), false);
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(logs().map((entry) => [entry.state, entry.errorCode]), [["output-error", code]]);
    assert.equal(await db.memory.count({ where: {} }), 0);
  });
}

test("web search actually times out a stalled HTTP connection and later requests recover", { timeout: 40_000 }, async (t) => {
  let respond = false;
  const fixture = await upstream(t, (res) => {
    if (respond) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ images: [], results: [] })); }
  });
  const started = performance.now();
  const response = await run();
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, "TIMEOUT");
  assert.ok(performance.now() - started >= 11_000, "must exercise the real 12-second timeout");
  await fixture.closed;
  assert.deepEqual(logs().map((entry) => [entry.state, entry.errorCode]), [["output-error", "TIMEOUT"]]);
  assert.equal(await db.memory.count({ where: {} }), 0);
  respond = true;
  assert.equal((await run()).status, 200);
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(logs().map((entry) => entry.state), ["output-error", "output-available"]);
});


test("cancelling a search aborts its actual HTTP transport without recording an empty success", async t => {
  const controller = new AbortController();
  const fixture = await upstream(t, () => controller.abort());
  const { runWebSearch } = await import("@/tools/definitions/web-search");
  await assert.rejects(runWebSearch({ query: "cancel this" }, controller.signal), /cancelled/);
  await fixture.closed;
  assert.equal(fixture.requests.length, 1);
});
