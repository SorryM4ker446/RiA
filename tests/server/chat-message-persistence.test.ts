import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type { UIMessage } from "ai";
import { createTestDatabase } from "../helpers/database";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { saveChatMessage, claimToolApproval } = await import("@/lib/chat/store");
const { encodePersistedAssistantToolMessage, decodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

beforeEach(async () => { await db.chat.deleteMany({}); await db.mediaAsset.deleteMany({}); });
after(async () => { await db.$disconnect(); cleanup(); });

test("large terminal results and the next pending approval persist intact and each approval is claimed once", async () => {
  const chat = await db.chat.create({ data: { title: "Long scripts" } });
  const command = "# 长脚本🙂\n".repeat(720_000) + "Write-Output 'complete-script'";
  const input = { command };
  const initial = encodePersistedAssistantToolMessage({ type: "assistant-tool-message", text: "", tools: [
    { toolName: "runTerminalCommand", toolCallId: "first", state: "approval-requested", input, approval: { id: "first-approval" } },
  ] });
  const pending = await saveChatMessage({ chatId: chat.id, role: "assistant", content: initial, clientMessageId: "answer", updateExisting: true });
  const approve = (call: string): UIMessage => ({ id: "answer", role: "assistant", parts: [
    { type: "tool-runTerminalCommand", toolCallId: call, state: "approval-responded", input, approval: { id: `${call}-approval`, approved: true } },
  ] });
  await claimToolApproval(chat.id, approve("first"));
  const continued = encodePersistedAssistantToolMessage({ type: "assistant-tool-message", text: "First command completed", tools: [
    { toolName: "runTerminalCommand", toolCallId: "first", state: "output-available", input, output: { command, status: "exited", stdout: "complete-script" } },
    { toolName: "runTerminalCommand", toolCallId: "second", state: "approval-requested", input, approval: { id: "second-approval" } },
  ] });
  assert.ok(Buffer.byteLength(continued) > 32 * 1024 * 1024);
  const saved = await saveChatMessage({ chatId: chat.id, role: "assistant", content: continued, clientMessageId: "answer", updateExisting: true });
  assert.equal(saved.id, pending.id);
  assert.equal(digest(saved.content), digest(continued));
  await db.$disconnect();
  const restored = await db.message.findUniqueOrThrow({ where: { id: saved.id } });
  assert.equal(digest(restored.content), digest(continued));
  const payload = decodePersistedAssistantToolMessage(restored.content)!;
  assert.deepEqual(payload.tools.map(tool => [tool.toolCallId, tool.state]), [["first", "output-available"], ["second", "approval-requested"]]);
  assert.equal(digest((payload.tools[1].input as typeof input).command), digest(command));
  await claimToolApproval(chat.id, approve("second"));
  await assert.rejects(claimToolApproval(chat.id, approve("second")), { code: "CONFLICT" });
  assert.equal(await db.message.count({ where: { chatId: chat.id } }), 1);
  assert.equal((await db.chat.findUniqueOrThrow({ where: { id: chat.id } })).historyRevision, 2);
});

test("a failed answer replacement rolls back content, media retention and summary invalidation and can be retried", async () => {
  const chat = await db.chat.create({ data: { title: "Atomic replacement", summary: "Existing summary", summaryRevision: 0, summaryUpToMessageId: "answer", summaryModelId: "test-model" } });
  const asset = await db.mediaAsset.create({ data: { id: randomUUID(), relativePath: "fixture/image.png", mediaType: "image/png", byteSize: 1, kind: "attachment", lastUsedAt: new Date(0) } });
  const original = await db.message.create({ data: { chatId: chat.id, clientMessageId: "answer", role: "assistant", content: "Original answer", media: { create: { assetId: asset.id } } } });
  await db.$executeRawUnsafe("CREATE TRIGGER reject_chat_update BEFORE UPDATE ON chats BEGIN SELECT RAISE(ABORT, 'Synthetic commit refusal'); END");
  try {
    await assert.rejects(saveChatMessage({ chatId: chat.id, role: "assistant", content: "Replacement answer", clientMessageId: "answer", updateExisting: true }));
  } finally { await db.$executeRawUnsafe("DROP TRIGGER reject_chat_update"); }
  assert.equal((await db.message.findUniqueOrThrow({ where: { id: original.id } })).content, "Original answer");
  assert.equal(await db.messageMedia.count({ where: { messageId: original.id, assetId: asset.id } }), 1);
  assert.equal((await db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })).lastUsedAt.getTime(), 0);
  const unchanged = await db.chat.findUniqueOrThrow({ where: { id: chat.id } });
  assert.equal(unchanged.summary, "Existing summary"); assert.equal(unchanged.historyRevision, 0);
  const retried = await saveChatMessage({ chatId: chat.id, role: "assistant", content: "Replacement answer", clientMessageId: "answer", updateExisting: true });
  assert.equal(retried.id, original.id); assert.equal(retried.content, "Replacement answer");
  assert.equal(await db.messageMedia.count({ where: { messageId: original.id } }), 0);
  assert.ok((await db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })).lastUsedAt.getTime() > 0);
  const updated = await db.chat.findUniqueOrThrow({ where: { id: chat.id } });
  assert.equal(updated.historyRevision, 1);
  for (const field of ["summary", "summaryRevision", "summaryModelId", "summaryUpToMessageId"]) assert.equal(updated[field], null);
});

test("concurrent replacements keep one message identity and invalidate each accepted history revision", async () => {
  const chat = await db.chat.create({ data: { title: "Concurrent replacement" } });
  const results = await Promise.allSettled(["First", "Second"].map(content => saveChatMessage({ chatId: chat.id, role: "assistant", content, clientMessageId: "answer", updateExisting: true })));
  for (const result of results) if (result.status === "rejected") throw result.reason;
  const messages = await db.message.findMany({ where: { chatId: chat.id } });
  assert.equal(messages.length, 1);
  assert.ok(["First", "Second"].includes(messages[0].content));
  assert.equal((await db.chat.findUniqueOrThrow({ where: { id: chat.id } })).historyRevision, 2);
});

test("replacement writes without a client identity create distinct messages", async () => {
  const chat = await db.chat.create({ data: { title: "Unkeyed messages" } });
  const first = await saveChatMessage({ chatId: chat.id, role: "assistant", content: "First", updateExisting: true });
  const second = await saveChatMessage({ chatId: chat.id, role: "assistant", content: "Second", updateExisting: true });
  assert.notEqual(first.id, second.id);
  assert.equal(await db.message.count({ where: { chatId: chat.id } }), 2);
});

test("replacement upserts preserve message identity and creation time while binding text as data", async () => {
  const chat = await db.chat.create({ data: { id: "chat'; --", title: "Bound values" } });
  const clientMessageId = "answer'); DELETE FROM chats; --";
  const first = await saveChatMessage({ chatId: chat.id, clientMessageId, role: "assistant", content: "Initial", updateExisting: true });
  assert.ok(first.createdAt instanceof Date);
  const content = "Write-Output '你好🙂'; -- not database instructions\n' OR 1=1; DROP TABLE messages; --";
  const replaced = await saveChatMessage({ chatId: chat.id, clientMessageId, role: "user", content, status: "error", updateExisting: true });
  assert.equal(replaced.id, first.id);
  assert.equal(replaced.createdAt.getTime(), first.createdAt.getTime());
  assert.equal(replaced.role, "assistant");
  assert.equal(replaced.chatId, chat.id);
  assert.equal(replaced.clientMessageId, clientMessageId);
  assert.equal(replaced.content, content);
  assert.equal(replaced.status, "error");
  assert.equal(await db.message.count(), 1);
  assert.equal(await db.chat.count(), 1);
});

test("a failed initial replacement rolls back the inserted message and history revision", async () => {
  const chat = await db.chat.create({ data: { title: "Initial rollback" } });
  await db.$executeRawUnsafe("CREATE TRIGGER reject_first_answer BEFORE UPDATE ON chats BEGIN SELECT RAISE(ABORT, 'Synthetic commit refusal'); END");
  try {
    await assert.rejects(saveChatMessage({ chatId: chat.id, clientMessageId: "answer", role: "assistant", content: "Must roll back", updateExisting: true }));
  } finally { await db.$executeRawUnsafe("DROP TRIGGER reject_first_answer"); }
  assert.equal(await db.message.count({ where: { chatId: chat.id } }), 0);
  assert.equal((await db.chat.findUniqueOrThrow({ where: { id: chat.id } })).historyRevision, 0);
  const saved = await saveChatMessage({ chatId: chat.id, clientMessageId: "answer", role: "assistant", content: "Retry", updateExisting: true });
  assert.equal(saved.content, "Retry");
  assert.equal(await db.message.count({ where: { chatId: chat.id } }), 1);
});
