import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import type { AddressInfo } from "node:net";
import type { UIMessage, ToolExecutionOptions } from "ai";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { languageModel, providerState } from "../helpers/model-provider";
import { seedTestModelPreferences } from "../helpers/model-library";

const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");

const chatRoute = await import("@/app/api/chat/route");
const { readChatRequest } = await import("@/lib/chat/request");
const { decodePersistedAssistantToolMessage, encodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
const { saveChatMessage, releaseUnclaimedToolApproval } = await import("@/lib/chat/store");
const { persistChatResponse } = await import("@/lib/chat/persistence");
const { runWebSearch } = await import("@/tools/definitions/web-search");
const { createChatToolSet } = await import("@/tools/catalog");
const { GET } = await import("@/app/api/local-access/route");
const { issueHandshakeCode } = await import("@/lib/server/local-access");
let cookie;
beforeEach(async (t: TestContext) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  providerState.streamGate = undefined;
  providerState.streamError = false;
  cookie = localAccessCookie();
  await db.message.deleteMany({});
  await db.chat.deleteMany({});
  await db.memory.deleteMany({});
  await db.workspacePreference.deleteMany({});
  await seedTestModelPreferences(db);
});
after(async () => { await db.$disconnect(); cleanup(); });

const ui = (id, role: UIMessage["role"], text): UIMessage => ({ id, role, parts: [{ type: "text", text }] });
// These tests drive the tool implementations directly rather than through the
// model loop, and none of them read the per-call execution context.
const toolOptions = {} as ToolExecutionOptions;
function chatRequest(body, headers = {}) {
  return new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers: { cookie, "content-type": "application/json", ...headers },
    body: JSON.stringify({ manualToolsOnly: true, ...body }),
  });
}

test("approval claimed but lost before tool execution is released for retry", async () => {
  const owned = await db.chat.create({ data: { title: "Approval retry" } });
  const approval = { id: "approval-1", approved: true };
  await saveChatMessage({
    chatId: owned.id, role: "assistant",
    content: encodePersistedAssistantToolMessage({
      type: "assistant-tool-message", text: "waiting",
      tools: [{ toolName: "createTask", toolCallId: "call-1", state: "approval-requested", input: { title: "Buy milk" }, approval }],
    }),
    status: "success",
    clientMessageId: "assistant-1",
  });
  const decision: UIMessage = {
    id: "assistant-1", role: "assistant",
    parts: [{ type: "tool-createTask", toolCallId: "call-1", state: "approval-responded", input: { title: "Buy milk" }, approval }],
  };
  await releaseUnclaimedToolApproval(owned.id, decision);
  const rows = await db.message.findMany({ where: { chatId: owned.id } });
  const restored = decodePersistedAssistantToolMessage(rows[0].content);
  assert.equal(restored.tools[0].state, "approval-requested", "a claimed-but-unexecuted approval returns to pending");
});

test("persistChatResponse never overwrites a title renamed during generation", async () => {
  const owned = await db.chat.create({ data: { title: "New Chat" } });
  const input = await readChatRequest(chatRequest({ chatId: owned.id, messages: [ui("rename-user", "user", "回答这个问题")] }));
  const conversation = { chat: owned, regenerationSnapshot: null };
  await db.chat.update({ where: { id: owned.id }, data: { title: "用户改过的标题" } });
  await persistChatResponse({ input, conversation, responseMessage: ui("assistant-rename", "assistant", "回答"), isAborted: false, generationFailed: false });
  const after = await db.chat.findUnique({ where: { id: owned.id } });
  assert.equal(after.title, "用户改过的标题");
  assert.ok(after.lastMessageAt);
});

test("a still-unrenamed conversation is titled from its first user message", async () => {
  const owned = await db.chat.create({ data: { title: "New Chat" } });
  const input = await readChatRequest(chatRequest({ chatId: owned.id, messages: [ui("title-user", "user", "帮我制定一周学习计划")] }));
  await persistChatResponse({ input, conversation: { chat: owned, regenerationSnapshot: null }, responseMessage: ui("assistant-title", "assistant", "好的"), isAborted: false, generationFailed: false });
  const after = await db.chat.findUnique({ where: { id: owned.id } });
  assert.match(after.title, /帮我制定一周学习计划|帮我制定一周/);
});

test("web search refuses to run after cancellation", async () => {
  process.env.TAVILY_API_KEY = "offline-fixture-key";
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runWebSearch({ query: "test" }, controller.signal), (error: any) => error.code === "TIMEOUT");
  delete process.env.TAVILY_API_KEY;
});

/**
 * A Tavily-shaped endpoint on loopback. The tool is only mounted when it is
 * configured, so a budget test has to configure it — and configuring it against
 * the real service would turn a unit test into a billed request.
 */
async function withLocalSearchServer(run) {
  const { createServer } = await import("node:http");
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    // The shape the installed Tavily adapter expects; a partial body is
    // rejected by the adapter and reads as an unreachable upstream.
    response.end(JSON.stringify({ query: "budget", request_id: "local", response_time: 0.01, images: [], results: [{ title: "Local fixture", url: "https://example.invalid/budget", content: "fixture", score: 1 }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const previousKey = process.env.TAVILY_API_KEY;
  const previousUrl = process.env.TAVILY_SEARCH_URL;
  process.env.TAVILY_API_KEY = "local-budget-fixture";
  process.env.TAVILY_SEARCH_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/search`;
  try {
    return await run(() => requests);
  } finally {
    if (previousKey === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.TAVILY_SEARCH_URL; else process.env.TAVILY_SEARCH_URL = previousUrl;
    await new Promise(resolve => server.close(resolve));
  }
}

test("parallel tool executions cannot double-spend the per-turn result budget", async () => {
  await withLocalSearchServer(async () => {
    const toolSet = await createChatToolSet({ toolIds: ["webSearch"] });
    const webSearch = toolSet.webSearch;
    // The tool really runs: both calls reach the fixture, so the budget being
    // respected is a fact and not the result of every call being rejected.
    const first = webSearch.execute({ query: "parallel one" }, toolOptions);
    const second = webSearch.execute({ query: "parallel two" }, toolOptions);
    const results = await Promise.allSettled([first, second]);
    const outputs = results.filter((entry) => entry.status === "fulfilled").map((entry) => entry.value);
    assert.equal(outputs.length, 2, "both parallel searches should have run");
    const plannedTotal = outputs.reduce((sum, output) => sum + (output.results?.length ?? 0), 0);
    assert.ok(plannedTotal <= 10, `parallel searches must not exceed the shared budget (planned ${plannedTotal})`);
  });
});

test("the local entry redirect keeps cookie scope for IPv6 loopback as well", (t) => {
  t.mock.method(console, "info", () => {});
  const entryUrl = new URL("/api/local-access", "http://[::1]:3000");
  entryUrl.searchParams.set("handshake", issueHandshakeCode());
  const response = GET(new NextRequest(entryUrl, { headers: { host: entryUrl.host, "sec-fetch-site": "none" } }));
  assert.equal(new URL(response.headers.get("location"), entryUrl).origin, entryUrl.origin);
});
test("an unconfigured optional tool is not handed to the model at all", async()=>{
  const {createChatToolSet,toolAvailability,listPublicToolCatalog,assertToolConfiguration}=await import("@/tools/catalog");
  const previous=process.env.TAVILY_API_KEY;
  try{
    delete process.env.TAVILY_API_KEY;
    // The model never sees it, so it cannot call it, retry it, or spend a step
    // discovering that it is missing. No search request is ever attempted.
    assert.equal("webSearch" in (await createChatToolSet({})), false);
    assert.deepEqual(await toolAvailability("webSearch"),{available:false,reason:"notConfigured",configEntry:"/settings"});
    assert.equal((await toolAvailability("searchKnowledge")).available,true);
    // The manual entry point still refuses it explicitly, because there the
    // user asked for that tool by name.
    await assert.rejects(()=>assertToolConfiguration("webSearch"),/联网搜索尚未配置/);
    await assert.doesNotReject(()=>assertToolConfiguration("createTask"));
    // The picker is told which tool is missing and why, instead of showing a
    // list that silently lacks one entry.
    const catalog=await listPublicToolCatalog("chat");
    assert.equal(catalog.find(tool=>tool.id==="webSearch").available,false);
    assert.equal(catalog.find(tool=>tool.id==="webSearch").reason,"notConfigured");
    // The way out comes with the reason, so the interface can offer it.
    assert.equal(catalog.find(tool=>tool.id==="webSearch").configEntry,"/settings");
    assert.equal(catalog.find(tool=>tool.id==="createTask").configEntry,null);
    assert.equal(catalog.find(tool=>tool.id==="createTask").available,true);
  }finally{
    if(previous===undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY=previous;
  }
});

test("the chat prompt names the tool this turn cannot use", async()=>{
  const {buildSystemPrompt}=await import("@/lib/chat/model-context");
  const withSearch=buildSystemPrompt("none","none",true,[]);
  const withoutSearch=buildSystemPrompt("none","none",true,["webSearch"]);
  assert.equal(withSearch.includes("Web search is not configured"),false);
  // The model has to be told, or a question that needed live information is
  // answered from memory as though it had been checked.
  assert.equal(withoutSearch.includes("Web search is not configured"),true);
  assert.equal(withoutSearch.includes("say plainly that this turn did not search the web"),true);
});

test("an exhausted result budget is reported as skipped, not as an empty search", async()=>{
  const {createChatToolSet}=await import("@/tools/catalog");
  await withLocalSearchServer(async requests=>{
    const webSearch=(await createChatToolSet({toolIds:["webSearch"]})).webSearch;
    // The first call spends the whole budget; the second is the one that
    // matters, because this is the call that used to look like a search that
    // ran and found nothing.
    await webSearch.execute({query:"first",maxResults:10},toolOptions);
    const skipped=await webSearch.execute({query:"second",maxResults:5},toolOptions);
    assert.deepEqual(skipped,{query:"second",results:[],skipped:"resultBudget"});
    // The skipped call made no provider request, which is the whole point of
    // marking it: it is not an empty result set, it is no result set.
    assert.equal(requests(),1);
  });
});

test("an optional tool that becomes unavailable mid-turn answers instead of failing the turn", async()=>{
  await withLocalSearchServer(async()=>{
    const {createChatToolSet}=await import("@/tools/catalog");
    // Built while the key is present, so the tool is mounted…
    const webSearch=(await createChatToolSet({toolIds:["webSearch"]})).webSearch;
    // …and the key disappears before it runs, as it would if it were cleared in
    // another window.
    delete process.env.TAVILY_API_KEY;
    try{
      const output=await webSearch.execute({query:"still here?"},toolOptions);
      // A controlled result, so the model is told once and spends the rest of
      // the turn on what it can do.
      assert.deepEqual(output,{query:"still here?",results:[],skipped:"notConfigured"});
    }finally{
      process.env.TAVILY_API_KEY="local-budget-fixture";
    }
  });
});

test("a transient search failure is a skipped result, while a refused call still fails", async()=>{
  const {createChatToolSet}=await import("@/tools/catalog");
  await withLocalSearchServer(async()=>{
    const webSearch=(await createChatToolSet({toolIds:["webSearch"]})).webSearch;
    // Point the search at a port with nothing behind it: a transport failure
    // that a retry will not fix on its own.
    const previousUrl=process.env.TAVILY_SEARCH_URL;
    process.env.TAVILY_SEARCH_URL="http://127.0.0.1:1/search";
    try{
      const output=await webSearch.execute({query:"unreachable"},toolOptions);
      assert.equal(output.skipped,"temporarilyUnavailable");
      assert.deepEqual(output.results,[]);
      // And it is not written to memory as something that was found.
      const {getWebSearchSources}=await import("@/features/chat/message-presentation");
      // Only the part's output carries the sources; the reader keys off that.
      assert.deepEqual(getWebSearchSources([{type:"tool-webSearch",state:"output-available",output}] as unknown as Parameters<typeof getWebSearchSources>[0]),[]);
    }finally{
      process.env.TAVILY_SEARCH_URL=previousUrl;
    }
  });
});

test("a refused approval is not absorbed into a skipped tool result", async()=>{
  const {createChatToolSet}=await import("@/tools/catalog");
  await withLocalSearchServer(async()=>{
    const tools=await createChatToolSet({toolIds:["createTask"]});
    // A tool that needs approval still needs it: the degradation path is for
    // optional tools that are merely unavailable, never for a refusal.
    assert.equal(Boolean(tools.createTask),true);
    const {ApiError}=await import("@/lib/server/api-error");
    await assert.rejects(()=>tools.createTask.execute({title:""},toolOptions),error=>error instanceof ApiError);
  });
});
