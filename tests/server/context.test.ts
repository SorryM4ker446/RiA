import assert from "node:assert/strict";
import { test } from "node:test";
import { convertToModelMessages, type TextPart, type ToolApprovalResponse, type UIMessage } from "ai";
import { buildChatContext, isToolApprovalContinuation } from "@/lib/chat/context";
import { encodePersistedAssistantToolMessage } from "@/lib/ai/ui-message";
import { mapStoredMessagesToUI, type ToolPart } from "@/features/chat/page-utils";

type TextUIPart = Extract<UIMessage["parts"][number], { type: "text" }>;
const message = (id: string, role: UIMessage["role"], text: string): UIMessage => ({ id, role, parts: [{ type: "text", text }] });
const approvalRecord = { type: "tool-createTask", toolCallId: "call-1", state: "approval-responded", input: { title: "Buy milk" }, approval: { id: "approval-1", approved: true } };
const approval = approvalRecord as ToolPart;

test("normal follow-up retains the previous assistant answer", async () => {
  const messages: UIMessage[] = [message("u1", "user", "Give me two options"), message("a1", "assistant", "A: SQLite; B: PostgreSQL"), message("u2", "user", "Explain option B")];
  const context = buildChatContext(messages);
  assert.deepEqual(context.messages, messages);
  const model = await convertToModelMessages(context.messages);
  assert.equal(model[1].role, "assistant");
  assert.equal((model[1].content[0] as TextPart).text, "A: SQLite; B: PostgreSQL");
});

test("historical tool facts survive without replaying old approvals", async () => {
  const messages: UIMessage[] = [message("u1", "user", "create task"), { id: "a1", role: "assistant", parts: [approval, { type: "text", text: "Previously requested" }] }, message("u2", "user", "What happened earlier?")];
  assert.equal(isToolApprovalContinuation(messages), false);
  const context = buildChatContext(messages);
  assert.match((context.messages[1].parts[0] as TextUIPart).text, /Buy milk/);
  const model = await convertToModelMessages(context.messages);
  assert.equal(model.some((item) => item.role === "tool"), false);
});

test("current approval preserves call and decision through model conversion", async () => {
  const messages: UIMessage[] = [message("u1", "user", "create task"), { id: "a1", role: "assistant", parts: [approval] }];
  assert.equal(isToolApprovalContinuation(messages), true);
  const context = buildChatContext(messages);
  assert.deepEqual(context.messages, messages);
  const model = await convertToModelMessages(context.messages);
  assert.equal(model.at(-1).role, "tool");
  const decision = model.at(-1).content[0] as ToolApprovalResponse;
  assert.equal(decision.approvalId, "approval-1");
  assert.equal(decision.approved, true);
});

test("long histories retain the active turn and bounded excerpts without base64", () => {
  const messages: UIMessage[] = Array.from({ length: 40 }, (_, index) => message(String(index), index % 2 ? "assistant" : "user", `turn ${index} ` + "x".repeat(600)));
  messages[0].parts.push({ type: "file", url: "data:image/png;base64,PRIVATE_IMAGE", mediaType: "image/png" });
  const context = buildChatContext(messages, { maxMessages: 6, maxCharacters: 2000, excerptCharacters: 1000 });
  assert.ok(context.omittedMessages > 0);
  assert.equal(context.messages[0].role, "user");
  assert.deepEqual(context.messages.slice(-2), messages.slice(-2));
  assert.ok(context.historyExcerpt.length < 1150);
  assert.equal(context.historyExcerpt.includes("PRIVATE_IMAGE"), false);
});

test("approval metadata survives storage and reloading", () => {
  const content = encodePersistedAssistantToolMessage({ type: "assistant-tool-message", text: "", tools: [{ toolName: "createTask", toolCallId: approvalRecord.toolCallId, state: "approval-requested", input: approvalRecord.input, approval: { id: "approval-1" } }] });
  // The API returns the row's status alongside the columns StoredMessage names.
  const stored = { id: "row", clientMessageId: "a1", role: "assistant" as const, content, status: "success" as const };
  const result = mapStoredMessagesToUI([stored]);
  assert.deepEqual((result.uiMessages[0].parts[0] as ToolPart).approval, { id: "approval-1" });
});
