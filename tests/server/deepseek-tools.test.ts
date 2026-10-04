import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import type { UIMessage } from "ai";
import type { CreateTaskOutput } from "@/tools/definitions/create-task";
import type { SearchKnowledgeOutput } from "@/tools/definitions/search-knowledge";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";

const cleanup = createTestDatabase();
delete process.env.PRIVATE_AI_TEST_PROVIDER;
const { db } = await import("@/db");
const chatRoute = await import("@/app/api/chat/route");
const manualRoute = await import("@/app/api/tools/run/route");
const { defaultModelPreferences } = await import("@/lib/models/preferences-schema");
const { mapStoredMessagesToUI } = await import("@/features/chat/page-utils");
const { indexDocument } = await import("@/lib/documents/store");
const ref = { providerId: "deepseek" as const, modelId: "deepseek-v4-pro" };
let selectedTool = "createTask";
let selectedInput: Record<string, unknown> = { title: "真实创建任务" };

const server = createServer(async (req, res) => {
  const bytes: Buffer[] = [];
  for await (const chunk of req) bytes.push(chunk);
  const body = JSON.parse(Buffer.concat(bytes).toString("utf8"));
  const base = { id: "fixture-completion", model: ref.modelId };
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...base, choices: [{ message: { role: "assistant", content: "知识检索已完成" }, finish_reason: "stop" }] }));
    return;
  }
  const done = body.messages.some(message => message.role === "tool");
  const chunks = done ? [
    { ...base, choices: [{ index: 0, delta: { content: "操作已完成" }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ] : [
    { ...base, choices: [{ index: 0, delta: { reasoning_content: "需要调用工具" } }] },
    { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_fixture", function: { name: selectedTool, arguments: JSON.stringify(selectedInput).slice(0, 8) } }] } }] },
    { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(selectedInput).slice(8) } }] } }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
});

before(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.DEEPSEEK_API_KEY = "offline-test-key";
});
beforeEach(async (t: TestContext) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  globalThis.__privateAiRateLimitStore?.clear();
  await db.chat.deleteMany({});
  await db.task.deleteMany({});
  await db.memory.deleteMany({});
  await db.knowledgeDocument.deleteMany({});
  const settings = defaultModelPreferences();
  settings.chat.model = ref;
  settings.library = [{ ...ref, name: "DeepSeek fixture", description: "", modes: ["chat"], supportsImageInput: false, endpointImageInput: null, supportsTools: true, contextLength: null, pricing: {}, addedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() }];
  await db.workspacePreference.upsert({ where: { id: "local" }, create: { id: "local", settings }, update: { settings } });
  selectedTool = "createTask";
  selectedInput = { title: "真实创建任务" };
});
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await db.$disconnect(); cleanup(); });

function request(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, { method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function stored(chatId: string) {
  return mapStoredMessagesToUI(await db.message.findMany({ where: { chatId }, orderBy: { createdAt: "asc" } })).uiMessages;
}
function findTool<Output = unknown>(message: UIMessage, name: string) {
  const part = message.parts.find(part => part.type === `tool-${name}`);
  assert.ok(part, `missing ${name} tool part`);
  return part as typeof part & { state: string; approval: { id: string; approved?: boolean }; output: Output };
}
async function pendingTask() {
  const conversation = await db.chat.create({ data: { title: "Task approval" } });
  const response = await chatRoute.POST(request("/api/chat", { chatId: conversation.id, model: ref, messages: [{ id: "user-fixture", role: "user", parts: [{ type: "text", text: "帮我创建任务" }] }] }));
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.match(stream, /tool-approval-request/);
  const start = stream.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(chunk => chunk.type === "start");
  assert.ok(start?.messageId);
  const saved = await db.message.findFirstOrThrow({ where: { chatId: conversation.id, role: "assistant" } });
  assert.equal(saved.clientMessageId, start.messageId);
  const messages = await stored(conversation.id);
  const toolPart = findTool(messages.at(-1)!, "createTask");
  assert.equal(toolPart.state, "approval-requested");
  assert.equal(await db.task.count(), 0);
  return { conversation, messages, toolPart };
}

test("a streamed DeepSeek task reaches approval, executes once after approval and persists its output", async () => {
  const { conversation, messages, toolPart } = await pendingTask();
  toolPart.state = "approval-responded";
  toolPart.approval.approved = true;
  const body = { chatId: conversation.id, model: ref, messages };
  const resumed = await chatRoute.POST(request("/api/chat", body));
  assert.equal(resumed.status, 200);
  assert.match(await resumed.text(), /真实创建任务/);
  assert.equal(await db.task.count(), 1);
  assert.equal((await db.task.findFirstOrThrow()).title, "真实创建任务");
  const saved = (await stored(conversation.id)).at(-1)!;
  const completed = findTool<CreateTaskOutput>(saved, "createTask");
  assert.equal(completed.state, "output-available");
  assert.ok(completed.output.taskId);
  const duplicate = await chatRoute.POST(request("/api/chat", body));
  assert.equal(duplicate.status, 409);
  assert.equal(await db.task.count(), 1);
});

test("rejecting the streamed task leaves no task and persists denial", async () => {
  const { conversation, messages, toolPart } = await pendingTask();
  toolPart.state = "approval-responded";
  toolPart.approval.approved = false;
  const resumed = await chatRoute.POST(request("/api/chat", { chatId: conversation.id, model: ref, messages }));
  assert.equal(resumed.status, 200);
  await resumed.text();
  assert.equal(await db.task.count(), 0);
  assert.equal(findTool((await stored(conversation.id)).at(-1)!, "createTask").state, "output-denied");
});

test("automatic and manual knowledge search respect conversation collections and ephemeral memory", async () => {
  const a = await indexDocument({ filename: "发布A.txt", collection: "A|B", format: "txt", byteSize: 20, pages: [{ pageNumber: null, text: "发布回滚窗口为三十分钟。" }] });
  await indexDocument({ filename: "发布B.txt", collection: "B", format: "txt", byteSize: 20, pages: [{ pageNumber: null, text: "发布回滚窗口为六十分钟。" }] });
  await db.memory.create({ data: { key: "发布回滚窗口", value: "不得进入无记忆会话", confirmed: true } });
  const { encodeDocumentScope } = await import("@/lib/documents/scope");
  const conversation = await db.chat.create({ data: { title: "Scoped search", documentScope: encodeDocumentScope(["A|B"]), ephemeral: true } });
  selectedTool = "searchKnowledge";
  selectedInput = { query: "发布回滚窗口", topK: 4 };
  const response = await chatRoute.POST(request("/api/chat", { chatId: conversation.id, model: ref, messages: [{ id: "query-user", role: "user", parts: [{ type: "text", text: "检索发布回滚窗口" }] }] }));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /tool-output-available/);
  const tool = findTool<SearchKnowledgeOutput>((await stored(conversation.id)).at(-1)!, "searchKnowledge");
  assert.equal(tool.state, "output-available");
  assert.equal(tool.output.results.length, 1);
  assert.equal(tool.output.results[0].reference!.documentId, a.document.id);
  const manual = await manualRoute.POST(request("/api/tools/run", { chatId: conversation.id, model: ref, tool: "searchKnowledge", mode: "chat", input: selectedInput }));
  assert.equal(manual.status, 200);
  assert.equal((await manual.json()).data.results.length, 1);
  assert.equal(await db.memory.count(), 1);
  const missing = await manualRoute.POST(request("/api/tools/run", { chatId: "missing-chat", model: ref, tool: "searchKnowledge", mode: "chat", input: selectedInput }));
  assert.equal(missing.status, 404);
});
