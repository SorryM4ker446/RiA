import assert from "node:assert/strict";
import { test } from "node:test";
import { convertToModelMessages } from "ai";
import { buildChatContext, isToolApprovalContinuation } from "@/lib/chat/context";
import { encodePersistedAssistantToolMessage } from "@/lib/ai/ui-message";
import { mapStoredMessagesToUI } from "@/features/chat/page-utils";

const message = (id, role, text) => ({ id, role, parts: [{ type: "text", text }] });
const approval = { type: "tool-createTask", toolCallId: "call-1", state: "approval-responded", input: { title: "Buy milk" }, approval: { id: "approval-1", approved: true } };

test("normal follow-up retains the previous assistant answer", async () => {
  const messages = [message("u1", "user", "Give me two options"), message("a1", "assistant", "A: SQLite; B: PostgreSQL"), message("u2", "user", "Explain option B")];
  const context = buildChatContext(messages);
  assert.deepEqual(context.messages, messages);
  const model = await convertToModelMessages(context.messages);
  assert.equal(model[1].role, "assistant");
  assert.equal(model[1].content[0].text, "A: SQLite; B: PostgreSQL");
});

test("historical tool facts survive without replaying old approvals", async () => {
  const messages = [message("u1", "user", "create task"), { id: "a1", role: "assistant", parts: [approval, { type: "text", text: "Previously requested" }] }, message("u2", "user", "What happened earlier?")];
  assert.equal(isToolApprovalContinuation(messages), false);
  const context = buildChatContext(messages);
  assert.match(context.messages[1].parts[0].text, /Buy milk/);
  const model = await convertToModelMessages(context.messages);
  assert.equal(model.some((item) => item.role === "tool"), false);
});

test("current approval preserves call and decision through model conversion", async () => {
  const messages = [message("u1", "user", "create task"), { id: "a1", role: "assistant", parts: [approval] }];
  assert.equal(isToolApprovalContinuation(messages), true);
  const context = buildChatContext(messages);
  assert.deepEqual(context.messages, messages);
  const model = await convertToModelMessages(context.messages);
  assert.equal(model.at(-1).role, "tool");
  assert.equal(model.at(-1).content[0].approvalId, "approval-1");
  assert.equal(model.at(-1).content[0].approved, true);
});

test("long histories retain the active turn and bounded excerpts without base64", () => {
  const messages = Array.from({ length: 40 }, (_, index) => message(String(index), index % 2 ? "assistant" : "user", `turn ${index} ` + "x".repeat(600)));
  messages[0].parts.push({ type: "file", url: "data:image/png;base64,PRIVATE_IMAGE", mediaType: "image/png" });
  const context = buildChatContext(messages, { maxMessages: 6, maxCharacters: 2000, excerptCharacters: 1000 });
  assert.ok(context.omittedMessages > 0);
  assert.equal(context.messages[0].role, "user");
  assert.deepEqual(context.messages.slice(-2), messages.slice(-2));
  assert.ok(context.historyExcerpt.length < 1150);
  assert.equal(context.historyExcerpt.includes("PRIVATE_IMAGE"), false);
});

test("approval metadata survives storage and reloading", () => {
  const content = encodePersistedAssistantToolMessage({ type: "assistant-tool-message", text: "", tools: [{ toolName: "createTask", toolCallId: approval.toolCallId, state: "approval-requested", input: approval.input, approval: { id: "approval-1" } }] });
  const result = mapStoredMessagesToUI([{ id: "row", clientMessageId: "a1", role: "assistant", content, status: "success", createdAt: new Date().toISOString() }]);
  assert.deepEqual(result.uiMessages[0].parts[0].approval, { id: "approval-1" });
});
