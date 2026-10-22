import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, basename, join } from "node:path";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { seedTestModelPreferences, CHAT_MODEL_REF } from "../helpers/model-library";
import { languageModel, resetProviderState } from "../helpers/model-provider";

const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const route = await import("@/app/api/chat/route");
const { createGrant, revokeGrant } = await import("@/lib/local-files/grants");
const { setTerminalPermission } = await import("@/lib/terminal/permissions");
const { summarizeOlderTurns } = await import("@/lib/chat/summary");
const { TASK_STATE_VERSION } = await import("@/lib/chat/task-summary");
const { encodePersistedAssistantToolMessage, decodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
const { mapStoredMessagesToUI } = await import("@/features/chat/page-utils");
const { contextBudget, estimateContextTokens, MIN_CALIBRATION } = await import("@/lib/models/context-budget");
const { CALIBRATION_SAMPLES, contextCalibration, recordContextCalibration } = await import("@/lib/models/context-calibration");
const { getModelPreferences, saveModelPreferences } = await import("@/lib/models/preferences");
const roots: string[] = [];
beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {});
  resetProviderState(); globalThis.__privateAiRateLimitStore?.clear();
  process.env.APP_RUNTIME = "test"; process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  await db.chat.deleteMany({}); await db.task.deleteMany({}); await db.modelContextCalibration.deleteMany({});
  await seedTestModelPreferences(db);
});
after(async () => {
  for (const grant of await db.directoryGrant.findMany({ where: { revokedAt: null } })) await revokeGrant(grant.id);
  await db.$disconnect();
  for (const root of roots) {
    if (dirname(root) !== realpathSync.native(tmpdir()) || !basename(root).startsWith("ria-context-project-")) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
  cleanup();
});
const ui = (id: string, role: UIMessage["role"], text: string): UIMessage => ({ id, role, parts: [{ type: "text", text }] });
function request(body: unknown, signal?: AbortSignal) { return new NextRequest("http://localhost/api/chat", { method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify(body), signal }); }
async function capacity(contextLength: number, maxOutputTokens = 2048) {
  const settings = await seedTestModelPreferences(db);
  settings.library = settings.library.map(model => model.modelId === CHAT_MODEL_REF.modelId ? { ...model, contextLength } : model);
  settings.contextLimits = { [`openrouter:${CHAT_MODEL_REF.modelId}`]: { contextLength, maxOutputTokens } };
  await db.workspacePreference.update({ where: { id: "local" }, data: { settings } });
  return contextBudget(settings.library.find(model => model.modelId === CHAT_MODEL_REF.modelId), settings.contextLimits[`openrouter:${CHAT_MODEL_REF.modelId}`]);
}
function summaryAnswer(text: string) { return { content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: "stop" }, usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 80, text: 80, reasoning: 0 } }, warnings: [] }; }

test("a multi-file code task compacts real terminal failures and passes tests before a reloaded follow-up without replay", { timeout: 30_000 }, async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ria-context-project-"))); roots.push(root);
  writeFileSync(join(root, "math.cjs"), "exports.add = (a, b) => a - b;\n");
  writeFileSync(join(root, "test.cjs"), "const assert = require('node:assert/strict'); const {add}=require('./math.cjs'); assert.equal(add(2,3),5); assert.equal(add(-1,1),0); console.log('Tests: 2 passed');\n");
  writeFileSync(join(root, "driver.cjs"), [
    "const fs=require('node:fs'); const action=process.argv[2];",
    "fs.appendFileSync('executions.txt',action+'\\n'); console.log(('progress '+'0'.repeat(22)+'\\n').repeat(1200));",
    "if(action==='inspect') console.log('API: add(a,b); source: '+fs.readFileSync('math.cjs','utf8'));",
    "if(action==='check'||action==='verify') require('./test.cjs');",
    "if(action==='fix') { fs.writeFileSync('math.cjs','exports.add = (a, b) => a + b;\\n'); console.log('Modified math.cjs; public API unchanged'); }",
  ].join("\n"));
  const grant = await createGrant({ path: root });
  await setTerminalPermission(grant.id, true, grant.updatedAt, "full-access");
  const budget = await capacity(80_000);
  const summaryInputs: string[] = [], prompts: string[] = [];
  t.mock.method(languageModel, "doGenerate", async options => {
    const input = JSON.stringify(options.prompt); summaryInputs.push(input);
    assert.ok(estimateContextTokens({ prompt: options.prompt, tools: options.tools }) <= budget.inputTokens);
    return summaryAnswer("Goal: fix add(a,b), preserve its public API. Evidence: inspected math.cjs. " +
      (input.includes("AssertionError") ? "Verification: node test.cjs failed with AssertionError, not yet passing. " : "") +
      (input.includes("Modified math.cjs") ? "Changes: implementation corrected; still requires verification. " : "") + "Pending: verify the real tests, then report their outcome.");
  });
  let call = 0;
  const actions = ["inspect", "check", "fix", "verify"];
  t.mock.method(languageModel, "doStream", async options => {
    assert.ok(estimateContextTokens({ prompt: options.prompt, tools: options.tools }) <= budget.inputTokens, "every actual model step fits");
    prompts.push(JSON.stringify(options.prompt));
    // Usage matches the uncalibrated estimate, so counting anchors on a realistic size.
    const reported = estimateContextTokens({ prompt: options.prompt, tools: options.tools });
    const action = actions[call++];
    return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      if (action) {
        const node = process.execPath.replaceAll("'", process.platform === "win32" ? "''" : "'\\''");
        const command = `${process.platform === "win32" ? "& " : ""}'${node}' ./driver.cjs ${action}`;
        controller.enqueue({ type: "tool-call", toolName: "runTerminalCommand", toolCallId: `project-${action}`, input: JSON.stringify({ grantId: grant.id, command }) });
      } else {
        controller.enqueue({ type: "text-start", id: "answer" });
        controller.enqueue({ type: "text-delta", id: "answer", delta: "Verified: Tests: 2 passed. Public API unchanged." });
        controller.enqueue({ type: "text-end", id: "answer" });
      }
      controller.enqueue({ type: "finish", finishReason: { unified: action ? "tool-calls" : "stop", raw: undefined }, usage: { inputTokens: { total: reported, noCache: reported, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 100, text: 100, reasoning: 0 } } });
      controller.close();
    } }) };
  });
  const goal = ui("project-goal", "user", "Fix add(a,b) in this project. Preserve the public API and run the real tests.");
  const response = await route.POST(request({ messages: [goal] }));
  assert.equal(response.status, 200);
  const wire = await response.text();
  assert.match(wire, /Tests: 2 passed/);
  const run = await db.agentRun.findFirstOrThrow({ orderBy: { startedAt: "desc" } });
  assert.equal(run.status, "succeeded");
  assert.ok(summaryInputs.length >= 2, "multiple context compactions occurred during one tool loop");
  assert.ok(summaryInputs.some(input => input.includes("AssertionError")), "failure evidence reaches task state");
  assert.match(prompts[2], /AssertionError/);
  assert.match(prompts[3], /Modified math.cjs/);
  assert.match(prompts[4], /Tests: 2 passed/);
  assert.ok(prompts.every(prompt => prompt.includes("Preserve the public API")));
  assert.equal(readFileSync(join(root, "math.cjs"), "utf8"), "exports.add = (a, b) => a + b;\n");
  assert.equal(readFileSync(join(root, "executions.txt"), "utf8"), "inspect\ncheck\nfix\nverify\n");
  const rows = await db.message.findMany({ where: { chatId: run.chatId! }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const saved = decodePersistedAssistantToolMessage(rows.find(row => row.role === "assistant")!.content)!;
  assert.equal(saved.tools.length, 4);
  assert.ok(saved.contextBudget && saved.contextBudget.compactions >= 2);
  assert.ok((mapStoredMessagesToUI(rows).uiMessages.at(-1)!.metadata as { contextBudget?: unknown }).contextBudget);
  const outputs = saved.tools.map(tool => tool.output as { exitCode: number; stdout: string; stderr: string });
  assert.notEqual(outputs[1].exitCode, 0); assert.equal(outputs[3].exitCode, 0); assert.match(outputs[3].stdout, /Tests: 2 passed/);
  const steps = await db.agentStep.count({ where: { runId: run.id } });
  await db.$disconnect();
  const followup = await route.POST(request({ chatId: run.chatId, messages: [...mapStoredMessagesToUI(rows).uiMessages, ui("after-reload", "user", "Which tests actually passed? Do not rerun them.")] }));
  assert.equal(followup.status, 200); assert.match(await followup.text(), /Tests: 2 passed/);
  assert.equal(await db.agentStep.count({ where: { runId: run.id } }), steps);
  assert.equal(readFileSync(join(root, "executions.txt"), "utf8"), "inspect\ncheck\nfix\nverify\n");
});

test("over-budget approval preflight leaves the stored decision pending and executes no side effects", async () => {
  await capacity(40_000);
  const chat = await db.chat.create({ data: { title: "Budget refusal" } });
  const tool = { toolName: "createTask", toolCallId: "approval-tool", state: "approval-requested", input: { title: "Do not duplicate" }, approval: { id: "budget-approval" } };
  await db.message.create({ data: { chatId: chat.id, role: "user", clientMessageId: "approval-user", content: "Create one task" } });
  const original = encodePersistedAssistantToolMessage({ type: "assistant-tool-message", text: "", reasoning: "0".repeat(60_000), tools: [tool] });
  await db.message.create({ data: { chatId: chat.id, role: "assistant", clientMessageId: "approval-answer", content: original } });
  const messages: UIMessage[] = [ui("approval-user", "user", "Create one task"), { id: "approval-answer", role: "assistant", parts: [
    { type: "reasoning", text: "0".repeat(60_000) }, { type: "tool-createTask", toolCallId: tool.toolCallId, input: tool.input, state: "approval-responded", approval: { ...tool.approval, approved: true } },
  ] }];
  const rejected = await route.POST(request({ chatId: chat.id, messages }));
  assert.equal(rejected.status, 413); assert.equal((await rejected.json()).error.code, "CONTEXT_LIMIT");
  assert.equal(await db.task.count(), 0);
  assert.equal((await db.message.findFirstOrThrow({ where: { chatId: chat.id, role: "assistant" } })).content, original);
  await capacity(200_000);
  const retried = await route.POST(request({ chatId: chat.id, messages }));
  assert.equal(retried.status, 200); await retried.text();
  assert.equal(await db.task.count({ where: { title: "Do not duplicate" } }), 1);
});

test("persisted task state folds only new evidence and an obsolete summarizer cannot overwrite newer coverage", async t => {
  const chat = await db.chat.create({ data: { title: "Incremental state" } });
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push(await db.message.create({ data: { chatId: chat.id, role: i % 2 ? "assistant" : "user", content: `evidence-${i}`, createdAt: new Date(i * 1000) } }));
  const messages = rows.map(row => ({ id: row.id, role: row.role, text: row.content }));
  const inputs: string[] = [];
  t.mock.method(languageModel, "doGenerate", async options => { inputs.push(JSON.stringify(options.prompt)); return summaryAnswer("Goal: preserve API. Verified: build failed. Pending: fix and test."); });
  assert.ok(await summarizeOlderTurns({ chatId: chat.id, messages, keepRecent: 6, force: true }));
  assert.ok((await db.chat.findUniqueOrThrow({ where: { id: chat.id } })).summary!.startsWith(TASK_STATE_VERSION));
  assert.ok(await summarizeOlderTurns({ chatId: chat.id, messages, keepRecent: 4, force: true }));
  assert.doesNotMatch(inputs[1], /evidence-0|evidence-1/); assert.match(inputs[1], /evidence-2/);
  const calls = inputs.length;
  await summarizeOlderTurns({ chatId: chat.id, messages, keepRecent: 4, force: true }); assert.equal(inputs.length, calls);
  t.mock.method(languageModel, "doGenerate", async () => {
    await db.chat.update({ where: { id: chat.id }, data: { summary: `${TASK_STATE_VERSION}\nNewer verified state`, summaryUpToMessageId: rows[7].id } });
    return summaryAnswer("Stale result");
  });
  assert.equal(await summarizeOlderTurns({ chatId: chat.id, messages, keepRecent: 2, force: true }), null);
  assert.match((await db.chat.findUniqueOrThrow({ where: { id: chat.id } })).summary!, /Newer verified state/);
  assert.equal(await db.message.count({ where: { chatId: chat.id } }), 8);
});

test("older-turn summaries receive every tool result of a long assistant message, not only the last three", async t => {
  const chat = await db.chat.create({ data: { title: "Long tool turn" } });
  const tools = Array.from({ length: 6 }, (_, index) => ({ toolName: "runTerminalCommand", toolCallId: `step-${index}`, state: "output-available",
    input: { command: `node build-${index}.cjs` },
    output: { status: "completed", exitCode: index === 0 ? 2 : 0, stdout: `step ${index} log\n`.repeat(40), stderr: index === 0 ? "error TS2304: early-failure-marker" : "" } }));
  const rows = [];
  rows.push(await db.message.create({ data: { chatId: chat.id, role: "user", content: "Build and fix the project", createdAt: new Date(0) } }));
  rows.push(await db.message.create({ data: { chatId: chat.id, role: "assistant", createdAt: new Date(1000),
    content: encodePersistedAssistantToolMessage({ type: "assistant-tool-message", text: "Investigated the build. ".repeat(100) + "final-answer-marker", tools }) } }));
  for (let i = 2; i < 6; i++) rows.push(await db.message.create({ data: { chatId: chat.id, role: i % 2 ? "assistant" : "user", content: `later-${i}`, createdAt: new Date(i * 1000) } }));
  const inputs: string[] = [];
  t.mock.method(languageModel, "doGenerate", async options => { inputs.push(JSON.stringify(options.prompt)); return summaryAnswer("Build failed early with TS2304; later steps passed."); });
  assert.ok(await summarizeOlderTurns({ chatId: chat.id, messages: rows.map(row => ({ id: row.id, role: row.role, text: row.content })), keepRecent: 2, force: true }));
  const folded = inputs.join("\n");
  assert.match(folded, /early-failure-marker/);
  assert.match(folded, /final-answer-marker/);
  for (let index = 0; index < 6; index++) assert.match(folded, new RegExp(`step-${index}`));
  assert.doesNotMatch(folded, /earlier tool calls omitted/);
});

test("pagination gaps are folded from stored evidence and an older request cannot replace newer summary coverage", async t => {
  const chat = await db.chat.create({ data: { title: "Paged history" } });
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(await db.message.create({ data: { chatId: chat.id, role: i % 2 ? "assistant" : "user", content: `stored-gap-${i}`, createdAt: new Date(i * 1000) } }));
  await db.chat.update({ where: { id: chat.id }, data: { summary: `${TASK_STATE_VERSION}\nOriginal constraint: preserve API`, summaryRevision: 0, summaryUpToMessageId: rows[1].id } });
  const inputs: string[] = [];
  t.mock.method(languageModel, "doGenerate", async options => { inputs.push(JSON.stringify(options.prompt)); return summaryAnswer("Original constraint: preserve API. Tests failed, fix remains pending."); });
  const recentPage = rows.slice(6).map(row => ({ id: row.id, role: row.role, text: row.content }));
  assert.ok(await summarizeOlderTurns({ chatId: chat.id, messages: recentPage, keepRecent: 2, force: true }));
  for (let i = 2; i <= 7; i++) assert.match(inputs.join("\n"), new RegExp(`stored-gap-${i}`));
  assert.doesNotMatch(inputs.join("\n"), /stored-gap-0|stored-gap-1/);
  const olderPage = rows.slice(0, 4).map(row => ({ id: row.id, role: row.role, text: row.content }));
  assert.equal(await summarizeOlderTurns({ chatId: chat.id, messages: olderPage, keepRecent: 2, force: true }), null);
  assert.equal((await db.chat.findUniqueOrThrow({ where: { id: chat.id } })).summaryUpToMessageId, rows[7].id);
});

test("context exhaustion after a real command closes the run and preserves its completed result for a later request", { timeout: 15_000 }, async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ria-context-project-"))); roots.push(root);
  writeFileSync(join(root, "large.cjs"), "require('node:fs').appendFileSync('once.txt','once'); console.log('0'.repeat(45000)); console.log('Tests: 1 passed');\n");
  const grant = await createGrant({ path: root });
  await setTerminalPermission(grant.id, true, grant.updatedAt, "full-access");
  await capacity(40_000);
  let calls = 0;
  t.mock.method(languageModel, "doStream", async () => {
    const first = calls++ === 0;
    const node = process.execPath.replaceAll("'", process.platform === "win32" ? "''" : "'\\''");
    return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      if (first) controller.enqueue({ type: "tool-call", toolCallId: "large-output", toolName: "runTerminalCommand", input: JSON.stringify({ grantId: grant.id, command: `${process.platform === "win32" ? "& " : ""}'${node}' ./large.cjs` }) });
      else {
        controller.enqueue({ type: "text-start", id: "recovery" });
        controller.enqueue({ type: "text-delta", id: "recovery", delta: "The saved command completed with exit code 0." });
        controller.enqueue({ type: "text-end", id: "recovery" });
      }
      controller.enqueue({ type: "finish", finishReason: { unified: first ? "tool-calls" : "stop", raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } } });
      controller.close();
    } }) };
  });
  const response = await route.POST(request({ messages: [ui("large-output-user", "user", "Run the command once and report the tests.")] }));
  assert.equal(response.status, 200);
  const wire = await response.text(); assert.match(wire, /CONTEXT_LIMIT/); assert.doesNotMatch(wire, /Invalid request body/);
  assert.equal(calls, 1, "no over-budget model step was submitted");
  const run = await db.agentRun.findFirstOrThrow({ orderBy: { startedAt: "desc" } });
  assert.equal(run.status, "failed"); assert.equal(run.stopReason, "context-limit"); assert.ok(run.finishedAt);
  const rows = await db.message.findMany({ where: { chatId: run.chatId! }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const saved = decodePersistedAssistantToolMessage(rows.find(row => row.role === "assistant")!.content)!;
  assert.equal((saved.tools[0].output as { exitCode: number }).exitCode, 0);
  assert.equal(saved.tools[0].state, "output-available");
  await capacity(200_000);
  const recovered = await route.POST(request({ chatId: run.chatId, messages: [...mapStoredMessagesToUI(rows).uiMessages, ui("recovery", "user", "Explain the saved result; do not execute again.")] }));
  assert.equal(recovered.status, 200); assert.match(await recovered.text(), /exit code 0/);
  assert.equal(readFileSync(join(root, "once.txt"), "utf8"), "once");
});

async function calibrationRun(t: TestContext, contextLength: number, reportedFirstInput: (budget: ReturnType<typeof contextBudget>) => number) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ria-context-project-"))); roots.push(root);
  writeFileSync(join(root, "small.cjs"), "require('node:fs').appendFileSync('once.txt','once'); console.log('0'.repeat(4000)); console.log('Tests: 1 passed');\n");
  const grant = await createGrant({ path: root });
  await setTerminalPermission(grant.id, true, grant.updatedAt, "full-access");
  const budget = await capacity(contextLength);
  let calls = 0;
  t.mock.method(languageModel, "doStream", async () => {
    const first = calls++ === 0;
    const node = process.execPath.replaceAll("'", process.platform === "win32" ? "''" : "'\\''");
    // The provider counts more input than estimated, as a less efficient tokenizer would.
    const reported = first ? reportedFirstInput(budget) : 10;
    return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      if (first) controller.enqueue({ type: "tool-call", toolCallId: "small-output", toolName: "runTerminalCommand", input: JSON.stringify({ grantId: grant.id, command: `${process.platform === "win32" ? "& " : ""}'${node}' ./small.cjs` }) });
      else { controller.enqueue({ type: "text-start", id: "a" }); controller.enqueue({ type: "text-delta", id: "a", delta: "Tests: 1 passed" }); controller.enqueue({ type: "text-end", id: "a" }); }
      controller.enqueue({ type: "finish", finishReason: { unified: first ? "tool-calls" : "stop", raw: undefined }, usage: { inputTokens: { total: reported, noCache: reported, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } } });
      controller.close();
    } }) };
  });
  const response = await route.POST(request({ messages: [ui("calibration-user", "user", "Run the command once and report the tests.")] }));
  assert.equal(response.status, 200);
  const wire = await response.text();
  const run = await db.agentRun.findFirstOrThrow({ orderBy: { startedAt: "desc" } });
  const rows = await db.message.findMany({ where: { chatId: run.chatId! }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const saved = decodePersistedAssistantToolMessage(rows.find(row => row.role === "assistant")!.content)!;
  assert.equal((saved.tools[0].output as { exitCode: number }).exitCode, 0);
  assert.equal(readFileSync(join(root, "once.txt"), "utf8"), "once");
  return { wire, calls, run, saved };
}

test("provider input usage above the local estimate makes the next step refuse instead of overflowing", { timeout: 15_000 }, async t => {
  const result = await calibrationRun(t, 40_000, budget => budget.inputTokens);
  assert.match(result.wire, /CONTEXT_LIMIT/);
  assert.equal(result.calls, 1, "the step that would exceed the provider's real count was not submitted");
  assert.equal(result.run.stopReason, "context-limit");
  // A turn ending in an error still records its context accounting.
  assert.ok(result.saved.contextBudget!.usageCalibration! > 1);
  assert.ok(result.saved.contextBudget!.checks >= 2);
});

test("provider usage calibration is applied to later steps and recorded with a completed turn", { timeout: 15_000 }, async t => {
  const result = await calibrationRun(t, 1_000_000, () => 100_000);
  assert.equal(result.calls, 2);
  assert.equal(result.run.status, "succeeded");
  assert.ok(result.saved.contextBudget!.usageCalibration! > 1);
  assert.ok(result.saved.contextBudget!.estimatedInputTokens > 100_000, "the calibrated estimate covers the provider's count");
  assert.equal(result.saved.contextBudget!.budget.counting, "character-class-estimate");
  // The next request to this model starts from the recorded scale, before any usage is seen.
  const learned = await contextCalibration(CHAT_MODEL_REF);
  assert.ok(learned > 1);
  t.mock.method(languageModel, "doStream", async () => ({ stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
    controller.enqueue({ type: "stream-start", warnings: [] });
    controller.enqueue({ type: "text-start", id: "b" }); controller.enqueue({ type: "text-delta", id: "b", delta: "ok" }); controller.enqueue({ type: "text-end", id: "b" });
    controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
    controller.close();
  } }) }));
  const next = await route.POST(request({ chatId: result.run.chatId, messages: [ui("calibrated-next", "user", "Summarize the result.")] }));
  assert.equal(next.status, 200); await next.text();
  const rows = await db.message.findMany({ where: { chatId: result.run.chatId! }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const latest = decodePersistedAssistantToolMessage(rows.filter(row => row.role === "assistant").at(-1)!.content)!;
  assert.equal(latest.contextBudget!.usageCalibration, learned);
});

test("a request that uses up its compaction calls keeps labelled excerpts, completes and reports why", { timeout: 60_000 }, async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ria-context-project-"))); roots.push(root);
  writeFileSync(join(root, "step.cjs"), "require('node:fs').appendFileSync('steps.txt','x'); console.log('0'.repeat(4000)); console.log('step done');\n");
  const grant = await createGrant({ path: root });
  await setTerminalPermission(grant.id, true, grant.updatedAt, "full-access");
  await capacity(20_000);
  await saveModelPreferences({ ...await getModelPreferences(), callLimits: { ...(await getModelPreferences()).callLimits, compactionCallsPerTurn: 1 } });
  let summaries = 0, calls = 0;
  t.mock.method(languageModel, "doGenerate", async () => { summaries++; return summaryAnswer("Steps ran; continue with the next step."); });
  t.mock.method(languageModel, "doStream", async options => {
    const step = calls++;
    const reported = estimateContextTokens({ prompt: options.prompt, tools: options.tools });
    const node = process.execPath.replaceAll("'", process.platform === "win32" ? "''" : "'\\''");
    return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      if (step < 6) controller.enqueue({ type: "tool-call", toolCallId: `step-${step}`, toolName: "runTerminalCommand", input: JSON.stringify({ grantId: grant.id, command: `${process.platform === "win32" ? "& " : ""}'${node}' ./step.cjs` }) });
      else { controller.enqueue({ type: "text-start", id: "a" }); controller.enqueue({ type: "text-delta", id: "a", delta: "All steps done" }); controller.enqueue({ type: "text-end", id: "a" }); }
      controller.enqueue({ type: "finish", finishReason: { unified: step < 6 ? "tool-calls" : "stop", raw: undefined }, usage: { inputTokens: { total: reported, noCache: reported, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } } });
      controller.close();
    } }) };
  });
  const response = await route.POST(request({ messages: [ui("allowance-user", "user", "Run the six steps.")] }));
  assert.equal(response.status, 200); assert.match(await response.text(), /All steps done/);
  assert.equal(summaries, 1, "no summary call beyond the allowance");
  assert.equal(readFileSync(join(root, "steps.txt"), "utf8"), "xxxxxx");
  const run = await db.agentRun.findFirstOrThrow({ orderBy: { startedAt: "desc" } });
  assert.equal(run.status, "succeeded");
  const rows = await db.message.findMany({ where: { chatId: run.chatId! }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const saved = decodePersistedAssistantToolMessage(rows.find(row => row.role === "assistant")!.content)!;
  assert.equal(saved.contextBudget!.compactionAllowanceExhausted, true);
  assert.equal(saved.contextBudget!.degraded, true);
  assert.ok(saved.contextBudget!.compactions >= 2);
});

test("stored calibration keeps recent samples only, ignores invalid ratios and lowers the estimate no further than its floor", async () => {
  await recordContextCalibration(CHAT_MODEL_REF, 50);
  assert.equal(await contextCalibration(CHAT_MODEL_REF), 50);
  for (const invalid of [null, Number.NaN, -1, 0, Infinity]) await recordContextCalibration(CHAT_MODEL_REF, invalid);
  assert.equal(await contextCalibration(CHAT_MODEL_REF), 50);
  for (let i = 0; i < CALIBRATION_SAMPLES; i++) await recordContextCalibration(CHAT_MODEL_REF, 0.7);
  assert.equal(await contextCalibration(CHAT_MODEL_REF), 0.7, "an old outlier ages out and lower provider counts lower the scale");
  for (let i = 0; i < CALIBRATION_SAMPLES; i++) await recordContextCalibration(CHAT_MODEL_REF, 0.1);
  assert.equal(await contextCalibration(CHAT_MODEL_REF), MIN_CALIBRATION, "never below the documented overestimate");
  await db.modelContextCalibration.update({ where: { modelKey: `openrouter:${CHAT_MODEL_REF.modelId}` }, data: { samples: "not json" } });
  assert.equal(await contextCalibration(CHAT_MODEL_REF), 1);
});

test("output exhaustion marks partial answers and runs failed with explicit recovery guidance", async t => {
  t.mock.method(languageModel, "doStream", async () => ({ stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
    controller.enqueue({ type: "stream-start", warnings: [] });
    controller.enqueue({ type: "text-start", id: "partial" });
    controller.enqueue({ type: "text-delta", id: "partial", delta: "Still investigating" });
    controller.enqueue({ type: "text-end", id: "partial" });
    controller.enqueue({ type: "finish", finishReason: { unified: "length", raw: "length" }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } } });
    controller.close();
  } }) }));
  const response = await route.POST(request({ messages: [ui("output-limit", "user", "Investigate the problem")] }));
  await response.text();
  const run = await db.agentRun.findFirstOrThrow({ orderBy: { startedAt: "desc" } });
  assert.equal(run.status, "failed"); assert.equal(run.stopReason, "output-limit");
  assert.equal((await db.message.findFirstOrThrow({ where: { chatId: run.chatId!, role: "assistant" } })).status, "error");
  const { executionGuidance } = await import("@/lib/execution-messages");
  assert.match(executionGuidance("output-limit"), /输出上限/);
  assert.match(executionGuidance("context-limit"), /输入预算/);
});

test("a step the provider refuses as over its window is compacted and sent again once", async t => {
  let calls = 0; const prompts: string[] = [];
  t.mock.method(languageModel, "doGenerate", async () => summaryAnswer("Earlier: the user asked about the release plan."));
  t.mock.method(languageModel, "doStream", async options => {
    calls++; prompts.push(JSON.stringify(options.prompt));
    if (calls === 1) throw Object.assign(new Error("This model's maximum context length is 8192 tokens. Please reduce the length of the messages."), { statusCode: 400 });
    return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "a" }); controller.enqueue({ type: "text-delta", id: "a", delta: "Recovered answer" }); controller.enqueue({ type: "text-end", id: "a" });
      controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } } });
      controller.close();
    } }) };
  });
  const response = await route.POST(request({ messages: [
    ui("o-1", "user", "What is in the release plan?"), ui("o-2", "assistant", "OLDEST-ANSWER-MARKER"),
    ui("o-3", "user", "And the schedule?"), ui("o-4", "assistant", "Schedule answer"),
    ui("o-5", "user", "Summarize both"),
  ] }));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Recovered answer/);
  assert.equal(calls, 2, "resent exactly once");
  assert.match(prompts[0], /OLDEST-ANSWER-MARKER/);
  assert.doesNotMatch(prompts[1], /OLDEST-ANSWER-MARKER/, "the resent step no longer carries the folded turn");
  assert.match(prompts[1], /Earlier task state/);
  assert.match(prompts[1], /Summarize both/);
  const run = await db.agentRun.findFirstOrThrow({ orderBy: { startedAt: "desc" } });
  assert.equal(run.status, "succeeded");
  const saved = decodePersistedAssistantToolMessage((await db.message.findFirstOrThrow({ where: { chatId: run.chatId!, role: "assistant" } })).content);
  assert.equal(saved?.contextBudget?.overflowRecoveries, 1);
});

test("a second refusal after recovery is reported instead of retried again", async t => {
  let calls = 0;
  t.mock.method(languageModel, "doGenerate", async () => summaryAnswer("Earlier work."));
  t.mock.method(languageModel, "doStream", async () => { calls++; throw Object.assign(new Error("maximum context length exceeded"), { statusCode: 400 }); });
  const response = await route.POST(request({ messages: [ui("r-1", "user", "First"), ui("r-2", "assistant", "One"), ui("r-3", "user", "Second"), ui("r-4", "assistant", "Two"), ui("r-5", "user", "Third")] }));
  await response.text();
  assert.equal(calls, 2);
  assert.equal((await db.agentRun.findFirstOrThrow({ orderBy: { startedAt: "desc" } })).status, "failed");
});

test("the compaction tool is offered to every chat, including assistants with a restricted tool list", async () => {
  const { createChatToolSet } = await import("@/tools/catalog");
  const { getToolDescriptor } = await import("@/tools/builtins");
  const restricted = await createChatToolSet({ modelRef: CHAT_MODEL_REF, toolIds: ["createTask"] });
  assert.ok("compactContext" in restricted);
  assert.ok(!("webSearch" in restricted));
  assert.equal(getToolDescriptor("compactContext")?.manual.enabled, false, "it acts on a running chat, so it is not a manual tool");
});
