import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { seedTestModelPreferences } from "../helpers/model-library";
import { languageModel } from "../helpers/model-provider";
const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const route = await import("@/app/api/conversations/[id]/messages/[messageId]/route");
const { summarizeOlderTurns } = await import("@/lib/chat/summary");
const { getRegenerationSnapshot, saveRegeneratedResponse, saveChatMessage } = await import("@/lib/chat/store");
beforeEach(async () => { await db.chat.deleteMany({}); await seedTestModelPreferences(db); });
after(async () => { await db.$disconnect(); cleanup(); });
async function history() {
  const chat = await db.chat.create({ data: { title: "History", summary: "Earlier accepted decision", summaryUpToMessageId: "covered-19", summaryModelId: "openrouter:test", summaryRevision: 0 } });
  const messages = Array.from({ length: 44 }, (_, index) => ({ id: `covered-${index}`, role: index % 2 ? "assistant" as const : "user" as const, text: `stored decision ${index}` }));
  await db.message.createMany({ data: messages.map((message, index) => ({ id: message.id, chatId: chat.id, role: message.role, content: message.text, createdAt: new Date(index * 1000) })) });
  return { chat, messages };
}
async function mutate(chatId: string, method: "PATCH" | "DELETE", body?: unknown) {
  return route[method](new NextRequest(`http://localhost/api/conversations/${chatId}/messages/covered-0`, { method, headers: { cookie: localAccessCookie(), "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), { params: Promise.resolve({ id: chatId, messageId: "covered-0" }) });
}
test("editing or deleting stored history clears compression atomically and subsequent summaries use stored text", async () => {
  const { chat, messages } = await history();
  assert.equal((await mutate(chat.id, "PATCH", { content: "Corrected decision" })).status, 200);
  let row = await db.chat.findUniqueOrThrow({ where: { id: chat.id } });
  assert.equal(row.summary, null); assert.equal(row.summaryRevision, null); assert.equal(row.historyRevision, 1);
  const result = await summarizeOlderTurns({ chatId: chat.id, messages, keepRecent: 24 });
  assert.ok(result); assert.match(result.summary, /Corrected decision/); assert.doesNotMatch(result.summary, /stored decision 0/);
  assert.equal((await mutate(chat.id, "DELETE")).status, 200);
  row = await db.chat.findUniqueOrThrow({ where: { id: chat.id } }); assert.equal(row.summary, null); assert.equal(row.historyRevision, 2);
  assert.equal(await summarizeOlderTurns({ chatId: chat.id, messages, keepRecent: 24 }), null);
});
test("a slow summary cannot restore stale compression after a concurrent edit", async t => {
  const { chat, messages } = await history();
  await db.chat.update({ where: { id: chat.id }, data: { summary: null } });
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const original = languageModel.doGenerate.bind(languageModel);
  t.mock.method(languageModel, "doGenerate", async options => { entered(); await wait; return original(options); });
  const pending = summarizeOlderTurns({ chatId: chat.id, messages, keepRecent: 24 });
  await ready;
  try { assert.equal((await mutate(chat.id, "PATCH", { content: "Newer decision" })).status, 200); } finally { release(); }
  assert.equal(await pending, null);
  assert.equal((await db.chat.findUniqueOrThrow({ where: { id: chat.id } })).summary, null);
});
test("regeneration and assistant message replacement invalidate existing compression", async () => {
  const { chat } = await history();
  const snapshot = await getRegenerationSnapshot(chat.id, "covered-20");
  await saveRegeneratedResponse({ snapshot, userMessageId: "covered-20", content: "Replacement answer", clientMessageId: "new-answer" });
  let row = await db.chat.findUniqueOrThrow({ where: { id: chat.id } }); assert.equal(row.summary, null); assert.equal(row.historyRevision, 1);
  await db.chat.update({ where: { id: chat.id }, data: { summary: "Another cached summary", summaryRevision: 1 } });
  await saveChatMessage({ chatId: chat.id, role: "assistant", content: "Updated persisted answer", clientMessageId: "new-answer", updateExisting: true });
  row = await db.chat.findUniqueOrThrow({ where: { id: chat.id } }); assert.equal(row.summary, null); assert.equal(row.historyRevision, 2);
});


test("summary transcripts retain readable evidence without replaying approval metadata, reasoning or attachment bytes", async () => {
  const { chat, messages } = await history();
  await db.chat.update({ where: { id: chat.id }, data: { summary: null } });
  const { encodePersistedUserMessage, encodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
  await db.message.update({ where: { id: "covered-0" }, data: { content: encodePersistedUserMessage({ type: "user-message", text: "Readable decision", files: [{ url: "data:image/png;base64,BINARY_FIXTURE_ONLY", mediaType: "image/png", filename: "diagram.png" }] }) } });
  await db.message.update({ where: { id: "covered-1" }, data: { content: encodePersistedAssistantToolMessage({ type: "assistant-tool-message", text: "Stored result", reasoning: "PRIVATE_REASONING_FIXTURE", tools: [{ toolName: "createTask", toolCallId: "call", state: "output-available", output: { title: "Original task" }, approval: { id: "APPROVAL_FIXTURE_ONLY", approved: true } }] }) } });
  const result = await summarizeOlderTurns({ chatId: chat.id, messages, keepRecent: 24 });
  assert.ok(result); assert.match(result.summary, /Readable decision/); assert.match(result.summary, /Original task/);
  assert.doesNotMatch(result.summary, /APPROVAL_FIXTURE_ONLY|PRIVATE_REASONING_FIXTURE|BINARY_FIXTURE_ONLY/);
});


test("a valid earlier summary survives when pagination omits its original covered messages", async () => {
  const { chat } = await history();
  const later = Array.from({ length: 20 }, (_, offset) => { const index = offset + 44; return { id: `covered-${index}`, role: index % 2 ? "assistant" as const : "user" as const, text: `later decision ${index}` }; });
  await db.message.createMany({ data: later.map((message, offset) => ({ id: message.id, chatId: chat.id, role: message.role, content: message.text, createdAt: new Date((offset + 44) * 1000) })) });
  const rows = await db.message.findMany({ where: { chatId: chat.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const messages = rows.slice(-44).map(row => ({ id: row.id, role: row.role, text: row.content }));
  const result = await summarizeOlderTurns({ chatId: chat.id, messages, keepRecent: 24 });
  assert.ok(result); assert.match(result.summary, /Earlier accepted decision/); assert.match(result.summary, /stored decision 20/);
  assert.equal(result.upToMessageId, "covered-39");
});
