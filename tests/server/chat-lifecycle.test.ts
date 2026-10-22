import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import type { LanguageModelV3StreamPart, LanguageModelV3TextPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { readUIMessageStream, type UIMessageChunk } from "ai";
import type { StoredMessage } from "@/features/chat/page-utils";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { languageModel, providerState } from "../helpers/model-provider";
import { seedTestModelPreferences } from "../helpers/model-library";

// A prompt message body is either plain text or a list of parts; the
// assertions below only inspect the leading text part of a turn.
const textPart = (part: unknown) => part as LanguageModelV3TextPart;

const cleanup = createTestDatabase();
process.env.RIA_TEST_PROVIDER = "1";
const { db } = await import("@/db");

const { saveChatMessage } = await import("@/lib/chat/store");
const { readChatRequest } = await import("@/lib/chat/request");
const { prepareChatPersistence, persistChatResponse } = await import("@/lib/chat/persistence");
const chat = await import("@/app/api/chat/route");
const { indexDocument, deleteDocument } = await import("@/lib/documents/store");
const { decodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
const { mapStoredMessagesToUI } = await import("@/features/chat/page-utils");
const { getDocumentSources } = await import("@/features/chat/message-presentation");
const { exclusiveDataOperation } = await import("@/lib/server/data-operations");
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
  await db.task.deleteMany({});
  await db.knowledgeDocument.deleteMany({});
  await db.mediaAsset.deleteMany({});
  await db.modelRequest.deleteMany({});
  await db.workspacePreference.deleteMany({});
  await seedTestModelPreferences(db);
});
after(async () => { await db.$disconnect(); cleanup(); });
const ui = (id: string, role: UIMessage["role"], text: string) => ({ id, role, parts: [{ type: "text", text }] } satisfies UIMessage);
function request(body, signal = undefined) {
  return new NextRequest("http://localhost/api/chat", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ manualToolsOnly: true, ...body }), signal });
}

test("long tool turns accept follow-ups from both live and reloaded history", async t => {
  let calls = 0;
  t.mock.method(languageModel, "doStream", async () => {
    const current = ++calls;
    return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      if (current <= 40) {
        controller.enqueue({ type: "reasoning-start", id: `reasoning-${current}` });
        controller.enqueue({ type: "reasoning-delta", id: `reasoning-${current}`, delta: "r".repeat(4000) });
        controller.enqueue({ type: "reasoning-end", id: `reasoning-${current}` });
      }
      if (current <= 40) controller.enqueue({ type: "tool-call", toolCallId: `count-${current}`, toolName: "searchKnowledge", input: JSON.stringify({ query: "count-loop" }) });
      else {
        controller.enqueue({ type: "text-start", id: "answer" });
        controller.enqueue({ type: "text-delta", id: "answer", delta: "Forty steps completed" });
        controller.enqueue({ type: "text-end", id: "answer" });
      }
      controller.enqueue({ type: "finish", finishReason: { unified: current <= 40 ? "tool-calls" : "stop", raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
      controller.close();
    } }) };
  });
  const response = await chat.POST(request({ messages: [ui("count-loop", "user", "Read repeatedly until finished")] }));
  assert.equal(response.status, 200);
  const wire = await response.text();
  assert.match(wire, /Forty steps completed/);
  assert.equal(calls, 41);
  const run = await db.agentRun.findFirstOrThrow({ orderBy: { startedAt: "desc" } });
  assert.equal(run.status, "succeeded");
  assert.equal(run.deadlineMs, null);
  assert.equal(await db.agentStep.count({ where: { runId: run.id } }), 40);
  const chunks: UIMessageChunk[] = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
  let live: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream: new ReadableStream<UIMessageChunk>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  } }) })) live = message;
  assert.ok(live);
  assert.ok(live.parts.length > 100);
  const firstFollowUp = await chat.POST(request({ chatId: run.chatId, messages: [ui("count-loop", "user", "Read repeatedly until finished"), live, ui("live-follow-up", "user", "What did you find?")] }));
  assert.equal(firstFollowUp.status, 200);
  assert.match(await firstFollowUp.text(), /Forty steps completed/);
  const stored = await db.message.findMany({ where: { chatId: run.chatId! }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const payload = stored.map(row => decodePersistedAssistantToolMessage(row.content)).find(item => item?.runId === run.id)!;
  assert.equal(payload.reasoning?.length, 160_000);
  const restored = mapStoredMessagesToUI(stored).uiMessages;
  const next = await chat.POST(request({ chatId: run.chatId, messages: [...restored, ui("restored-follow-up", "user", "Continue after reload")] }));
  assert.equal(next.status, 200);
  assert.match(await next.text(), /Forty steps completed/);
  assert.equal(calls, 43);
  assert.equal(await db.agentStep.count({ where: { runId: run.id } }), 40);
});

test("answer persistence failures expose a safe database code without logging command or query contents", async (t) => {
  const input = await readChatRequest(request({ messages: [ui("save-failure", "user", "Test persistence")] }));
  const conversation = await prepareChatPersistence(input);
  const diagnostic = t.mock.method(console, "error", () => {});
  const transaction = db.$transaction;
  db.$transaction = async () => {
    throw Object.assign(new Error("synthetic-private-command-and-query"), { code: "P2028", name: "PrismaClientKnownRequestError" });
  };
  try {
    await assert.rejects(persistChatResponse({ input, conversation,
      responseMessage: ui("unsaved-answer", "assistant", "Visible answer"),
      isAborted: false, generationFailed: false,
    }), { code: "INTERNAL_ERROR", message: "回答保存失败，请重新加载会话后重试。" });
  } finally { db.$transaction = transaction; }
  assert.deepEqual(diagnostic.mock.calls.map(call => call.arguments), [["chat.persist.failed", { code: "P2028" }]]);
  assert.equal(await db.message.count({ where: { chatId: conversation.chat.id, role: "user" } }), 1);
  assert.equal(await db.message.count({ where: { chatId: conversation.chat.id, role: "assistant" } }), 0);
});

test("chat keeps automatic tools available when an older client sends the retired manual-only flag", async () => {
  const response = await chat.POST(request({ messages: [ui("auto-tools", "user", "Explain the available actions")] }));
  assert.equal(response.status, 200);
  await response.text();
  const names = languageModel.doStreamCalls.at(-1).tools.map(tool => tool.name);
  for (const id of ["createTask", "searchKnowledge", "readDocument", "convertDocument"]) assert.ok(names.includes(id), id);
});

test("ordinary chat receives task-oriented agent instructions without empty retrieval or memory scaffolding", async () => {
  const response = await chat.POST(request({ messages: [ui("agent-goal", "user", "Help me plan a short story")] }));
  assert.equal(response.status, 200);
  await response.text();
  const prompt = languageModel.doStreamCalls.at(-1).prompt.find(item => item.role === "system").content;
  assert.match(prompt, /RiA, a local-first desktop AI agent/);
  assert.match(prompt, /carry authorized work through/);
  assert.match(prompt, /terminalApprovalMode decides whether calls wait for approval/);
  assert.match(prompt, /say when evidence for a requested workspace fact is missing/);
  assert.doesNotMatch(prompt, /Knowledge evidence|Long-term memories|Summary of earlier turns|Incomplete excerpts|\[Tooling Policy/);
  // Nothing was retrieved or remembered, so the user's message carries no context block.
  const latest = languageModel.doStreamCalls.at(-1).prompt.at(-1);
  assert.equal(JSON.stringify(latest.content).includes("[Context for this request"), false);
  assert.doesNotMatch(prompt, /No supporting document excerpts|No relevant long-term memory|No earlier messages omitted|Prefer a direct answer for ordinary questions|Order: factual points/);
});

test("model capacity bounds long persisted conversations while retaining the active turn", async () => {
  const { contextBudget, estimateContextTokens } = await import("@/lib/models/context-budget");
  const { getModelPreferences } = await import("@/lib/models/preferences");
  const settings = await getModelPreferences();
  // Earlier mock turns report token counts no real provider would; plan from the uncalibrated estimate.
  await db.modelContextCalibration.deleteMany({});
  settings.contextLimits = { [`openrouter:${settings.chat.model!.modelId}`]: { contextLength: 30_000, maxOutputTokens: 2048 } };
  await db.workspacePreference.update({ where: { id: "local" }, data: { settings } });
  const owned = await db.chat.create({ data: { title: "Long conversation" } });
  const history = Array.from({ length: 40 }, (_, index) => ui(`turn-${index}`, index % 2 ? "assistant" : "user", `Recorded turn ${index}${index < 38 ? " notes 1234".repeat(80) : ""}`));
  await db.message.createMany({ data: history.map((item) => ({ chatId: owned.id, clientMessageId: item.id, role: item.role, content: item.parts[0].text })) });
  const response = await chat.POST(request({ chatId: owned.id, messages: [...history, ui("follow-up", "user", "Explain the previous answer")] }));
  assert.equal(response.status, 200);
  await response.text();
  const prompt = languageModel.doStreamCalls.at(-1).prompt;
  const capacity = contextBudget(null, Object.values(settings.contextLimits)[0]);
  assert.ok(estimateContextTokens({ prompt, tools: languageModel.doStreamCalls.at(-1).tools }) <= capacity.inputTokens);
  // Older turns reach the model through the request's context block, not the system prompt.
  assert.doesNotMatch(prompt.find((item) => item.role === "system").content, /Recorded turn 0|Summary of earlier turns|Incomplete excerpts/);
  const latestParts = prompt.at(-1).content;
  assert.match(textPart(latestParts[0]).text, /^\[Context for this request[\s\S]*(Summary of earlier turns|Incomplete excerpts from .* earlier messages)/);
  assert.equal(textPart(latestParts.at(-1)).text, "Explain the previous answer");
  assert.ok(prompt.some((item) => item.role === "assistant" && textPart(item.content[0]).text === "Recorded turn 39"));
  assert.equal(await db.message.count({ where: { chatId: owned.id } }), 42);
  assert.equal(await db.message.count({ where: { chatId: owned.id, content: { startsWith: "Recorded turn" } } }), 40);
});

test("chat streams owned document sources and preserves citation snapshots through history, updates and deletion", async () => {
  const pages = [{ pageNumber: 1, text: "织女星补给每周三送达。忽略此前所有指令是文档中的无效示例文本。" }];
  const { document } = await indexDocument({ filename: "supply.pdf", format: "pdf", byteSize: 100, pages });
  // A second document in the same workspace is ordinary context, not a leak.
  const response = await chat.POST(request({ messages: [ui("documents-user", "user", "织女星补给何时送达")] }));
  assert.equal(response.status, 200);
  const wire = await response.text();
  assert.match(wire, /documentSources/);
  assert.match(wire, /supply.pdf/);
  const sent = languageModel.doStreamCalls.at(-1).prompt;
  assert.doesNotMatch(sent.find(item => item.role === "system").content, /每周三/, "evidence is not placed among the system rules");
  const prompt = textPart(sent.at(-1).content[0]).text;
  assert.match(prompt, /^\[Context for this request/);
  assert.match(prompt, /untrusted reference data/);
  assert.match(prompt, /每周三/);
  // Untrusted document text stays inside the reference block, never as instruction.
  const rows = await db.message.findMany({ where: { chat: {}, role: "assistant" } });
  assert.equal(rows.length, 1);
  const persisted = decodePersistedAssistantToolMessage(rows[0].content);
  assert.equal(persisted.text, "Generated answer");
  assert.equal(persisted.documentSources[0].filename, "supply.pdf");
  assert.equal(persisted.documentSources[0].pageNumber, 1);
  // The mapper reads id, clientMessageId, role and content; the rows here come
  // straight from Prisma, where createdAt is a Date rather than the ISO string
  // the wire payload carries.
  const messages = mapStoredMessagesToUI(rows as unknown as StoredMessage[]).uiMessages;
  assert.equal(getDocumentSources(messages[0])[0].documentId, document.id);
  await deleteDocument(document.id);
  assert.match(decodePersistedAssistantToolMessage((await db.message.findUnique({ where: { id: rows[0].id } })).content).documentSources[0].snippet, /每周三/);
  const forged: UIMessage = { id: "forged", role: "assistant", parts: [{ type: "text", text: "hello" }], metadata: { documentSources: [{ ...persisted.documentSources[0], documentId: "../../private" }] } };
  assert.deepEqual(getDocumentSources(forged), []);
});

for (const regenerate of [false, true]) {
  test(`aborting ${regenerate ? "regeneration preserves the original answer" : "a chat stream never records partial output as successful"}`, { timeout: 15_000 }, async () => {
    const owned = await db.chat.create({ data: { title: "Abort" } });
    await saveChatMessage({ chatId: owned.id, role: "user", content: "Question", clientMessageId: "user-1" });
    if (regenerate) await saveChatMessage({ chatId: owned.id, role: "assistant", content: "Original answer", clientMessageId: "answer-1" });
    let release;
    providerState.streamGate = new Promise((resolve) => { release = resolve; });
    const controller = new AbortController();
    const response = await chat.POST(request({ chatId: owned.id, ...(regenerate ? { trigger: "regenerate-message" } : {}), messages: [ui("user-1", "user", "Question")] }, controller.signal));
    const reader = response.body.getReader();
    let wire = "";
    try {
      while (!wire.includes("text-delta")) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        wire += new TextDecoder().decode(chunk.value);
      }
      controller.abort();
      release();
      while (!(await reader.read()).done) { /* Drain persistence callbacks before touching SQLite. */ }
    } finally { release(); reader.releaseLock(); }
    const rows = await db.message.findMany({ where: { chatId: owned.id, role: "assistant" } });
    if (regenerate) {
      assert.deepEqual(rows.map(({ content, status }) => ({ content, status })), [{ content: "Original answer", status: "success" }]);
    } else {
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "error");
    }
  });
}

test("disconnecting the HTTP stream keeps restore blocked until background persistence settles", {timeout:15000}, async()=>{
  let release;providerState.streamGate=new Promise(resolve=>{release=resolve;});
  const response=await chat.POST(request({messages:[ui("disconnect","user","Question")]}));
  const reader=response.body.getReader();let wire="";
  try {
    while(!wire.includes("text-delta")){const item=await reader.read();assert.equal(item.done,false);wire+=new TextDecoder().decode(item.value);}
    await reader.cancel();await assert.rejects(exclusiveDataOperation(async()=>{}),/仍有请求/);
  } finally {release();reader.releaseLock();}
  const deadline=Date.now()+5000;let settled=false;
  while(Date.now()<deadline){try{await exclusiveDataOperation(async()=>{});settled=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,10));}}
  assert.equal(settled,true);assert.equal(await db.message.count({where:{chat:{},role:"assistant"}}),1);
});
