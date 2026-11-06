import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { languageModel, resetProviderState } from "../helpers/model-provider";
import { seedTestModelPreferences } from "../helpers/model-library";

const cleanup = createTestDatabase();
process.env.RIA_TEST_PROVIDER = "1";
const { documentSourceUrl, markDocumentCitations } = await import("@/lib/documents/types");
const { db } = await import("@/db");
const chat = await import("@/app/api/chat/route");
const { indexDocument } = await import("@/lib/documents/store");
const { encodeDocumentScope } = await import("@/lib/documents/scope");
const { saveKnowledgeEntry, getRelevantEntries } = await import("@/lib/knowledge/entries");
const { withRequestContext, buildRequestContext, REQUEST_CONTEXT_HEADER } = await import("@/lib/chat/model-context");
const { installPlugin, setPluginState } = await import("@/lib/plugins/store");
const { parsePlugin } = await import("@/lib/plugins/schema");
const { pluginFixture } = await import("../helpers/plugin-fixture");

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {});
  resetProviderState(); globalThis.__riaRateLimitStore?.clear();
  process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  await db.chat.deleteMany({}); await db.memory.deleteMany({}); await db.knowledgeDocument.deleteMany({});
  await db.pluginPackage.deleteMany({});
  await seedTestModelPreferences(db);
});
after(async () => { await db.$disconnect(); cleanup(); });

const ui = (id: string, role: UIMessage["role"], text: string): UIMessage => ({ id, role, parts: [{ type: "text", text }] });
const request = (body: unknown) => new NextRequest("http://localhost/api/chat", { method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify(body) });
const lastPrompt = () => languageModel.doStreamCalls.at(-1)!.prompt as LanguageModelV3Prompt;
const systemOf = (prompt: LanguageModelV3Prompt) => prompt.filter(message => message.role === "system").map(message => message.content).join("\n");
const textOf = (message: LanguageModelV3Prompt[number] | undefined) => !message ? "" : typeof message.content === "string" ? message.content
  : (message.content as { type: string; text?: string }[]).map(part => part.text ?? "").join("\n");
async function send(body: Record<string, unknown>) {
  const response = await chat.POST(request(body));
  assert.equal(response.status, 200);
  return response.text();
}

test("a search gives the model the url it is told to cite with", async () => {
  await indexDocument({ filename: "citable.md", format: "md", byteSize: 100, pages: [{ pageNumber: 1, text: "织女星补给每周三送达仓库。" }] });
  const { searchKnowledge } = await import("@/tools/definitions/search-knowledge");
  const [hit] = (await searchKnowledge({ query: "织女星补给", topK: 4 })).results;
  assert.equal(hit.url, documentSourceUrl(hit.reference!));
  assert.deepEqual(markDocumentCitations([hit.reference!], `[citable](${hit.url})`).map(source => source.citationStatus), ["cited"]);
});

test("nothing from the knowledge base is added to a request; the model searches for it", async () => {
  await indexDocument({ filename: "supply.md", format: "md", byteSize: 100, pages: [{ pageNumber: 1, text: "织女星补给每周三送达仓库。" }] });
  await saveKnowledgeEntry({ key: "deployment region", value: "Production deploys go to the Frankfurt region." });
  const wire = await send({ messages: [ui("strong", "user", "织女星补给何时送达 deployment region")] });
  const sent = JSON.stringify(lastPrompt());
  assert.doesNotMatch(sent, /每周三/); assert.doesNotMatch(sent, /Frankfurt/);
  assert.doesNotMatch(wire, /documentSources|documentDiagnostics/);
  assert.ok(languageModel.doStreamCalls.at(-1)!.tools?.some(tool => tool.name === "searchKnowledge"));
});

test("the system prompt stays identical across turns while each turn's context changes, keeping earlier turns unchanged", async () => {
  await saveKnowledgeEntry({ key: "deployment region", value: "Production deploys go to the Frankfurt region." });
  await send({ messages: [ui("first", "user", "Which region do production deploys use?")] });
  const first = lastPrompt();
  const history = [ui("first", "user", "Which region do production deploys use?"), ui("first-answer", "assistant", "Generated answer"), ui("second", "user", "Write a haiku about autumn")];
  await send({ messages: history });
  const second = lastPrompt();
  assert.equal(systemOf(second), systemOf(first), "nothing turn-specific lives in the system prompt");
  const earlierUser = second.filter(message => message.role === "user").at(-2);
  assert.equal(textOf(earlierUser), "Which region do production deploys use?", "an earlier turn is sent exactly as before");
});


test("skills are an index when they can be loaded on demand", async () => {
  const plugin = await installPlugin(parsePlugin(pluginFixture()));
  await setPluginState(plugin.id, { revision: plugin.revision, enabled: true });
  await send({ messages: [ui("skills", "user", "Review the acceptance questions")] });
  const system = systemOf(lastPrompt());
  assert.match(system, /Research skill/); assert.match(system, /readPluginSkill/);
  assert.doesNotMatch(system, /PLUGIN_SKILL_EVIDENCE/);
  assert.ok(languageModel.doStreamCalls.at(-1)!.tools?.some(tool => tool.name === "readPluginSkill"));
});

test("the request context is one labelled block ahead of the latest user message", () => {
  assert.equal(buildRequestContext({}), "");
  const block = buildRequestContext({ historyExcerpt: "", memoryDocument: "notes" });
  assert.match(block, /^\[Context for this request[\s\S]*notes[\s\S]*\[End of context; the user's message follows\]$/);
  const messages = [{ role: "user" as const, content: "first" }, { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] }, { role: "user" as const, content: [{ type: "text" as const, text: "second" }] }];
  const result = withRequestContext(messages, block);
  assert.equal(result[0], messages[0]); assert.equal(result[1], messages[1]);
  assert.deepEqual((result[2].content as { text: string }[]).map(part => part.text), [block, "second"]);
  assert.equal(withRequestContext(messages, ""), messages);
});

async function storedConversation(turns: number) {
  const created = await db.chat.create({ data: { title: "Reloaded" } });
  const start = Date.now() - turns * 60_000;
  for (let turn = 0; turn < turns; turn++) {
    const user = turn === 1 ? "The vault passphrase is BLUE-WHALE-42. Keep it in mind." : `Routine question number ${turn}`;
    await db.message.create({ data: { chatId: created.id, clientMessageId: `u${turn}`, role: "user", content: user, createdAt: new Date(start + turn * 60_000) } });
    await db.message.create({ data: { chatId: created.id, clientMessageId: `a${turn}`, role: "assistant", content: `Routine answer number ${turn}`, createdAt: new Date(start + turn * 60_000 + 1) } });
  }
  return created;
}

test("turns the browser has not loaded are read from storage instead of silently dropped", async () => {
  const created = await storedConversation(30);
  // After a reload the browser holds only the latest page of messages.
  const loaded = Array.from({ length: 5 }, (_, index) => 25 + index).flatMap(turn => [ui(`u${turn}`, "user", `Routine question number ${turn}`), ui(`a${turn}`, "assistant", `Routine answer number ${turn}`)]);
  await send({ chatId: created.id, messages: [...loaded, ui("latest", "user", "What is the vault passphrase?")] });
  const prompt = JSON.stringify(lastPrompt());
  assert.match(prompt, /BLUE-WHALE-42/, "an early stored turn reaches the model");
  assert.equal(prompt.match(/Routine answer number 26\b/g)?.length, 1, "a loaded message is not sent twice");
});

test("with a current summary only the turns after it are read from storage", async () => {
  const created = await storedConversation(30);
  const covered = await db.message.findFirstOrThrow({ where: { chatId: created.id, clientMessageId: "a9" } });
  const { historyRevision } = await db.chat.findUniqueOrThrow({ where: { id: created.id } });
  await db.chat.update({ where: { id: created.id }, data: { summary: "SUMMARY-MARKER: the vault passphrase was shared earlier.", summaryUpToMessageId: covered.id, summaryRevision: historyRevision } });
  const loaded = [ui("u29", "user", "Routine question number 29"), ui("a29", "assistant", "Routine answer number 29")];
  await send({ chatId: created.id, messages: [...loaded, ui("latest", "user", "What did we discuss?")] });
  const prompt = JSON.stringify(lastPrompt());
  assert.match(prompt, /SUMMARY-MARKER/, "the summary stands for the turns before its boundary");
  assert.match(prompt, /Routine question number 10\b/, "turns after the boundary are read from storage");
  assert.doesNotMatch(prompt, /BLUE-WHALE-42|Routine question number 5\b/, "turns inside the summary are not resent");
});

test("a model that cannot call tools is told so once, not tool by tool", async () => {
  const { unavailableToolLines } = await import("@/lib/prompts");
  const lines = unavailableToolLines([{ id: "webSearch", reason: "modelUnsupported" }, { id: "searchKnowledge", reason: "modelUnsupported" }, { id: "createTask", reason: "modelUnsupported" }]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /cannot call tools/);
  assert.doesNotMatch(lines[0], /webSearch|searchKnowledge|createTask/);
  assert.match(unavailableToolLines([{ id: "webSearch", reason: "templateDisabled" }])[0], /webSearch/, "a template's choice still names the tool");
});
