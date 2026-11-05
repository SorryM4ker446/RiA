import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelMessage, UIMessage } from "ai";
import { createHash } from "node:crypto";
import { assertContextFits, contextBudget, estimateContextTokens, estimateImageTokens, imageDimensions, estimateTextTokens, requestOutputCap, DEFAULT_OUTPUT_LIMIT, MIN_CALIBRATION } from "@/lib/models/context-budget";
import { createStepContext, modelHistoryRecords, withoutToolRecords } from "@/lib/chat/step-context";
import { buildChatContext } from "@/lib/chat/context";
import { summaryCapacity } from "@/lib/chat/task-summary";
import { preferencesSchema, defaultModelPreferences } from "@/lib/models/preferences-schema";

const user: ModelMessage = { role: "user", content: "Fix the bug. Preserve the public API and verify the result." };
function block(id: string, size = 3500): ModelMessage[] { return [
  { role: "assistant", content: [{ type: "tool-call", toolName: "runTerminalCommand", toolCallId: id, input: { command: `node test-${id}.cjs` } }] },
  { role: "tool", content: [{ type: "tool-result", toolName: "runTerminalCommand", toolCallId: id, output: { type: "json", value: { status: "completed", exitCode: 2, stdout: `progress ${"0".repeat(22)}\n`.repeat(Math.ceil(size / 32)) + `error TS2304 ${id}\nTests: 2 failed`, fileChanges: { complete: true, files: [{ kind: "modified", path: "src/math.ts" }] } } } }] },
]; }

/** Excerpts only shorten results, so with the bulk in the call only a model fold can make room. */
function bulkyBlock(id: string): ModelMessage[] { return [
  { role: "assistant", content: [{ type: "tool-call", toolName: "runTerminalCommand", toolCallId: id, input: { command: `node test-${id}.cjs`, script: `progress ${"0".repeat(22)}\n`.repeat(Math.ceil(3500 / 32)) } }] },
  { role: "tool", content: [{ type: "tool-result", toolName: "runTerminalCommand", toolCallId: id, output: { type: "json", value: { status: "completed", exitCode: 2, stdout: `error TS2304 ${id}`, stderr: "" } } }] },
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

test("the sent output cap uses the known limit, else the default, that the input leaves room for", () => {
  const unknown = contextBudget({ contextLength: 1_000_000 });
  assert.equal(unknown.outputLimit, null);
  assert.equal(unknown.outputTokens, 8192, "the planning reservation is unchanged");
  assert.equal(requestOutputCap(unknown, undefined, 10_000), DEFAULT_OUTPUT_LIMIT);
  assert.equal(DEFAULT_OUTPUT_LIMIT, 131_072);
  assert.equal(requestOutputCap(unknown, undefined, 900_000), 1_000_000 - unknown.safetyTokens - 900_000, "the default also stays within the window");
  assert.equal(requestOutputCap(unknown, 512, 10_000), 512, "an explicit caller cap is kept");

  const catalog = contextBudget({ contextLength: 200_000, maxOutputTokens: 128_000 });
  assert.equal(catalog.outputTokens, 8192); assert.equal(catalog.outputLimit, 128_000);
  assert.equal(requestOutputCap(catalog, undefined, 10_000), 128_000);
  const crowded = requestOutputCap(catalog, undefined, 150_000)!;
  assert.equal(crowded, 200_000 - catalog.safetyTokens - 150_000, "input and output stay within the window");
  assert.equal(requestOutputCap(catalog, undefined, catalog.inputTokens), catalog.outputTokens, "never below the reservation");
  assert.equal(requestOutputCap(catalog, 1024, 10_000), 1024);

  const configured = contextBudget({ contextLength: 200_000, maxOutputTokens: 128_000 }, { maxOutputTokens: 300_000 });
  assert.equal(configured.outputLimit, 128_000, "configuration cannot exceed the catalog limit");
  assert.equal(contextBudget({ contextLength: 200_000 }, { maxOutputTokens: 64_000 }).outputLimit, 64_000);
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
  assert.equal(estimateContextTokens("abc", 0.5), Math.ceil(estimateContextTokens("abc") * 0.5), "provider usage can lower the estimate");
  assert.equal(estimateContextTokens("abc", 0.1), estimateContextTokens("abc", MIN_CALIBRATION), "but never below the documented overestimate");
  assert.equal(contextBudget().counting, "character-class-estimate");
});

test("summary capacity grows with the model window within fixed bounds", () => {
  const small = summaryCapacity(contextBudget({ contextLength: 12_000 }));
  assert.ok(small.outputTokens <= 2048); assert.ok(small.inputTokens <= contextBudget({ contextLength: 12_000 }).inputTokens);
  const medium = summaryCapacity(contextBudget({ contextLength: 128_000, maxOutputTokens: 16_384 }));
  assert.equal(medium.outputTokens, 8000);
  assert.ok(medium.inputTokens > 100_000, "evidence goes in one call when the model can hold it");
  const large = summaryCapacity(contextBudget({ contextLength: 1_000_000, maxOutputTokens: 32_000 }));
  assert.equal(large.outputTokens, 16_384); assert.ok(large.inputTokens > 900_000);
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
  const messages = [user, ...bulkyBlock("one"), ...bulkyBlock("two")];
  const manager = createStepContext({ budget: contextBudget({ contextLength: 40_000 }), system: "system", summarize: async () => "state" });
  await manager.prepare(messages);
  assert.equal(manager.report.compactions, 0);
  const first = manager.report.estimatedInputTokens;
  manager.observeUsage(undefined);
  manager.observeUsage(first / 2);
  assert.ok(manager.report.usageCalibration < 0.6, "what the provider counted replaces the guess the stream began with");
  const lowered = manager.report.usageCalibration;
  manager.observeUsage(first / 4);
  assert.equal(manager.report.usageCalibration, lowered, "from there it does not drop back within the stream");
  manager.observeUsage(first * 5);
  assert.ok(manager.report.usageCalibration > 4.9);
  await manager.prepare(messages);
  assert.ok(manager.report.compactions >= 1, "the calibrated estimate reaches the compaction trigger");
  assert.ok(manager.report.estimatedInputTokens <= manager.report.budget.inputTokens);
  manager.observeUsage(1);
  assert.ok(manager.report.usageCalibration > 4.9);
});

test("later steps of a stream are measured from the provider's reported input plus the appended messages", async () => {
  const messages = [user, ...block("one")];
  const manager = createStepContext({ budget: contextBudget({ contextLength: 200_000 }), system: "system", calibration: 0.5, summarize: async () => "state" });
  await manager.prepare(messages);
  assert.equal(manager.report.usageCalibration, 0.5, "a learned scale below one applies from the first step");
  manager.observeUsage(1234);
  const appended = block("two");
  await manager.prepare([...messages, ...appended]);
  assert.equal(manager.report.estimatedInputTokens, 1234 + estimateContextTokens(appended, manager.report.usageCalibration));
});

test("successive tool steps compact completed pairs while preserving the user and newest protocol verbatim", async () => {
  const messages = [user, ...bulkyBlock("one"), ...bulkyBlock("two")];
  const original = structuredClone(messages), folded: string[][] = [];
  const manager = createStepContext({ budget: contextBudget({ contextLength: 10_000 }), system: "Follow user constraints.",
    summarize: async (records, previous) => { folded.push(records); return previous + "\nAPI unchanged. src/math.ts has TS2304; tests failed; next fix and verify."; } });
  const first = await manager.prepare(messages);
  assert.equal(first.messages.at(-3), user);
  assert.deepEqual(first.messages.slice(-2), messages.slice(-2));
  assert.match(first.messages[0].content as string, /tests failed/);
  assert.match(folded[0].join("\n"), /error TS2304 one/);
  messages.push(...bulkyBlock("three"));
  const next = await manager.prepare(messages);
  assert.ok(next.messages.includes(user));
  assert.deepEqual(next.messages.slice(-2), messages.slice(-2));
  assert.ok(!folded.slice(1).flat().some(record => record.includes("TS2304 one")), "already covered evidence is not folded again");
  assert.deepEqual(messages.slice(0, original.length), original);
  assert.equal(manager.report.checks, 2); assert.ok(manager.report.compactions >= 2);
});

test("compression failures retain labelled bounded evidence without replaying tool calls", async () => {
  const manager = createStepContext({ budget: contextBudget({ contextLength: 10_000 }), system: "system", summarize: async () => { throw new Error("summary unavailable"); } });
  const messages = [user, ...bulkyBlock("failed"), ...bulkyBlock("current")];
  const result = await manager.prepare(messages);
  assert.equal(manager.report.degraded, true);
  assert.match(result.messages[0].content as string, /incomplete evidence/);
  assert.match(result.messages[0].content as string, /TS2304 failed/);
  assert.equal(result.messages.filter(message => message.role === "tool").length, 1);
  assert.ok(estimateContextTokens({ system: "system", messages: result.messages }) <= manager.report.budget.inputTokens);
});

test("older tool results are shortened to excerpts before any model call, keeping each call and result paired", async () => {
  const messages = [user, ...block("one"), ...block("two"), ...block("three")], original = structuredClone(messages);
  let summaries = 0;
  const manager = createStepContext({ budget: contextBudget({ contextLength: 10_000 }), system: "system", summarize: async () => { summaries++; return "state"; } });
  const { messages: prepared } = await manager.prepare(messages);
  assert.equal(summaries, 0, "excerpts were enough");
  assert.equal(manager.report.compactions, 0);
  assert.ok(manager.report.excerptedToolResults! >= 1);
  const calls = prepared.flatMap(message => Array.isArray(message.content) ? message.content.flatMap(part => part.type === "tool-call" ? [part.toolCallId] : []) : []);
  const results = prepared.flatMap(message => Array.isArray(message.content) ? message.content.flatMap(part => part.type === "tool-result" ? [part] : []) : []);
  assert.deepEqual(calls, ["one", "two", "three"]);
  assert.deepEqual(results.map(part => part.toolCallId), calls, "every call still has its result");
  assert.equal(results[0].output.type, "text");
  assert.match((results[0].output as { value: string }).value, /Historical tool record/);
  assert.match((results[0].output as { value: string }).value, /TS2304 one/, "a failure stays readable in the excerpt");
  assert.deepEqual(prepared.slice(-2), messages.slice(-2), "the newest interaction is untouched");
  assert.deepEqual(messages, original, "stored messages are not changed");
  // The same excerpts next step, so the prompt prefix stops changing.
  const again = await manager.prepare(messages);
  assert.deepEqual(again.messages, prepared);
});

test("a fold done before an approval pause is picked up again on resume, with no second model call", async () => {
  const messages = [user, ...bulkyBlock("one"), ...bulkyBlock("two")];
  const saved: { state: string; calls: string[] }[] = [];
  const paused = createStepContext({ budget: contextBudget({ contextLength: 10_000 }), system: "system", summarize: async () => "[Task state v1]\nchecked one", onFold: next => saved.push(next) });
  await paused.prepare(messages);
  assert.equal(saved.length, 1);
  assert.ok(saved[0].calls.includes("one"));
  assert.ok(!saved[0].calls.includes("two"), "the newest interaction stays out of the fold");
  // A reload rebuilds the messages, so only identities carry over.
  let summaries = 0;
  const resumed = createStepContext({ budget: contextBudget({ contextLength: 10_000 }), system: "system", handoff: saved[0], summarize: async () => { summaries++; return "again"; } });
  const { messages: prepared } = await resumed.prepare(structuredClone(messages));
  assert.equal(summaries, 0);
  assert.match(prepared[0].content as string, /checked one/);
  assert.equal(JSON.stringify(prepared).includes('"toolCallId":"one"'), false, "folded work is not sent again");
  assert.equal(JSON.stringify(prepared).includes('"toolCallId":"two"'), true);
});

test("a turn whose folds are used up at once stops, instead of spending on every step", async () => {
  let summaries = 0;
  const manager = createStepContext({ budget: contextBudget({ contextLength: 10_000 }), system: "system", summarize: async () => { summaries++; return "state"; } });
  const messages: ModelMessage[] = [user];
  let refused: unknown = null;
  for (let step = 0; step < 30 && !refused; step++) {
    messages.push(...bulkyBlock(`read-${step}`));
    await manager.prepare(messages).catch(error => { refused = error; });
  }
  assert.equal((refused as { code?: string } | null)?.code, "CONTEXT_LIMIT");
  assert.ok(summaries <= 9, `stopped after ${summaries} summaries`);

  // The same number of folds with room to work between them is an ordinary long turn.
  const steady = createStepContext({ budget: contextBudget({ contextLength: 10_000 }), system: "system", summarize: async () => "state" });
  const small: ModelMessage[] = [user];
  for (let step = 0; step < 60; step++) {
    small.push(...bulkyBlock(`read-${step}`).map((message, index) => index === 0 ? { ...message, content: (message.content as { input: unknown }[]).map(part => ({ ...part, input: { command: `node ${step}`, script: `progress ${"0".repeat(22)}\n`.repeat(25) } })) } as ModelMessage : message));
    await steady.prepare(small);
  }
  assert.ok(steady.report.compactions >= 8, `folded ${steady.report.compactions} times`);

  // Not in a row, but a summary every two or three steps costs as much as the work.
  let spacedSummaries = 0;
  const spaced = createStepContext({ budget: contextBudget({ contextLength: 10_000 }), system: "system", summarize: async () => { spacedSummaries++; return "state"; } });
  const growing: ModelMessage[] = [user];
  let stopped: unknown = null;
  for (let step = 0; step < 30 && !stopped; step++) {
    growing.push(...bulkyBlock(`read-${step}`));
    for (let pass = 0; pass < (step % 2 ? 3 : 2) && !stopped; pass++) await spaced.prepare(growing).catch(error => { stopped = error; });
  }
  assert.equal((stopped as { code?: string } | null)?.code, "CONTEXT_LIMIT");
  assert.ok(spacedSummaries <= 9, `stopped after ${spacedSummaries} summaries`);
});

test("a request sent without tools carries tool records as text, keeping what they found", () => {
  const messages = [user, ...block("one", 100), { role: "assistant", content: [{ type: "text", text: "Answered" }] } as ModelMessage, { role: "user", content: "Next" } as ModelMessage];
  const result = withoutToolRecords(messages);
  assert.deepEqual(result.map(message => message.role), ["user", "assistant", "assistant", "user"]);
  assert.match(result[1].content as string, /TS2304 one/);
  assert.equal(JSON.stringify(result).includes('"tool-call"'), false);
  assert.equal(result[2], messages[3], "messages without records are left alone");
});

test("pending approvals and their complete input are never shortened to force a request through", async () => {
  const pending: ModelMessage = { role: "assistant", content: [
    { type: "tool-call", toolName: "runTerminalCommand", toolCallId: "pending", input: { command: "0".repeat(16_000) } },
    { type: "tool-approval-request", approvalId: "approve", toolCallId: "pending" },
  ] };
  const manager = createStepContext({ budget: contextBudget({ contextLength: 10_000 }), system: "system", summarize: async () => "summary" });
  const messages = [user, ...block("completed"), pending];
  await assert.rejects(manager.prepare(messages), { code: "CONTEXT_LIMIT" });
  assert.equal(JSON.stringify(pending).includes("0".repeat(16_000)), true);
  assert.deepEqual(modelHistoryRecords(block("evidence")).some(record => record.includes('"exitCode":2')), true);
});

test("cancellation during compaction leaves source messages intact and prevents the next request", async () => {
  const controller = new AbortController();
  const messages = [user, ...bulkyBlock("one"), ...bulkyBlock("two")], original = structuredClone(messages);
  const manager = createStepContext({ budget: contextBudget({ contextLength: 10_000 }), system: "system", signal: controller.signal,
    summarize: async () => { controller.abort(); return "obsolete summary"; } });
  await assert.rejects(manager.prepare(messages), { name: "AbortError" });
  assert.equal(manager.report.compactions, 0);
  assert.deepEqual(messages, original);
});

test("completed calls packed beside a pending approval can be folded by identity without altering its command", async () => {
  // The bulk is in the calls, so excerpts of the results would not make room.
  const completed = ["old-1", "old-2", "old-3"].map(id => bulkyBlock(id));
  const oldCalls = completed.map(([call]) => (call.content as Exclude<ModelMessage["content"], string>)[0]);
  const oldResults = completed.map(([, result]) => (result.content as Exclude<ModelMessage["content"], string>)[0]);
  const pending = { type: "tool-call" as const, toolName: "runTerminalCommand", toolCallId: "pending", input: { command: "echo exact-command" } };
  const messages: ModelMessage[] = [user, { role: "assistant", content: [...oldCalls, pending,
    { type: "tool-approval-request", toolCallId: "pending", approvalId: "approval" },
  ] as Extract<ModelMessage, { role: "assistant" }>["content"] }, { role: "tool", content: [...oldResults,
    { type: "tool-approval-response", approvalId: "approval", approved: true },
  ] as Extract<ModelMessage, { role: "tool" }>["content"] }];
  const source = structuredClone(messages);
  const manager = createStepContext({ budget: contextBudget({ contextLength: 10_000 }), system: "system", summarize: async records => {
    assert.match(records.join("\n"), /TS2304 old/); return "Task state: previous build failed. Next: execute the approved exact command.";
  } });
  const prepared = await manager.prepare(messages);
  assert.match(JSON.stringify(prepared.messages), /exact-command/);
  assert.match(JSON.stringify(prepared.messages), /tool-approval-response/);
  assert.doesNotMatch(JSON.stringify(prepared.messages), /progress/);
  assert.deepEqual(messages, source);
});

test("an overflow recovery raises the scale and folds completed work before the step is resent", async () => {
  const manager = createStepContext({ budget: contextBudget({ contextLength: 1_000_000 }), system: "system", calibration: 0.5, summarize: async () => "state" });
  const messages = [user, ...block("one"), ...block("two")];
  await manager.prepare(messages);
  assert.equal(manager.report.compactions, 0);
  const before = manager.report.usageCalibration;
  const resent = await manager.recoverFromOverflow();
  assert.equal(manager.report.overflowRecoveries, 1);
  assert.equal(manager.report.usageCalibration, before * 2, "at most the 2x the estimate can have been lowered by");
  assert.equal(manager.report.compactions, 1);
  assert.ok(resent.length < messages.length);
  assert.deepEqual(resent.slice(-2), messages.slice(-2));
});

test("only a provider's own window refusal counts as a context overflow", async () => {
  const { isContextOverflow } = await import("@/lib/models/context-overflow");
  const { ApiError } = await import("@/lib/server/api-error");
  assert.equal(isContextOverflow(Object.assign(new Error("This endpoint's maximum context length is 8192 tokens"), { statusCode: 400 })), true);
  assert.equal(isContextOverflow(Object.assign(new Error("prompt is too long: 210000 tokens > 200000 maximum"), { statusCode: 400 })), true);
  assert.equal(isContextOverflow(Object.assign(new Error("Bad request"), { statusCode: 400, data: { error: { code: "context_length_exceeded" } } })), true);
  assert.equal(isContextOverflow(Object.assign(new Error("maximum context length"), { statusCode: 503 })), false);
  assert.equal(isContextOverflow(Object.assign(new Error("Invalid tool schema"), { statusCode: 400 })), false);
  assert.equal(isContextOverflow(new ApiError({ code: "CONTEXT_LIMIT", message: "maximum context length" })), false, "a planned refusal is not recovered from");
});

test("the composer reads the latest valid context report, including scales below one", async () => {
  const { latestContextReport } = await import("@/lib/chat/context-report");
  const budget = contextBudget({ contextLength: 200_000 });
  const report = { checks: 2, compactions: 1, degraded: false, estimatedInputTokens: 50_000, usageCalibration: 0.6, budget };
  const messages = [
    { id: "a", role: "assistant", parts: [], metadata: { contextBudget: { ...report, estimatedInputTokens: 10 } } },
    { id: "b", role: "assistant", parts: [], metadata: { contextBudget: report } },
    { id: "c", role: "user", parts: [] },
  ] as unknown as UIMessage[];
  const latest = latestContextReport(messages);
  assert.equal(latest?.estimatedInputTokens, 50_000);
  assert.equal(latest?.budget.triggerTokens, budget.triggerTokens);
  assert.equal(latestContextReport([{ id: "x", role: "assistant", parts: [], metadata: { contextBudget: { checks: -1 } } }] as unknown as UIMessage[]), null);
});

test("images are estimated from their dimensions, other binary data per byte", () => {
  const png = (width: number, height: number, bytes = 2_000_000) => {
    const data = new Uint8Array(bytes);
    data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(data.buffer).setUint32(16, width); new DataView(data.buffer).setUint32(20, height);
    return data;
  };
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00, ...new Array(200).fill(0)]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, ...new Array(50_000).fill(0)]);
  const webp = new Uint8Array(40); webp.set([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8X")]); webp.set([0x7f, 0x07, 0x00, 0x37, 0x04, 0x00], 24);
  assert.deepEqual(imageDimensions(png(4000, 3000)), { width: 4000, height: 3000 });
  assert.deepEqual(imageDimensions(gif), { width: 320, height: 240 });
  assert.deepEqual(imageDimensions(jpeg), { width: 1280, height: 720 });
  assert.deepEqual(imageDimensions(webp), { width: 1920, height: 1080 });
  // A 4000x3000 photo is resized to 2048x1536 before encoding: thousands of tokens, not millions.
  assert.equal(estimateImageTokens(png(4000, 3000)), Math.ceil(2048 * 1536 / 750));
  assert.equal(estimateImageTokens(jpeg), Math.ceil(1280 * 720 / 750));
  // A tiny file never costs more than its bytes; unknown data still counts per byte.
  assert.equal(estimateImageTokens(gif), Math.ceil(320 * 240 / 750));
  assert.equal(estimateImageTokens(png(4000, 3000, 1000)), 1000);
  assert.equal(estimateImageTokens(new Uint8Array(5000)), 5000);
  const photo = estimateContextTokens({ content: [{ type: "file", mediaType: "image/png", data: png(4000, 3000) }] });
  assert.ok(photo < 5000, `photo estimated at ${photo}`);
});
