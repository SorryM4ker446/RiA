import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { seedTestModelPreferences } from "../helpers/model-library";
import { languageModel, resetProviderState } from "../helpers/model-provider";

const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const { saveAssistant, listAssistants } = await import("@/lib/assistants/store");
const { assistantConfigSchema, readAssistantSnapshot } = await import("@/lib/assistants/schema");
const { createChat } = await import("@/lib/chat/store");
const { updateConversation } = await import("@/lib/conversations/mutations");
const { createChatToolSet } = await import("@/tools/catalog");
const { indexDocument } = await import("@/lib/documents/store");
const { decodeDocumentScope } = await import("@/lib/documents/scope");
const { decodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
const { createAccountBackup, readBackupManifest } = await import("@/lib/backups/archive");
const { openBackup } = await import("@/lib/backups/files");
const { restoreAccountBackup } = await import("@/lib/backups/restore");
const { exclusiveDataOperation } = await import("@/lib/server/data-operations");
const routes = { root: await import("@/app/api/assistants/route"), item: await import("@/app/api/assistants/[id]/route"), chat: await import("@/app/api/chat/route"), tool: await import("@/app/api/tools/run/route") };
let cookie: string;
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (path: string, method = "GET", body?: unknown, auth = cookie, headers = {}) => new NextRequest(`http://localhost${path}`, { method, headers: { cookie: auth, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const config = (extra = {}) => assistantConfigSchema.parse({ name: "财务助理", instructions: "Only apply documented financial rules. Preserve exceptions.", tools: [], collections: ["财务"], usesMemory: false, ...extra });
beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {}); t.mock.method(console, "warn", () => {});
  globalThis.__privateAiRateLimitStore?.clear(); cookie = localAccessCookie(); resetProviderState();
  await db.chat.deleteMany({}); await db.assistantTemplate.deleteMany({}); await db.memory.deleteMany({}); await db.knowledgeDocument.deleteMany({}); await db.workspacePreference.deleteMany({});
  await seedTestModelPreferences(db); process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
});
after(async () => { await db.$disconnect(); cleanup(); });

test("built-ins are read-only and custom template updates reject stale revisions", async () => {
  const all = await listAssistants(); assert.equal(all.length, 4); assert.ok(all.every(item => item.builtin));
  assert.equal((await routes.item.PATCH(request("/api/assistants/builtin_writing", "PATCH", { revision: 1, config: config() }), context("builtin_writing"))).status, 400);
  const saved = await saveAssistant(config());
  const updated = await saveAssistant(config({ name: "新版财务助理" }), saved.id, 1);
  assert.equal(updated.revision, 2);
  await assert.rejects(saveAssistant(config(), saved.id, 1), /模板已被/);
  assert.equal((await routes.item.DELETE(request(`/api/assistants/${saved.id}?confirm=true&revision=1`, "DELETE"), context(saved.id))).status, 409);
  assert.equal(await db.assistantTemplate.count(), 1);
});

test("template APIs enforce local access, input bounds, supported tools and confirmation", async () => {
  assert.equal((await routes.root.GET(request("/api/assistants", "GET", undefined, ""))).status, 401);
  assert.equal((await routes.root.POST(request("/api/assistants", "POST", config(), cookie, { origin: "https://invalid.example" }))).status, 403);
  for (const value of [{ ...config(), tools: ["unknownTool"] }, { ...config(), tools: ["searchKnowledge", "searchKnowledge"] }, { ...config(), retrieval: { semanticThreshold: 0.01 } }]) {
    assert.equal((await routes.root.POST(request("/api/assistants", "POST", value))).status, 400);
  }
  const saved = await saveAssistant(config());
  assert.equal((await routes.item.DELETE(request(`/api/assistants/${saved.id}`, "DELETE", { revision: 1 }), context(saved.id))).status, 400);
  assert.equal(await db.assistantTemplate.count(), 1);
});

test("applying a template stores an immutable snapshot and atomically applies scope and memory policy", async () => {
  const saved = await saveAssistant(config());
  const chat = await createChat({ title: "财务", assistantTemplateId: saved.id });
  assert.equal(chat.ephemeral, true); assert.deepEqual(decodeDocumentScope(chat.documentScope), ["财务"]);
  await saveAssistant(config({ instructions: "New instructions", collections: ["医疗"], usesMemory: true }), saved.id, 1);
  assert.equal(readAssistantSnapshot((await db.chat.findUniqueOrThrow({ where: { id: chat.id } })).assistantConfig)?.templateRevision, 1);
  const updated = await updateConversation(chat.id, { assistantTemplateId: saved.id });
  assert.equal(updated.assistantConfig?.templateRevision, 2); assert.equal(updated.ephemeral, false); assert.deepEqual(decodeDocumentScope(updated.documentScope), ["医疗"]);
  await db.assistantTemplate.delete({ where: { id: saved.id } });
  assert.equal(readAssistantSnapshot((await db.chat.findUniqueOrThrow({ where: { id: chat.id } })).assistantConfig)?.instructions, "New instructions");
  const removed = await updateConversation(chat.id, { assistantTemplateId: null });
  assert.equal(removed.assistantConfig, null); assert.deepEqual(decodeDocumentScope(removed.documentScope), ["医疗"]);
});

test("an idempotent conversation creation preserves its applied snapshot", async () => {
  const chat = await createChat({ chatId: "fixed-chat", assistantTemplateId: "builtin_writing" });
  const repeated = await createChat({ chatId: chat.id, assistantTemplateId: "builtin_research" });
  assert.deepEqual(repeated.assistantConfig, chat.assistantConfig);
});

test("empty tool restrictions disable tools and manual execution cannot bypass the conversation policy", async () => {
  assert.deepEqual(await createChatToolSet({ toolIds: [] }), {});
  const allowed = await createChatToolSet({ toolIds: ["searchKnowledge"] }); assert.deepEqual(Object.keys(allowed), ["searchKnowledge"]);
  const chat = await createChat({ assistantTemplateId: "builtin_writing" });
  const response = await routes.tool.POST(request("/api/tools/run", "POST", { tool: "createTask", input: { title: "Must not write" }, mode: "chat", chatId: chat.id }));
  assert.equal(response.status, 400); assert.equal(await db.task.count({ where: { title: "Must not write" } }), 0);
});

test("chat uses template instructions, scoped evidence and bounded policy without memory or forbidden tools", async () => {
  const saved = await saveAssistant(config({ retrieval: { maxSources: 1, contextChars: 1200, semanticThreshold: 0.6 } }));
  const chat = await createChat({ assistantTemplateId: saved.id });
  for (const collection of ["财务", "医疗"]) await indexDocument({ filename: `${collection}.txt`, collection, format: "txt", byteSize: 100, pages: [{ pageNumber: null, text: collection === "财务" ? "费用核销时限为十个工作日。" : "费用核销的医疗机密不应读取。" }] });
  await db.memory.create({ data: { key: "费用核销", value: "私有记忆不应读取", confirmed: true } });
  const response = await routes.chat.POST(request("/api/chat", "POST", { chatId: chat.id, messages: [{ id: "user-turn", role: "user", parts: [{ type: "text", text: "费用核销时限" }] }] }));
  assert.equal(response.status, 200, await response.clone().text());
  const stream = await response.text(); assert.match(stream, /documentDiagnostics/);
  const call = languageModel.doStreamCalls.at(-1)!;
  const prompt = JSON.stringify(call.prompt); assert.match(prompt, /Only apply documented financial rules/); assert.match(prompt, /十个工作日/); assert.doesNotMatch(prompt, /医疗机密|私有记忆/); assert.ok(!call.tools?.length);
  const message = await db.message.findFirstOrThrow({ where: { chatId: chat.id, role: "assistant" } });
  const persisted = decodePersistedAssistantToolMessage(message.content)!;
  assert.equal(persisted.documentDiagnostics?.policy.semanticThreshold, 0.6); assert.equal(persisted.documentSources?.length, 1);
});

test("bound models reject client overrides and removed models cannot be used by templates", async () => {
  const prefs = await db.workspacePreference.findUniqueOrThrow({ where: { id: "local" } });
  const model = (prefs.settings as { chat: { model: { providerId: string; modelId: string } } }).chat.model;
  const saved = await saveAssistant(config({ model })); const chat = await createChat({ assistantTemplateId: saved.id });
  const response = await routes.chat.POST(request("/api/chat", "POST", { chatId: chat.id, model: { providerId: "deepseek", modelId: "deepseek-chat" }, messages: [{ id: "override", role: "user", parts: [{ type: "text", text: "Hello" }] }] }));
  assert.equal(response.status, 400); assert.equal(await db.message.count({ where: { chatId: chat.id } }), 0);
  await db.workspacePreference.deleteMany({});
  await assert.rejects(updateConversation(chat.id, { assistantTemplateId: saved.id }), /模板绑定的模型已移除/);
});

test("permitted manual knowledge calls use the conversation's collections and template evidence budget", async () => {
  const saved = await saveAssistant(config({ tools: ["searchKnowledge"], retrieval: { maxSources: 1, contextChars: 1200, semanticThreshold: 0.8 } }));
  const chat = await createChat({ assistantTemplateId: saved.id });
  for (const collection of ["财务", "医疗"]) await indexDocument({ filename: `${collection}.txt`, collection, format: "txt", byteSize: 100, pages: [{ pageNumber: null, text: `费用核销 ${collection} 规则，应当保留票据。` }] });
  const response = await routes.tool.POST(request("/api/tools/run", "POST", { tool: "searchKnowledge", input: { query: "费用核销", topK: 8 }, mode: "chat", chatId: chat.id }));
  assert.equal(response.status, 200, await response.clone().text());
  const output = (await response.json()).data;
  assert.equal(output.results.length, 1); assert.equal(output.results[0].reference.collection, "财务");
  assert.equal(output.diagnostics.policy.semanticThreshold, 0.8); assert.equal(output.diagnostics.policy.maxSources, 1);
  assert.equal(await db.memory.count(), 0);
});

test("backup restore preserves templates and deleted-template snapshots and remaps custom template identities", async () => {
  const saved = await saveAssistant(config());
  const chat = await createChat({ title: "备份快照", assistantTemplateId: saved.id });
  const deleted = await saveAssistant(config({ name: "已删除模板" }));
  await createChat({ title: "独立快照", assistantTemplateId: deleted.id }); await db.assistantTemplate.delete({ where: { id: deleted.id } });
  await createChat({ chatId: "builtin_writing", title: "内置快照", assistantTemplateId: "builtin_writing" });
  const backup = await createAccountBackup(); const archive = await openBackup(backup.id);
  try { const { manifest } = await readBackupManifest(archive); assert.equal(manifest.assistantTemplates.length, 1); assert.equal(manifest.chats.length, 3); } finally { await archive.close(); }
  await exclusiveDataOperation(() => restoreAccountBackup(backup.id));
  const template = await db.assistantTemplate.findFirstOrThrow(); assert.notEqual(template.id, saved.id);
  const restored = await db.chat.findFirstOrThrow({ where: { title: chat.title } });
  assert.equal(readAssistantSnapshot(restored.assistantConfig)?.templateId, template.id);
  assert.equal(readAssistantSnapshot((await db.chat.findFirstOrThrow({ where: { title: "独立快照" } })).assistantConfig)?.name, "已删除模板");
  assert.equal(readAssistantSnapshot((await db.chat.findFirstOrThrow({ where: { title: "内置快照" } })).assistantConfig)?.templateId, "builtin_writing");
});
