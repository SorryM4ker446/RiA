import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createTestDatabase } from "../helpers/database";
import { seedTestModelPreferences, CHAT_MODEL_REF } from "../helpers/model-library";
import { executeProviderSearch, resolveSearchRoute, searchConfigured } from "@/tools/definitions/provider-search";


const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { buildSystemPrompt } = await import("@/lib/chat/model-context");
const { createChatToolSet, toolAvailability, getToolDescriptor, executeRegisteredTool } = await import("@/tools/catalog");
const { assistantConfigSchema } = await import("@/lib/assistants/schema");
const deepseek = { providerId: "deepseek" as const, modelId: "deepseek-v4-pro" };
const input = { query: "current release", maxResults: 2 };
const row = { title: "Release", url: "https://example.com/release", summary: "Verified excerpt", rerank_score: 2.4 };
beforeEach(async () => {
  process.env.OPENROUTER_API_KEY = "offline-provider-key";
  process.env.DEEPSEEK_API_KEY = "offline-provider-key";
  process.env.TAVILY_API_KEY = "";
  process.env.TAVILY_SEARCH_URL = "";
  process.env.DEEPSEEK_BASE_URL = "";
  await seedTestModelPreferences(db);
  await db.modelRequest.deleteMany({});
});
after(async () => { await db.$disconnect(); cleanup(); });

function fixture(payload: unknown, inspect?: (url: string, body: any) => void): typeof fetch {
  return async (url, init) => {
    inspect?.(String(url), JSON.parse(String(init?.body)));
    return Response.json(payload);
  };
}

test("provider search remains available without Tavily and wins when a third-party key is present", async () => {
  assert.equal(resolveSearchRoute(deepseek), "deepseek-native");
  assert.equal(resolveSearchRoute({ ...deepseek, modelId: "deepseek-flash" }), "deepseek-search");
  assert.equal(resolveSearchRoute(CHAT_MODEL_REF), "openrouter");
  assert.equal((await toolAvailability("webSearch", CHAT_MODEL_REF)).available, true);
  assert.ok((await createChatToolSet({ modelRef: CHAT_MODEL_REF, toolIds: ["webSearch"] })).webSearch);
  assert.equal((await createChatToolSet({ modelRef: CHAT_MODEL_REF, toolIds: [] })).webSearch, undefined);
  process.env.TAVILY_API_KEY = "offline-backup-key";
  assert.equal(resolveSearchRoute(deepseek), "deepseek-native");
  assert.equal(resolveSearchRoute(CHAT_MODEL_REF), "openrouter");
  process.env.OPENROUTER_API_KEY = "";
  assert.equal(resolveSearchRoute(CHAT_MODEL_REF), "tavily");
  process.env.TAVILY_API_KEY = "";
  assert.equal(searchConfigured(CHAT_MODEL_REF), false);
  assert.equal(searchConfigured(deepseek), true);
});

test("search counts are positive model choices without the former ten-result schema or catalog quota", () => {
  const descriptor = getToolDescriptor("webSearch")!;
  assert.deepEqual(descriptor.manual.fields, []);
  assert.equal(descriptor.resultBudget, undefined);
  for (const maxResults of [1, 17, 50, 100]) assert.equal(descriptor.inputSchema.safeParse({ query: "research", maxResults }).success, true);
  for (const maxResults of [0, -1, 1.5, Infinity, NaN]) assert.equal(descriptor.inputSchema.safeParse({ query: "research", maxResults }).success, false);
});

test("manual search asks the selected model for a count and uses all selected evidence in synthesis", async t => {
  let plans = 0;
  let searches = 0;
  let syntheses = 0;
  const sources = Array.from({ length: 14 }, (_, i) => ({ ...row, title: `Source ${i + 1}`, url: `https://example.com/source-${i + 1}` }));
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, CHAT_MODEL_REF.modelId);
    if (body.tools?.some(tool => tool.type === "openrouter:web_search")) {
      searches++;
      assert.equal(body.tools[0].parameters.max_results, 14);
      return Response.json({ choices: [{ message: { content: "Evidence", annotations: sources.map(source => ({ type: "url_citation", url_citation: source })) } }] });
    }
    if (body.response_format) {
      plans++;
      assert.match(JSON.stringify(body.messages), /Choose the number of web search results/);
      return Response.json({ choices: [{ index: 0, message: { role: "assistant", content: '{"maxResults":14}' }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    }
    syntheses++;
    assert.match(JSON.stringify(body.messages), /source-14/);
    // Synthesis streams, so it ends on inactivity rather than a fixed total.
    assert.equal(body.stream, true);
    const events = [{ id: "s", choices: [{ index: 0, delta: { role: "assistant", content: "Answer with all the evidence." } }] },
      { id: "s", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const descriptor = getToolDescriptor("webSearch")!;
  const result = await executeRegisteredTool(descriptor, { query: "Compare the current release options" }, { trigger: "manual", modelRef: CHAT_MODEL_REF });
  assert.equal(result.input.maxResults, 14);
  assert.equal(result.output.results.length, 14);
  const text = await descriptor.buildAssistantText({ ...result, modelRef: CHAT_MODEL_REF, trigger: "manual" });
  assert.equal(text, "Answer with all the evidence.");
  assert.deepEqual([plans, searches, syntheses], [1, 1, 1]);
  assert.ok(await db.modelRequest.count({ where: { source: "tool", status: "success" } }) >= 3);
});

test("a failed count plan never starts a search or substitutes a fixed default", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(String(init?.body)).tools, undefined);
    return Response.json({ choices: [{ index: 0, message: { role: "assistant", content: '{"maxResults":0}' }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  });
  await assert.rejects(executeRegisteredTool(getToolDescriptor("webSearch")!, { query: "Research" }, { trigger: "manual", modelRef: CHAT_MODEL_REF }));
  assert.equal(calls, 1);
});

test("count planning cancellation reaches the model transport and cannot start a search", async t => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++;
    controller.abort();
    init!.signal!.throwIfAborted();
    throw new Error("unreachable");
  });
  await assert.rejects(executeRegisteredTool(getToolDescriptor("webSearch")!, { query: "Research" }, { trigger: "manual", modelRef: CHAT_MODEL_REF, signal: controller.signal }));
  assert.equal(calls, 1);
});

test("provider transports preserve model counts above ten and apply only their documented ceilings", async () => {
  for (const [requested, expected] of [[37, 37], [80, 50]]) {
    const output = await executeProviderSearch("deepseek-search", { query: "Compare", maxResults: requested }, deepseek, undefined, fixture({ results: Array.from({ length: 60 }, (_, i) => ({ ...row, url: `https://example.com/${i}` })) }, (_url, body) => assert.equal(body.count, expected)));
    assert.equal(output.output.results.length, expected);
  }
  for (const [requested, expected] of [[18, 18], [80, 25]]) await executeProviderSearch("openrouter", { query: "Compare", maxResults: requested }, CHAT_MODEL_REF, undefined, fixture({ choices: [{ message: { content: "" } }] }, (_url, body) => assert.equal(body.tools[0].parameters.max_results, expected)));
  await executeProviderSearch("deepseek-native", { query: "Compare", maxResults: 35 }, deepseek, undefined, fixture({ output: [] }, (_url, body) => assert.match(body.input, /35 relevant sources/)));
});

test("DeepSeek Flash uses the independent official Search API with bounded evidence and Unicode query validation", async () => {
  const output = await executeProviderSearch("deepseek-search", input, { ...deepseek, modelId: "deepseek-flash" }, undefined, fixture({ results: [row, row, { ...row, url: "javascript:alert(1)" }] }, (url, body) => {
    assert.equal(url, "https://api.deepseek.com/v1/tools/search");
    assert.deepEqual(body, { query: input.query, count: 2, need_content: false });
  }));
  assert.equal(output.output.results.length, 1);
  assert.equal(output.output.results[0].snippet, "Verified excerpt");
  assert.equal(output.output.results[0].score, 2.4);
  assert.equal(output.output.usage?.costUsd, null);
  await assert.rejects(executeProviderSearch("deepseek-search", { query: "x".repeat(129) }, deepseek, undefined, fixture({ results: [] })), /128 characters/);
  await executeProviderSearch("deepseek-search", { query: "🧪".repeat(128) }, deepseek, undefined, fixture({ results: [] }));
});

test("DeepSeek Pro uses native Responses web_search and preserves actual citations and token usage", async () => {
  const result = await executeProviderSearch("deepseek-native", input, deepseek, undefined, fixture({ status: "completed", output: [
    { type: "web_search_call", status: "completed", action: { sources: [row] } },
    { type: "message", content: [{ type: "output_text", text: "Summary", annotations: [{ type: "url_citation", url: row.url, title: row.title }] }] },
  ], usage: { input_tokens: 50, output_tokens: 20 } }, (url, body) => {
    assert.equal(url, "https://api.deepseek.com/responses");
    assert.deepEqual(body.tools, [{ type: "web_search" }]);
    assert.equal(body.model, "deepseek-v4-pro");
  }));
  assert.equal(result.output.results.length, 1);
  assert.equal(result.output.evidenceSummary, "Summary");
  assert.deepEqual(result.usage, { inputTokens: 50, outputTokens: 20 });
});

test("OpenRouter gateway search is bounded, returns source excerpts and records provider cost through the real tool wrapper", async t => {
  t.mock.method(globalThis, "fetch", fixture({ id: "gateway-search", choices: [{ message: { content: "Grounded answer", annotations: [{ type: "url_citation", url_citation: { ...row, content: "Gateway excerpt" } }] } }], usage: { prompt_tokens: 40, completion_tokens: 10, cost: 0.004, server_tool_use: { web_search_requests: 1 } } }, (url, body) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(body.tools[0].type, "openrouter:web_search");
    assert.equal(body.tools[0].parameters.max_uses, 1);
    assert.equal(body.max_tool_calls, 1);
    assert.equal(body.tools[0].parameters.max_total_results, 2);
  }));
  const tools = await createChatToolSet({ modelRef: CHAT_MODEL_REF, toolIds: ["webSearch"] });
  const output = await tools.webSearch.execute!(input, {} as never) as any;
  assert.equal(output.provider, "openrouter");
  assert.equal(output.results[0].url, row.url);
  const request = await db.modelRequest.findFirstOrThrow();
  assert.equal(request.status, "success");
  assert.equal(request.costUsd, 0.004);
  assert.equal(request.inputTokens, 40);
  assert.equal(await db.modelRequest.count({ where: { status: "pending" } }), 0);
});

test("no search call, empty results and malformed or failed output remain distinct", async () => {
  const noSearch = await executeProviderSearch("openrouter", input, CHAT_MODEL_REF, undefined, fixture({ choices: [{ message: { content: "I know this already" } }] }));
  assert.equal(noSearch.output.skipped, "temporarilyUnavailable");
  assert.equal(noSearch.output.evidenceSummary, undefined);
  const empty = await executeProviderSearch("deepseek-search", input, deepseek, undefined, fixture({ results: [] }));
  assert.equal(empty.output.skipped, undefined);
  assert.deepEqual(empty.output.results, []);
  for (const payload of [{}, { error: { message: "secret upstream diagnostic" } }, { status: "incomplete", output: [] }]) {
    await assert.rejects(executeProviderSearch("deepseek-native", input, deepseek, undefined, fixture(payload)), error => !String(error).includes("secret upstream diagnostic"));
  }
});

test("a provider response that never searched records a skipped step and never claims result-budget exhaustion", async t => {
  t.mock.method(globalThis, "fetch", fixture({ choices: [{ message: { content: "Answer without a search" } }] }));
  const { startRun } = await import("@/lib/agent/runs");
  const { getToolDescriptor } = await import("@/tools/catalog");
  const run = await startRun({ chatId: null, goal: "Search the web" });
  const tools = await createChatToolSet({ modelRef: CHAT_MODEL_REF, toolIds: ["webSearch"], runId: run.id });
  const output = await tools.webSearch.execute!(input, {} as never) as any;
  assert.equal(output.skipped, "temporarilyUnavailable");
  assert.deepEqual(output.results, []);
  assert.equal((await db.agentStep.findFirstOrThrow({ where: { runId: run.id } })).state, "skipped");
  const text = await getToolDescriptor("webSearch")!.buildAssistantText!({ input, output, modelRef: CHAT_MODEL_REF, trigger: "manual" });
  assert.match(text, /未完成有效搜索/);
  assert.doesNotMatch(text, /预算|返回 0/);
});

test("provider errors do not silently perform another paid search and cancellation reaches the transport", async () => {
  let calls = 0;
  await assert.rejects(executeProviderSearch("openrouter", input, CHAT_MODEL_REF, undefined, async () => { calls++; return new Response("private diagnostic", { status: 403 }); }), /HTTP 403/);
  assert.equal(calls, 1);
  const controller = new AbortController();
  const pending = executeProviderSearch("deepseek-search", input, deepseek, controller.signal, async (_url, init) => {
    controller.abort();
    init!.signal!.throwIfAborted();
    throw new Error("unreachable");
  });
  await assert.rejects(pending, /cancelled/);
});

for (const status of [404, 501]) test(`an unsupported provider search endpoint (HTTP ${status}) can use configured Tavily without making it a prerequisite`, async t => {
  process.env.TAVILY_API_KEY = "offline-backup-key";
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push(String(url));
    if (String(url).startsWith("https://openrouter.ai/")) return new Response(null, { status });
    assert.equal(String(url), "https://api.tavily.com/search");
    assert.equal(JSON.parse(String(init?.body)).max_results, 2);
    return Response.json({ results: [{ title: "Backup", url: row.url, content: "Backup evidence" }] });
  });
  const { runWebSearch } = await import("@/tools/definitions/web-search");
  const output = await runWebSearch(input, undefined, CHAT_MODEL_REF);
  assert.equal(output.provider, "tavily");
  assert.equal(output.fallbackFrom, "openrouter");
  assert.equal(output.results[0].snippet, "Backup evidence");
  assert.equal(calls.length, 2);
  assert.equal((await db.modelRequest.findFirstOrThrow()).status, "error");
  assert.equal(await db.modelRequest.count({ where: { status: "pending" } }), 0);
});

test("configured backups cannot bypass provider permission, balance, quota errors or ambiguous failures", async t => {
  process.env.TAVILY_API_KEY = "offline-backup-key";
  let status = 403;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async url => {
    calls++;
    assert.ok(String(url).startsWith("https://openrouter.ai/"));
    return new Response(null, { status });
  });
  const { runWebSearch } = await import("@/tools/definitions/web-search");
  for (status of [401, 402, 403, 429, 500]) {
    const before = calls;
    await assert.rejects(runWebSearch(input, undefined, CHAT_MODEL_REF), new RegExp(`HTTP ${status}`));
    assert.equal(calls - before, 1);
  }
});

test("prompts only disclose requested capability failures and distinguish template restrictions from missing configuration", () => {
  const configuredAway = buildSystemPrompt(true, [{ id: "webSearch", reason: "notConfigured" }]);
  const templateDisabled = buildSystemPrompt(false, [{ id: "webSearch", reason: "templateDisabled" }]);
  assert.match(configuredAway, /Mention an unavailable capability only when the user asked for something it prevents/);
  assert.match(configuredAway, /configure the tool's connection or provider/);
  assert.match(templateDisabled, /disabled by the current assistant template/);
  assert.doesNotMatch(templateDisabled, /webSearch is not configured/);
  for (const prompt of [configuredAway, templateDisabled, buildSystemPrompt(true)]) {
    // The rule is stated once and positively; naming specific unused tools would prime them.
    assert.equal(prompt.split("Mention an unavailable capability only when").length, 2);
    assert.doesNotMatch(prompt, /Do not volunteer|Do not announce unused capabilities/);
    assert.doesNotMatch(prompt, /say plainly that this turn did not search|No tools were run in this turn/);
  }
});

test("legacy template file capabilities map to the approved terminal without granting folder access", () => {
  const config = assistantConfigSchema.parse({ name: "Existing", instructions: "Do work", tools: ["listLocalFiles", "readLocalFile", "writeLocalFile", "searchKnowledge"] });
  assert.deepEqual(config.tools, ["runTerminalCommand", "searchKnowledge"]);
});
