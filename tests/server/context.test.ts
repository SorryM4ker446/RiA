import assert from "node:assert/strict";
import { test } from "node:test";
import { convertToModelMessages, type TextPart, type ToolApprovalResponse, type UIMessage } from "ai";
import { buildChatContext, isToolApprovalContinuation } from "@/lib/chat/context";
import { estimateTextTokens } from "@/lib/models/context-budget";
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

test("a window anchored to the summary keeps its start across turns and refills to a target when it overflows", () => {
  const options = { maxTokens: 2_000, refillRatio: 0.6 };
  const conversation: UIMessage[] = [];
  const starts: number[] = [];
  let anchor: string | undefined;
  for (let turn = 0; turn < 40; turn++) {
    conversation.push(message(`u${turn}`, "user", `question ${turn} `.repeat(20)), message(`a${turn}`, "assistant", `answer ${turn} `.repeat(30)));
    const next = [...conversation, message(`u${turn + 1}-latest`, "user", "latest question")];
    const context = buildChatContext(next, { ...options, maxMessages: next.length, anchorMessageIds: anchor ? [anchor] : [] });
    starts.push(context.omittedMessages);
    // The summary written for this request covers everything before the window.
    if (context.omittedMessages > 0) anchor = next[context.omittedMessages - 1].id;
    const used = context.messages.reduce((sum, item) => sum + estimateTextTokens(item.parts.map(part => part.type === "text" ? part.text : "").join("\n")), 0);
    assert.ok(used <= options.maxTokens, `turn ${turn} uses ${used}`);
  }
  const cuts = starts.filter((start, index) => index > 0 && start !== starts[index - 1]).length;
  const firstCut = starts.findIndex(start => start > 0);
  assert.ok(firstCut > 0 && cuts <= 10, `the start moved ${cuts} times: ${starts.join(",")}`);

  // Without an anchor or a refill target the start follows every new turn.
  const unanchored = conversation.map((_, index) => index).filter(index => index % 2 === 1).map(index => {
    const next = [...conversation.slice(0, index + 1), message("latest", "user", "latest question")];
    return buildChatContext(next, { maxTokens: options.maxTokens, maxMessages: next.length }).omittedMessages;
  });
  const unanchoredCuts = unanchored.filter((start, index) => index > 0 && start !== unanchored[index - 1]).length;
  assert.ok(unanchoredCuts > cuts * 2, `unanchored ${unanchoredCuts} vs anchored ${cuts}`);
});

test("an anchor that no longer fits, or that is not in the conversation, is ignored", () => {
  const messages = Array.from({ length: 10 }, (_, index) => message(`m${index}`, index % 2 ? "assistant" : "user", `turn ${index} `.repeat(40)));
  messages.push(message("latest", "user", "latest"));
  const unknown = buildChatContext(messages, { maxMessages: messages.length, maxTokens: 100_000, anchorMessageIds: ["missing"] });
  assert.equal(unknown.omittedMessages, 0);
  const tooOld = buildChatContext(messages, { maxMessages: messages.length, maxTokens: 300, refillRatio: 0.6, anchorMessageIds: ["m1"] });
  assert.ok(tooOld.omittedMessages > 2);
  assert.equal(tooOld.messages[0].role, "user");
});
