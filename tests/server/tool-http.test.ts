import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test, type Mock, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { seedSearchModelPreferences, seedTestModelPreferences, SEARCH_MODEL_REF } from "../helpers/model-library";
import { respondWithResults, startSearchServer } from "../helpers/search-server";
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
  const server = await startSearchServer(respond);
  await seedSearchModelPreferences(db, server.baseURL);
  t.after(() => server.close());
  return server;
}
function run(maxResults = 2, signal?: AbortSignal) {
  return tools.POST(new NextRequest("http://localhost/api/tools/run", {
    method: "POST", headers: { cookie, "content-type": "application/json" }, signal,
    body: JSON.stringify({ tool: "webSearch", mode: "chat", input: { query: " Local HTTP search ", maxResults } }),
  }));
}
const logs = () => (console.info as Mock<(...data: any[]) => void>).mock.calls.filter((call) => call.arguments[0] === "tool.execution").map((call) => call.arguments[1]);

test("DeepSeek search preserves counts above ten and caps only at its own fifty-result API ceiling", async t => {
  const fixture = await upstream(t, res => respondWithResults(res, Array.from({ length: 60 }, (_, i) => ({ title: `Source ${i}`, url: `https://example.invalid/${i}`, summary: "Evidence" }))));
  for (const [requested, expected] of [[17, 17], [80, 50]]) {
    const response = await run(requested);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.results.length, expected);
    assert.equal(fixture.requests.at(-1).body.count, expected);
  }
});

test("web search sends real HTTP requests, normalizes sources and records one successful execution", async (t) => {
  const fixture = await upstream(t, (res) => respondWithResults(res, [
    { title: "Unsafe source", url: "javascript:alert(1)", summary: "Ignore" },
    { title: " Local source ", url: "https://example.invalid/source", summary: " First\n  source ", rerank_score: 0.94567 },
    { title: "Duplicate", url: "https://example.invalid/source", summary: "Ignore duplicate" },
    { title: "Missing URL", summary: "Ignored" },
    { title: "Second source", url: "https://example.invalid/second", summary: "x".repeat(1200) },
    { title: "Extra source", url: "https://example.invalid/extra", summary: "Outside limit" },
  ]));
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
  assert.equal(fixture.requests[0].path, "/v1/tools/search");
  assert.equal(fixture.requests[0].body.query, "Local HTTP search");
  assert.equal(fixture.requests[0].body.count, 2);
  assert.equal(payload.data.provider, "deepseek-search");
  assert.equal(payload.data.results.length, 2);
  assert.equal(payload.data.results[0].title, "Local source");
  assert.equal(payload.data.results[0].snippet, "First source");
  assert.equal(payload.data.results[0].score, 0.94567);
  assert.equal(payload.data.results[1].snippet.length, 1000);
  assert.match(payload.assistantText, /https:\/\/example.invalid\/source/);
  assert.deepEqual(logs().map((entry) => entry.state), ["output-available"]);
  // A search does not leave a knowledge candidate behind.
  assert.equal(await db.memory.count({ where: { key: { startsWith: "tool:webSearch:" } } }), 0);
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

test("cancelling a search aborts its actual HTTP transport without recording an empty success", async t => {
  const controller = new AbortController();
  const fixture = await upstream(t, () => controller.abort());
  const { runWebSearch } = await import("@/tools/definitions/web-search");
  await assert.rejects(runWebSearch({ query: "cancel this" }, controller.signal, SEARCH_MODEL_REF), /cancelled/);
  await fixture.closed;
  assert.equal(fixture.requests.length, 1);
});
