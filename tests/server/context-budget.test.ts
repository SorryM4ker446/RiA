import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelMessage, UIMessage } from "ai";
import { createHash } from "node:crypto";
import { assertContextFits, contextBudget, estimateContextTokens, estimateTextTokens } from "@/lib/models/context-budget";
import { createStepContext, modelHistoryRecords } from "@/lib/chat/step-context";
import { buildChatContext } from "@/lib/chat/context";
import { summaryCapacity } from "@/lib/chat/task-summary";
import { preferencesSchema, defaultModelPreferences } from "@/lib/models/preferences-schema";

const user: ModelMessage = { role: "user", content: "Fix the bug. Preserve the public API and verify the result." };
function block(id: string, size = 3500): ModelMessage[] { return [
  { role: "assistant", content: [{ type: "tool-call", toolName: "runTerminalCommand", toolCallId: id, input: { command: `node test-${id}.cjs` } }] },
  { role: "tool", content: [{ type: "tool-result", toolName: "runTerminalCommand", toolCallId: id, output: { type: "json", value: { status: "completed", exitCode: 2, stdout: `progress ${"0".repeat(22)}\n`.repeat(Math.ceil(size / 32)) + `error TS2304 ${id}\nTests: 2 failed`, fileChanges: { complete: true, files: [{ kind: "modified", path: "src/math.ts" }] } } } }] },
]; }

test("model capacity uses catalog limits, configurable reductions, and a labelled unknown planning ceiling", () => {
  const known = contextBudget({ contextLength: 128_000, maxOutputTokens: 4096 }, { contextLength: 64_000, maxOutputTokens: 8000 });
  assert.equal(known.contextWindow, 64_000); assert.equal(known.outputTokens, 4096); assert.equal(known.capacitySource, "configured");
  assert.equal(known.inputTokens + known.outputTokens + known.safetyTokens, known.contextWindow);
  assert.equal(contextBudget({ contextLength: 128_000 }, { contextLength: 256_000 }).contextWindow, 128_000);
  assert.equal(contextBudget().capacitySource, "unknown");
  assert.equal(contextBudget().contextWindow, 131_072);
  const legacy = defaultModelPreferences(); delete (legacy as Partial<typeof legacy>).contextLimits;
  assert.deepEqual(preferencesSchema.parse(legacy).contextLimits, {});
  assert.equal(preferencesSchema.safeParse({ ...legacy, contextLimits: { "openrouter:test/model": { contextLength: 0, maxOutputTokens: 1 } } }).success, false);
});

test("input accounting includes system prompts, tools, unicode, and attachments", () => {
  const budget = contextBudget({ contextLength: 4096 });
  assert.ok(estimateContextTokens("中文🙂") > estimateContextTokens("abc"));
  assert.throws(() => assertContextFits(budget, { system: "0".repeat(4000), messages: [user] }), { code: "CONTEXT_LIMIT" });
  assert.throws(() => assertContextFits(budget, { messages: [user], tools: [{ inputSchema: { description: "0".repeat(4000) } }] }), { code: "CONTEXT_LIMIT" });
  assert.throws(() => assertContextFits(budget, { attachment: new Uint8Array(16_000) }), { code: "CONTEXT_LIMIT" });
});

test("the character-class estimate stays below byte counting for text yet never undercounts dense or random input", () => {
  const prose = "The build failed because the helper module was renamed during the refactor.";
  const code = "export function add(a: number, b: number) { return a + b; }";
  for (const text of [prose, code]) {
    assert.ok(estimateTextTokens(text) < Buffer.byteLength(text, "utf8") / 2);
    assert.ok(estimateTextTokens(text) >= text.split(/\s+/).length);
  }
  assert.equal(estimateTextTokens("0".repeat(1000)), 1000, "each digit and symbol is a token");
  assert.equal(estimateTextTokens("{}".repeat(500)), 1000);
  assert.equal(estimateTextTokens("中".repeat(100)), 150);
  assert.equal(estimateTextTokens("🙂".repeat(100)), 400);
  // Mixed-case random text tokenizes at roughly 0.7 tokens per character.
  const random = Array.from({ length: 200 }, (_, index) => createHash("sha256").update(String(index)).digest("base64")).join("");
  assert.ok(estimateTextTokens(random) >= random.length * 0.7);
  assert.equal(estimateContextTokens("abc", 2), 2 * estimateContextTokens("abc"));
  assert.equal(estimateContextTokens("abc", 0.5), estimateContextTokens("abc"), "calibration never scales below the estimate");
  assert.equal(contextBudget().counting, "character-class-estimate");
});

test("summary capacity grows with the model window within fixed bounds", () => {
  const small = summaryCapacity(contextBudget({ contextLength: 12_000 }));
  assert.ok(small.outputTokens <= 2048); assert.ok(small.inputTokens <= contextBudget({ contextLength: 12_000 }).inputTokens);
  const medium = summaryCapacity(contextBudget({ contextLength: 128_000, maxOutputTokens: 16_384 }));
  assert.equal(medium.outputTokens, 4000); assert.ok(medium.inputTokens >= 24_000);
  const large = summaryCapacity(contextBudget({ contextLength: 1_000_000, maxOutputTokens: 32_000 }));
  assert.equal(large.outputTokens, 8192); assert.equal(large.inputTokens, 128_000);
  assert.ok(large.stateTokens >= large.outputTokens * 4 && large.stateTokens <= large.inputTokens / 2);
  assert.equal(summaryCapacity(contextBudget({ contextLength: 1_000_000, maxOutputTokens: 1024 })).outputTokens, 1024, "never above the model's output limit");
});

test("the history window is measured in estimated tokens when a token budget is given", () => {
  const turn = (id: string, role: "user" | "assistant", text: string): UIMessage => ({ id, role, parts: [{ type: "text", text }] });
  const messages = [...Array.from({ length: 10 }, (_, index) => turn(`m${index}`, index % 2 ? "assistant" : "user", "plain english prose ".repeat(50))), turn("latest", "user", "continue")];
  const characters = buildChatContext(messages, { maxMessages: messages.length, maxCharacters: 3000 });
  const tokens = buildChatContext(messages, { maxMessages: messages.length, maxTokens: 3000 });
  assert.ok(tokens.messages.length > characters.messages.length, "the same number of tokens holds more prose than characters");
  assert.equal(tokens.omittedMessages, 0);
  const dense = buildChatContext(messages.map(message => message.id === "latest" ? message : turn(message.id, message.role as "user" | "assistant", "1234567890".repeat(100))), { maxMessages: messages.length, maxTokens: 3000 });
  assert.ok(dense.omittedMessages > 0, "dense content is still bounded");
  assert.equal(dense.messages.at(-1)!.id, "latest");
});

test("provider-reported input usage raises later step estimates for the stream and is never lowered", async () => {
  const messages = [user, ...block("one"), ...block("two")];
  const manager = createStepContext({ budget: contextBudget({ contextLength: 40_000 }), system: "system", summarize: async () => "state" });
  await manager.prepare(messages);
  assert.equal(manager.report.compactions, 0);
  const first = manager.report.estimatedInputTokens;
  manager.observeUsage(undefined);
  manager.observeUsage(first / 2);
  assert.equal(manager.report.usageCalibration, 1);
  manager.observeUsage(first * 5);
  assert.ok(manager.report.usageCalibration > 4.9);
  await manager.prepare(messages);
  assert.ok(manager.report.compactions >= 1, "the calibrated estimate reaches the compaction trigger");
  assert.ok(manager.report.estimatedInputTokens <= manager.report.budget.inputTokens);
  manager.observeUsage(1);
  assert.ok(manager.report.usageCalibration > 4.9);
});

test("successive tool steps compact completed pairs while preserving the user and newest protocol verbatim", async () => {
  const messages = [user, ...block("one"), ...block("two")];
  const original = structuredClone(messages), folded: string[][] = [];
  const manager = createStepContext({ budget: contextBudget({ contextLength: 12_000 }), system: "Follow user constraints.",
    summarize: async (records, previous) => { folded.push(records); return previous + "\nAPI unchanged. src/math.ts has TS2304; tests failed; next fix and verify."; } });
  const first = await manager.prepare(messages);
  assert.equal(first.messages.at(-3), user);
  assert.deepEqual(first.messages.slice(-2), messages.slice(-2));
  assert.match(first.messages[0].content as string, /tests failed/);
  assert.match(folded[0].join("\n"), /error TS2304 one/);
  messages.push(...block("three"));
  const next = await manager.prepare(messages);
  assert.ok(next.messages.includes(user));
  assert.deepEqual(next.messages.slice(-2), messages.slice(-2));
  assert.ok(!folded.slice(1).flat().some(record => record.includes("TS2304 one")), "already covered evidence is not folded again");
  assert.deepEqual(messages.slice(0, original.length), original);
  assert.equal(manager.report.checks, 2); assert.ok(manager.report.compactions >= 2);
});

test("compression failures retain labelled bounded evidence without replaying tool calls", async () => {
  const manager = createStepContext({ budget: contextBudget({ contextLength: 12_000 }), system: "system", summarize: async () => { throw new Error("summary unavailable"); } });
  const messages = [user, ...block("failed"), ...block("current")];
  const result = await manager.prepare(messages);
  assert.equal(manager.report.degraded, true);
  assert.match(result.messages[0].content as string, /incomplete evidence/);
  assert.match(result.messages[0].content as string, /TS2304 failed/);
  assert.equal(result.messages.filter(message => message.role === "tool").length, 1);
  assert.ok(estimateContextTokens({ system: "system", messages: result.messages }) <= manager.report.budget.inputTokens);
});

test("pending approvals and their complete input are never shortened to force a request through", async () => {
  const pending: ModelMessage = { role: "assistant", content: [
    { type: "tool-call", toolName: "runTerminalCommand", toolCallId: "pending", input: { command: "0".repeat(16_000) } },
    { type: "tool-approval-request", approvalId: "approve", toolCallId: "pending" },
  ] };
  const manager = createStepContext({ budget: contextBudget({ contextLength: 12_000 }), system: "system", summarize: async () => "summary" });
  const messages = [user, ...block("completed"), pending];
  await assert.rejects(manager.prepare(messages), { code: "CONTEXT_LIMIT" });
  assert.equal(JSON.stringify(pending).includes("0".repeat(16_000)), true);
  assert.deepEqual(modelHistoryRecords(block("evidence")).some(record => record.includes('"exitCode":2')), true);
});

test("cancellation during compaction leaves source messages intact and prevents the next request", async () => {
  const controller = new AbortController();
  const messages = [user, ...block("one"), ...block("two")], original = structuredClone(messages);
  const manager = createStepContext({ budget: contextBudget({ contextLength: 12_000 }), system: "system", signal: controller.signal,
    summarize: async () => { controller.abort(); return "obsolete summary"; } });
  await assert.rejects(manager.prepare(messages), { name: "AbortError" });
  assert.equal(manager.report.compactions, 0);
  assert.deepEqual(messages, original);
});

test("completed calls packed beside a pending approval can be folded by identity without altering its command", async () => {
  const completed = block("old", 7000);
  const oldCall = (completed[0].content as Exclude<ModelMessage["content"], string>)[0];
  const oldResult = (completed[1].content as Exclude<ModelMessage["content"], string>)[0];
  const pending = { type: "tool-call" as const, toolName: "runTerminalCommand", toolCallId: "pending", input: { command: "echo exact-command" } };
  const messages: ModelMessage[] = [user, { role: "assistant", content: [oldCall, pending,
    { type: "tool-approval-request", toolCallId: "pending", approvalId: "approval" },
  ] as Extract<ModelMessage, { role: "assistant" }>["content"] }, { role: "tool", content: [oldResult,
    { type: "tool-approval-response", approvalId: "approval", approved: true },
  ] as Extract<ModelMessage, { role: "tool" }>["content"] }];
  const source = structuredClone(messages);
  const manager = createStepContext({ budget: contextBudget({ contextLength: 12_000 }), system: "system", summarize: async records => {
    assert.match(records.join("\n"), /TS2304 old/); return "Task state: previous build failed. Next: execute the approved exact command.";
  } });
  const prepared = await manager.prepare(messages);
  assert.match(JSON.stringify(prepared.messages), /exact-command/);
  assert.match(JSON.stringify(prepared.messages), /tool-approval-response/);
  assert.doesNotMatch(JSON.stringify(prepared.messages), /progress/);
  assert.deepEqual(messages, source);
});
