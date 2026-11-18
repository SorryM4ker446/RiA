import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, beforeEach, test, type TestContext } from "node:test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { ModelMessage, UIMessage } from "ai";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { CHAT_MODEL_REF, seedTestModelPreferences } from "../helpers/model-library";
import { languageModel, resetProviderState } from "../helpers/model-provider";
import { wireText } from "../helpers/wire-text";
import { startExtensionService } from "../helpers/extension-service";

const cleanup = createTestDatabase();
process.env.RIA_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const chatRoute = await import("@/app/api/chat/route");
const loadingRoute = await import("@/app/api/extensions/[id]/loading/route");
const { createChat } = await import("@/lib/chat/store");
const { createChatToolSet } = await import("@/tools/execution");
const { activeToolIds, deferralThreshold, toolLoadingOf, DEFERRAL_COUNT, DEFERRAL_THRESHOLD_TOKENS, FIND_TOOLS_ID } = await import("@/tools/deferred");
const { EXTENSION_LIMITS, externalToolId, externalToolIdPattern } = await import("@/lib/extensions/schema");
const { saveExtension, testExtension, activateExtension, setExtensionToolLoading } = await import("@/lib/extensions/store");

beforeEach(async (t: TestContext) => {
  for (const method of ["error", "info", "warn"] as const) t.mock.method(console, method, () => {});
  resetProviderState(); globalThis.__riaRateLimitStore?.clear();
  process.env.APP_RUNTIME = "test"; process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder"; process.env.RIA_EXTENSION_KEY = randomBytes(32).toString("base64");
  await db.chat.deleteMany({}); await db.extension.deleteMany({});
  await seedTestModelPreferences(db);
});
after(async () => { await db.$disconnect(); cleanup(); });

/** A tested, enabled connection whose tools are as given; nothing is called, so no service is needed. */
async function connection(name: string, tools: Array<{ name: string; description: string; alwaysLoad?: boolean }>) {
  const id = randomUUID();
  await db.extension.create({ data: { id, name, kind: "mcp-http", config: { type: "mcp-http", url: "http://127.0.0.1:9/mcp" }, enabled: true, revision: 1, testedRevision: 1,
    tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: { type: "object", properties: { text: { type: "string" } } }, enabled: true, alwaysLoad: tool.alwaysLoad ?? false })) } });
  return { id, toolId: (tool: string) => externalToolId(id, tool) };
}
// Each about 1.5 KB, so twenty pass the threshold together.
const long = (subject: string) => `${subject}. ${"Detailed usage notes for this operation. ".repeat(36)}`;
const many = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `tool_${index}`, description: long(index === 7 ? "Create calendar events for a team" : `Operation number ${index}`) }));

test("a few extension tools are all sent in full, with no search tool", async () => {
  const small = await connection("Small", [{ name: "echo", description: "Echo a value." }, { name: "ping", description: "Ping the service." }]);
  const tools = await createChatToolSet();
  assert.ok(tools[small.toolId("echo")] && tools[small.toolId("ping")]);
  assert.equal(tools[FIND_TOOLS_ID], undefined);
  assert.equal(toolLoadingOf(tools), null);
  assert.equal(activeToolIds(tools, []), null);
});

test("past the size, extension tools are listed by name and a line each, and the ones set to always load are sent in full", async () => {
  const big = await connection("Workspace", [...many(20), { name: "status", description: long("Report the workspace status"), alwaysLoad: true }]);
  const tools = await createChatToolSet();
  const loading = toolLoadingOf(tools)!;
  assert.ok(loading, `twenty tools of about 1.5 KB pass ${DEFERRAL_THRESHOLD_TOKENS} tokens`);
  assert.equal(loading.deferred.size, 20);
  const description = String(tools[FIND_TOOLS_ID].description);
  assert.match(description, new RegExp(`${big.toolId("tool_7")}: Workspace · tool_7 — Create calendar events for a team\\.`));
  assert.ok(!description.includes("Detailed usage notes"), "only the first sentence is listed");
  const active = activeToolIds(tools, [])!;
  assert.ok(active.includes(FIND_TOOLS_ID) && active.includes("createTask"), "built-in tools stay");
  assert.ok(active.includes(big.toolId("status")), "an always-load tool is sent");
  assert.ok(!active.includes(big.toolId("tool_0")));
  // Every tool stays defined, so a loaded or approved call still runs with its approval and binding.
  assert.ok(tools[big.toolId("tool_0")]?.needsApproval);
});

test("searching loads the matching tools, by words or by exact name, and only those are offered from the next step", async () => {
  const big = await connection("Workspace", many(20));
  const tools = await createChatToolSet();
  const find = (input: unknown) => tools[FIND_TOOLS_ID].execute!(input, { toolCallId: "find", messages: [] });
  const byWords = await find({ query: "calendar events" }) as { loaded: string[]; tools: Array<{ name: string }> };
  assert.deepEqual(byWords.loaded, [big.toolId("tool_7")]);
  const byName = await find({ names: [big.toolId("tool_3"), "nothing-like-this"] }) as { loaded: string[]; notFound?: string[] };
  assert.deepEqual(byName.loaded, [big.toolId("tool_3")]);
  assert.deepEqual(byName.notFound, ["nothing-like-this"]);
  const history: ModelMessage[] = [{ role: "tool", content: [{ type: "tool-result", toolCallId: "find", toolName: FIND_TOOLS_ID, output: { type: "json", value: byWords } }] }];
  const active = activeToolIds(tools, history)!;
  assert.ok(active.includes(big.toolId("tool_7")));
  assert.ok(!active.includes(big.toolId("tool_3")), "a search result not in the conversation loads nothing");
});

test("in a conversation, the model sees the list first and the loaded tool in full from its next step", async t => {
  const big = await connection("Workspace", many(20));
  const calls: Array<{ tools: string[] }> = [];
  const steps = [{ tool: { name: FIND_TOOLS_ID, input: { names: [big.toolId("tool_7")] } } }, { text: "Ready to create the event." }];
  t.mock.method(languageModel, "doStream", async (options: { tools?: Array<{ name: string }> }) => {
    const step = steps[calls.length] ?? { text: "Done." };
    calls.push({ tools: (options.tools ?? []).map(tool => tool.name) });
    return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      if ("tool" in step && step.tool) controller.enqueue({ type: "tool-call", toolCallId: `call-${calls.length}`, toolName: step.tool.name, input: JSON.stringify(step.tool.input) });
      else { controller.enqueue({ type: "text-start", id: "a" }); controller.enqueue({ type: "text-delta", id: "a", delta: (step as { text: string }).text }); controller.enqueue({ type: "text-end", id: "a" }); }
      controller.enqueue({ type: "finish", finishReason: { unified: "tool" in step ? "tool-calls" : "stop", raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } } });
      controller.close();
    } }) };
  });
  const chat = await createChat({ title: "Deferred tools" });
  const message: UIMessage = { id: "user-1", role: "user", parts: [{ type: "text", text: "Put the review on the team calendar." }] };
  const response = await chatRoute.POST(new NextRequest("http://localhost/api/chat", { method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify({ chatId: chat.id, messages: [message] }) }));
  assert.equal(response.status, 200);
  await wireText(response);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].tools.includes(FIND_TOOLS_ID));
  assert.ok(!calls[0].tools.some(name => externalToolIdPattern.test(name)), "no extension tool is sent in full at first");
  assert.ok(calls[1].tools.includes(big.toolId("tool_7")), "the loaded tool is sent from the next step");
  assert.equal(calls[1].tools.filter(name => externalToolIdPattern.test(name)).length, 1);
});

test("always load is saved without a new revision, survives a fresh detection, and is refused for an unknown tool", async t => {
  const service = await startExtensionService(); t.after(() => service.close());
  const row = await saveExtension({ name: "Fixture", config: { type: "mcp-http", url: `${service.origin}/mcp` } });
  const tested = await testExtension(row.id, row.revision);
  const enabled = await activateExtension(row.id, { revision: tested.revision, enabled: true, tools: tested.tools.map(tool => tool.name) });
  const name = enabled.tools[0].name;
  const saved = await setExtensionToolLoading(row.id, { revision: enabled.revision, alwaysLoad: [name] });
  assert.equal(saved.revision, enabled.revision, "approvals bound to the revision stay valid");
  assert.equal(saved.tools[0].alwaysLoad, true);
  assert.equal((await testExtension(row.id, saved.revision)).tools[0].alwaysLoad, true);
  await assert.rejects(setExtensionToolLoading(row.id, { revision: saved.revision, alwaysLoad: ["missing"] }));
  await assert.rejects(setExtensionToolLoading(row.id, { revision: saved.revision + 5, alwaysLoad: [] }), /刷新|refresh/i);
  const response = await loadingRoute.PUT(new NextRequest(`http://localhost/api/extensions/${row.id}/loading`, { method: "PUT", headers: { cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify({ revision: saved.revision, alwaysLoad: [] }) }), { params: Promise.resolve({ id: row.id }) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).data.tools[0].alwaysLoad, false);
});

test("many small tools are deferred by their number, not only their size", async () => {
  const tiny = await connection("Tiny", Array.from({ length: 40 }, (_, index) => ({ name: `op_${index}`, description: `Operation ${index}.` })));
  const tools = await createChatToolSet();
  const loading = toolLoadingOf(tools)!;
  assert.ok(loading, `${DEFERRAL_COUNT + 8} tools pass ${DEFERRAL_COUNT}, though they are small`);
  assert.equal(loading.deferred.size, 40);
  assert.ok(!activeToolIds(tools, [])!.includes(tiny.toolId("op_0")));
});

test("a long list names each tool only, and a name from it or words for what it does still load it", async () => {
  const wide = await connection("Wide", Array.from({ length: 200 }, (_, index) => ({ name: `op_${index}`, description: index === 150 ? "Book a meeting room for a team." : `Operation number ${index}.` })));
  const tools = await createChatToolSet();
  const description = String(tools[FIND_TOOLS_ID].description);
  assert.match(description, /^- Wide · op_150$/m);
  assert.ok(!description.includes(wide.toolId("op_150")) && !description.includes("Operation number"), "no ids or summaries in a long list");
  assert.ok(Buffer.byteLength(description) < 8 * 1024, "two hundred names cost every request little");
  const find = (input: unknown) => tools[FIND_TOOLS_ID].execute!(input, { toolCallId: "find", messages: [] }) as Promise<{ loaded: string[] }>;
  assert.deepEqual((await find({ names: ["Wide · op_150"] })).loaded, [wide.toolId("op_150")]);
  assert.deepEqual((await find({ query: "meeting room" })).loaded, [wide.toolId("op_150")]);
});

test("far more tools than before can be enabled, while always-loaded ones stay within what every request carries", async () => {
  const names = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => `${prefix}_${index}`);
  const add = async (name: string, count: number) => {
    const id = randomUUID();
    await db.extension.create({ data: { id, name, kind: "mcp-http", config: { type: "mcp-http", url: "http://127.0.0.1:9/mcp" }, enabled: false, revision: 1, testedRevision: 1,
      tools: names(count, name).map(tool => ({ name: tool, description: `${tool}.`, inputSchema: { type: "object" }, enabled: false, alwaysLoad: false })) } });
    return id;
  };
  const first = await add("first", 150), second = await add("second", 106);
  const enabled = await activateExtension(first, { revision: 1, enabled: true, tools: names(150, "first"), alwaysLoad: names(EXTENSION_LIMITS.alwaysLoadTools, "first") });
  assert.equal(enabled.tools.filter(tool => tool.enabled).length, 150);
  await assert.rejects(activateExtension(second, { revision: 1, enabled: true, tools: names(106, "second"), alwaysLoad: ["second_0"] }), /始终加载|Always load/, "one more always-loaded tool than every request carries");
  const both = await activateExtension(second, { revision: 1, enabled: true, tools: names(106, "second") });
  assert.equal(both.tools.filter(tool => tool.enabled).length, 106, `${EXTENSION_LIMITS.enabledTools} enabled in all`);
  await assert.rejects(setExtensionToolLoading(second, { revision: both.revision, alwaysLoad: ["second_0"] }), /始终加载|Always load/);
  const third = await add("third", 1);
  await assert.rejects(activateExtension(third, { revision: 1, enabled: true, tools: ["third_0"] }), new RegExp(String(EXTENSION_LIMITS.enabledTools)), "past the total");
});

test("the size that defers follows the model's context window, up to the bound that keeps each request's cost down", async () => {
  assert.equal(deferralThreshold(null), DEFERRAL_THRESHOLD_TOKENS, "a window not known gets the bound");
  assert.equal(deferralThreshold(1_000_000), DEFERRAL_THRESHOLD_TOKENS, "a large window does not send more with every request");
  assert.equal(deferralThreshold(32_768), 3_276, "a small one defers at a tenth of it");
  // Eight tools of a few hundred tokens: sent in full to a model of an ordinary window, deferred for a small one.
  const few = await connection("Few", Array.from({ length: 8 }, (_, index) => ({ name: `op_${index}`, description: `${"Operation details. ".repeat(60)}${index}` })));
  assert.equal(toolLoadingOf(await createChatToolSet({ modelRef: CHAT_MODEL_REF })), null);
  const settings = await seedTestModelPreferences(db);
  settings.contextLimits = { [`${CHAT_MODEL_REF.providerId}:${CHAT_MODEL_REF.modelId}`]: { contextLength: 16_384, maxOutputTokens: null } };
  await db.workspacePreference.update({ where: { id: "local" }, data: { settings } });
  const small = toolLoadingOf(await createChatToolSet({ modelRef: CHAT_MODEL_REF }));
  assert.ok(small?.deferred.has(few.toolId("op_0")), "past a tenth of a 16K window");
});
