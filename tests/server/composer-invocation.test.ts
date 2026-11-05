import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { CHAT_MODEL_REF, seedTestModelPreferences } from "../helpers/model-library";
import { languageModel, resetProviderState } from "../helpers/model-provider";
import { wireText } from "../helpers/wire-text";

const cleanup = createTestDatabase();
process.env.RIA_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const chatRoute = await import("@/app/api/chat/route");
const runRoute = await import("@/app/api/tools/run/route");
const catalogRoute = await import("@/app/api/tools/route");
const { createChat } = await import("@/lib/chat/store");
const { resolveInvocation } = await import("@/lib/chat/invocation");
const { saveAssistant } = await import("@/lib/assistants/store");
const { assistantConfigSchema } = await import("@/lib/assistants/schema");
const { decodePersistedAssistantToolMessage, decodePersistedUserMessage } = await import("@/lib/ai/ui-message");
const { listToolDescriptors, listPublicToolCatalog } = await import("@/tools/catalog");
const { templateAllowsTool } = await import("@/tools/template-access");
const { slashQuery, filterSlashItems } = await import("@/features/chat/slash-menu");

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {});
  resetProviderState(); globalThis.__riaRateLimitStore?.clear();
  process.env.APP_RUNTIME = "test"; process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  await db.chat.deleteMany({}); await db.task.deleteMany({}); await db.pluginPackage.deleteMany({});
  await seedTestModelPreferences(db);
});
after(async () => { await db.$disconnect(); cleanup(); });

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const post = (body: unknown) => chatRoute.POST(new NextRequest("http://localhost/api/chat", { method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify(body) }));
const user = (id: string, text: string, invocation?: unknown): UIMessage => ({ id, role: "user", ...(invocation ? { metadata: { invocation } } : {}), parts: [{ type: "text", text }] });
type Step = { tool?: { name: string; input: unknown }; text?: string };
function script(t: TestContext, steps: Step[]) {
  const calls: { tools: string[]; prompt: string }[] = [];
  t.mock.method(languageModel, "doStream", async options => {
    const step = steps[calls.length] ?? { text: "Done." };
    calls.push({ tools: (options.tools ?? []).map(tool => tool.name), prompt: JSON.stringify(options.prompt) });
    return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      if (step.tool) controller.enqueue({ type: "tool-call", toolCallId: `call-${calls.length}`, toolName: step.tool.name, input: JSON.stringify(step.tool.input) });
      else { controller.enqueue({ type: "text-start", id: "a" }); controller.enqueue({ type: "text-delta", id: "a", delta: step.text ?? "Done." }); controller.enqueue({ type: "text-end", id: "a" }); }
      controller.enqueue({ type: "finish", finishReason: { unified: step.tool ? "tool-calls" : "stop", raw: undefined }, usage });
      controller.close();
    } }) };
  });
  return calls;
}
const searchChoice = { tool: { id: "searchKnowledge", label: "知识检索" } };

test("the chosen tool is the only one offered at first, then every tool returns, and the choice is saved with the message", async t => {
  const calls = script(t, [{ tool: { name: "searchKnowledge", input: { query: "周报" } } }, { text: "Found it." }]);
  const chat = await createChat({ title: "Chosen tool" });
  const response = await post({ chatId: chat.id, messages: [user("chosen-user", "查一下周报", searchChoice)] });
  assert.equal(response.status, 200);
  await wireText(response);
  assert.deepEqual(calls[0].tools, ["searchKnowledge"]);
  assert.ok(calls[1].tools.length > 1 && calls[1].tools.includes("createTask"));
  assert.match(calls[0].prompt, /The user chose the tool searchKnowledge/);
  const saved = await db.message.findFirstOrThrow({ where: { chatId: chat.id, role: "user" } });
  assert.deepEqual(decodePersistedUserMessage(saved.content)?.invocation, searchChoice);
  const answer = await db.message.findFirstOrThrow({ where: { chatId: chat.id, role: "assistant" } });
  assert.equal(decodePersistedAssistantToolMessage(answer.content)?.skippedTool, undefined);
});

test("an answer that skipped the chosen tool says so instead of implying it ran", async t => {
  const calls = script(t, [{ text: "From memory." }]);
  const chat = await createChat({ title: "Skipped tool" });
  await wireText(await post({ chatId: chat.id, messages: [user("skip-user", "查一下周报", searchChoice)] }));
  assert.equal(calls.length, 1);
  const answer = await db.message.findFirstOrThrow({ where: { chatId: chat.id, role: "assistant" } });
  assert.equal(decodePersistedAssistantToolMessage(answer.content)?.skippedTool, "searchKnowledge");
});

test("a message with no choice offers every tool from the start", async t => {
  const calls = script(t, [{ text: "Hello." }]);
  const chat = await createChat({ title: "No choice" });
  await wireText(await post({ chatId: chat.id, messages: [user("plain-user", "你好")] }));
  assert.ok(calls[0].tools.length > 1);
  assert.doesNotMatch(calls[0].prompt, /Chosen by the user/);
});

test("a choice that cannot be honoured refuses the message before any model call", async t => {
  const calls = script(t, []);
  const chat = await createChat({ title: "Refused" });
  for (const [invocation, status] of [
    [{ tool: { id: "runTerminalCommand", label: "终端" } }, 400],
    [{ tool: { id: "noSuchTool", label: "没有" } }, 400],
    [{ skills: [{ packageId: "missing", skillId: "gone", label: "已卸载" }] }, 404],
  ] as const) {
    const response = await post({ chatId: chat.id, messages: [user(`refused-${status}-${JSON.stringify(invocation).length}`, "试试", invocation)] });
    assert.equal(response.status, status, JSON.stringify(invocation));
  }
  assert.equal(await db.message.count({ where: { chatId: chat.id } }), 0, "a refused message goes back to the composer and is not also saved");
  const template = await saveAssistant(assistantConfigSchema.parse({ name: "No search", instructions: "Help", tools: ["createTask"] }));
  const limited = await createChat({ title: "Template", assistantTemplateId: template.id });
  assert.equal((await post({ chatId: limited.id, messages: [user("refused-template", "查一下", searchChoice)] })).status, 400);
  assert.equal(calls.length, 0);
  const ephemeral = await db.chat.create({ data: { title: "No memory", ephemeral: true } });
  assert.equal((await post({ chatId: ephemeral.id, messages: [user("refused-memory", "记住这个", { tool: { id: "saveMemory", label: "记住信息" } })] })).status, 400, "memory is off here");
  // Search needs a provider key that this environment has taken away.
  process.env.OPENROUTER_API_KEY = "";
  await assert.rejects(resolveInvocation({ tool: { id: "webSearch", label: "联网搜索" } }, { modelSupportsTools: true, modelRef: CHAT_MODEL_REF }), { code: "CONFIGURATION_ERROR" });
  await assert.rejects(resolveInvocation(searchChoice, { modelSupportsTools: false }), { code: "VALIDATION_ERROR" });
});

test("any number of chosen skills travel with the message, and do not narrow the tools", async t => {
  const calls = script(t, [{ text: "Used them." }]);
  const skill = (id: string, name: string) => ({ id, name, description: "A skill", instructions: `Instructions of ${name}.` });
  await db.pluginPackage.create({ data: { id: "writing-pack-row", packageId: "writing-pack", digest: "a".repeat(64), enabled: true, manifest: { format: "ria-plugin", schemaVersion: 1, id: "writing-pack", name: "Writing", version: "1.0.0", description: "Pack", author: "Test", skills: [skill("tone", "Tone"), skill("outline", "Outline")], connections: [] } } });
  const catalog = await catalogRoute.GET(new NextRequest("http://localhost/api/tools?mode=chat", { headers: { cookie: localAccessCookie() } }));
  assert.deepEqual((await catalog.json()).skills.map((item: { skillId: string }) => item.skillId), ["tone", "outline"]);
  const chat = await createChat({ title: "Skills" });
  const response = await post({ chatId: chat.id, messages: [user("skills-user", "写一段", { skills: [{ packageId: "writing-pack", skillId: "tone", label: "Tone" }, { packageId: "writing-pack", skillId: "outline", label: "Outline" }] })] });
  assert.equal(response.status, 200, await response.clone().text());
  await wireText(response);
  assert.match(calls[0].prompt, /Instructions of Tone\./);
  assert.match(calls[0].prompt, /Instructions of Outline\./);
  assert.ok(calls[0].tools.length > 1);
});

test("the direct route converts a library document, and refuses what a conversation should do", async () => {
  const { indexDocument } = await import("@/lib/documents/store");
  const { document } = await indexDocument({ filename: "周报.md", format: "md", byteSize: 20, pages: [{ pageNumber: null, text: "# 周报\n\n内容" }] });
  const run = (body: unknown) => runRoute.POST(new NextRequest("http://localhost/api/tools/run", { method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify(body) }));
  const converted = await run({ tool: "convertDocument", input: { documentId: document.id, format: "docx" } });
  assert.equal(converted.status, 200);
  const output = (await converted.json()).data;
  assert.equal(output.filename, "周报.docx");
  assert.match(output.downloadUrl, new RegExp(`^/api/documents/${document.id}/export\\?format=docx&version=`));
  assert.equal((await run({ tool: "convertDocument", input: { format: "docx" } })).status, 400, "a source is required");
  assert.equal((await run({ tool: "convertDocument", input: { documentId: document.id, attachmentId: document.id, format: "docx" } })).status, 400, "only one source");
  assert.equal((await run({ tool: "searchKnowledge", input: { query: "周报" } })).status, 400);
});

test("a document attachment converts and downloads without a model", async () => {
  const { createMediaAsset } = await import("@/lib/media/storage");
  const { DOCUMENT_ATTACHMENT_TYPES } = await import("@/lib/media/limits");
  const { exportDocument, loadAttachmentDocument } = await import("@/lib/document-processor/service");
  const { documentDownload } = await import("@/lib/document-processor/schema");
  const exportRoute = await import("@/app/api/media/[id]/export/route");
  const { bytes } = await exportDocument({ filename: "方案.docx", content: "# 方案\n\n第一步", syntax: "markdown", format: "docx" });
  const asset = await createMediaAsset({ bytes, mediaType: DOCUMENT_ATTACHMENT_TYPES[1], kind: "attachment", description: "方案.docx" });
  assert.equal((await loadAttachmentDocument(asset.id)).filename, "方案.docx");
  const run = await runRoute.POST(new NextRequest("http://localhost/api/tools/run", { method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify({ tool: "convertDocument", input: { attachmentId: asset.id, format: "md" } }) }));
  assert.equal(run.status, 200, await run.clone().text());
  const output = (await run.json()).data;
  assert.equal(output.filename, "方案.md");
  assert.ok(documentDownload(output), "the download card accepts an attachment's copy");
  const download = await exportRoute.GET(new NextRequest(`http://localhost${output.downloadUrl}`, { headers: { cookie: localAccessCookie() } }), { params: Promise.resolve({ id: asset.id }) });
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition") ?? "", /\.md/);
  const missing = await exportRoute.GET(new NextRequest(`http://localhost/api/media/${asset.id}/export?format=pdf`, { headers: { cookie: localAccessCookie() } }), { params: Promise.resolve({ id: asset.id }) });
  assert.equal(missing.status, 400);
});

test("every tool states who can reach it, and the lists follow from that", async () => {
  for (const tool of listToolDescriptors()) assert.ok(tool.surface && tool.surface.category, tool.id);
  const user = listToolDescriptors("chat").filter(tool => tool.surface.user).map(tool => tool.id).sort();
  assert.deepEqual(user, ["compactContext", "convertDocument", "createTask", "readDocument", "saveMemory", "searchKnowledge", "webSearch"]);
  const catalog = await listPublicToolCatalog("chat");
  assert.ok(catalog.some(tool => tool.id === "readPluginSkill"), "tools only the model uses are listed too");
  const calling = catalog.find(tool => tool.id === "toolCalling")!;
  assert.equal(calling.surface.user, null);
  assert.equal(calling.available, true, "a chat model in the library can call tools");
  const settings = await db.workspacePreference.findUniqueOrThrow({ where: { id: "local" } });
  const library = (settings.settings as { library: { supportsTools: boolean }[] }).library;
  await db.workspacePreference.update({ where: { id: "local" }, data: { settings: { ...(settings.settings as object), chat: { model: null, fallback: null } } } });
  assert.equal((await listPublicToolCatalog("chat")).find(tool => tool.id === "toolCalling")!.available, true, "it does not depend on a default being set");
  await db.workspacePreference.update({ where: { id: "local" }, data: { settings: { ...(settings.settings as object), chat: { model: null, fallback: null }, library: library.map(model => ({ ...model, supportsTools: false })) } } });
  assert.equal((await listPublicToolCatalog("chat")).find(tool => tool.id === "toolCalling")!.available, false, "no chat model can call tools");
  assert.equal(templateAllowsTool(["runTerminalCommand"], "editProjectFile"), true);
  assert.equal(templateAllowsTool(["createTask"], "editProjectFile"), false);
  assert.equal(templateAllowsTool([], "compactContext"), true);
  assert.equal(templateAllowsTool([], "webSearch"), false);
});

test("a slash opens the menu only where a word could start", () => {
  assert.deepEqual(slashQuery("/", 1), { query: "", start: 0 });
  assert.deepEqual(slashQuery("/搜", 2), { query: "搜", start: 0 });
  assert.deepEqual(slashQuery("写一段 /to", 7), { query: "to", start: 4 });
  for (const text of ["a/b", "2026/11", "D:/work", "https://x", "//"]) assert.equal(slashQuery(text, text.length), null, text);
  assert.equal(slashQuery("/搜 索", 4), null, "a space ends the word");
  assert.deepEqual(slashQuery("/搜 索", 2), { query: "搜", start: 0 }, "the caret decides, not the end of the text");
  const item = (label: string, description = "") => ({ key: label, group: "tools" as const, label, description, icon: () => null, run: () => {} });
  assert.deepEqual(filterSlashItems([item("转换文档", "把文件变成 Word"), item("Word 助手"), item("其他")], "word").map(row => row.label), ["Word 助手", "转换文档"]);
});
