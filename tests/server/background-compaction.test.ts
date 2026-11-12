import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { jsonSchema, type ModelMessage, type ToolSet, type UIMessage } from "ai";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { seedTestModelPreferences, CHAT_MODEL_REF } from "../helpers/model-library";
import { languageModel, resetProviderState } from "../helpers/model-provider";
import { wireText } from "../helpers/wire-text";

const cleanup = createTestDatabase();
process.env.RIA_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const chatRoute = await import("@/app/api/chat/route");
const toolRoute = await import("@/app/api/tools/run/route");
const { compactAfterTurn, compactionsSettled } = await import("@/lib/chat/compaction");
const { exclusiveDataOperation } = await import("@/lib/server/data-operations");
const { auxiliaryModel, getModelPreferences, modelInLibrary, removeModel, saveModelPreferences } = await import("@/lib/models/preferences");
const { preferencesSchema } = await import("@/lib/models/preferences-schema");
const { commitTurnFold } = await import("@/lib/chat/summary");
const { buildChatContext } = await import("@/lib/chat/context");
const { EMPTY_SUMMARY_STATE, foldIntoState } = await import("@/lib/chat/compaction-state");
const { changedFiles, restoredContext, RESTORED_SHARE } = await import("@/lib/chat/compaction-restore");
const restoredText = async (params: Parameters<typeof restoredContext>[0]) => (await restoredContext(params)).text;
const { lookupConversationHistory } = await import("@/lib/chat/history-lookup");
const { recordedFacts, toolCallsIn } = await import("@/lib/chat/compaction-state");
const { summarizeWithAuxiliary } = await import("@/lib/chat/task-summary");
const { conversationCalibration, recordContextCalibration } = await import("@/lib/models/context-calibration");
const { estimateTextTokens, MIN_CALIBRATION } = await import("@/lib/models/context-budget");
const { historicalToolText, shownExcerptCharacters, summaryRecordCharacters } = await import("@/lib/chat/tool-history");
const { taskStateInstructions } = await import("@/lib/chat/task-summary");
const { encodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
const { createGrant, revokeGrant } = await import("@/lib/local-files/grants");
const { buildSystemPrompt, conversationWindow } = await import("@/lib/chat/model-context");
const { createStepContext } = await import("@/lib/chat/step-context");
const { contextBudget } = await import("@/lib/models/context-budget");
const { getToolDescriptor } = await import("@/tools/builtins");
const { mapStoredMessagesToUI } = await import("@/features/chat/page-utils");

const readProjectHash = (root: string, name: string) => createHash("sha256").update(readFileSync(join(root, name))).digest("hex").slice(0, 16);
const OTHER_MODEL = { providerId: "openrouter" as const, modelId: "google/gemini-3-flash-preview" };

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {});
  resetProviderState(); globalThis.__riaRateLimitStore?.clear();
  process.env.APP_RUNTIME = "test"; process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  await compactionsSettled();
  await db.chat.deleteMany({}); await db.modelContextCalibration.deleteMany({});
  await seedTestModelPreferences(db);
});
after(async () => { await compactionsSettled(); await db.$disconnect(); cleanup(); });

async function capacity(contextLength: number, maxOutputTokens = 2048) {
  const settings = await seedTestModelPreferences(db);
  settings.library = settings.library.map(model => model.modelId === CHAT_MODEL_REF.modelId ? { ...model, contextLength } : model);
  settings.contextLimits = { [`openrouter:${CHAT_MODEL_REF.modelId}`]: { contextLength, maxOutputTokens } };
  await db.workspacePreference.update({ where: { id: "local" }, data: { settings } });
}
const { stopTurn } = await import("@/lib/chat/live-turns");
const post = (body: unknown, signal?: AbortSignal) => chatRoute.POST(new NextRequest("http://localhost/api/chat", { method: "POST", signal, headers: { cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify(body) }));
const runTool = (body: unknown) => toolRoute.POST(new NextRequest("http://localhost/api/tools/run", { method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify(body) }));
const summaryAnswer = (text: string) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: "stop" }, usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } }, warnings: [] });
function answers(t: TestContext, text = "Answered.") {
  const prompts: string[] = [];
  t.mock.method(languageModel, "doStream", async options => {
    prompts.push(JSON.stringify(options.prompt));
    return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "a" }); controller.enqueue({ type: "text-delta", id: "a", delta: text }); controller.enqueue({ type: "text-end", id: "a" });
      controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } } });
      controller.close();
    } }) };
  });
  return prompts;
}
/** A summary call that waits until released, and what it was asked. */
function gatedSummary(t: TestContext) {
  const inputs: string[] = [];
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(languageModel, "doGenerate", async options => {
    inputs.push(JSON.stringify(options.prompt));
    started();
    await gate;
    return summaryAnswer("Earlier: the user is planning a trip to Lisbon.");
  });
  return { inputs, release, reached };
}
const words = (seed: string, count = 900) => `${seed} ${"lorem ipsum dolor sit amet ".repeat(count)}`;
/** A stored conversation long enough for the window to drop its older turns. */
async function longChat(turns = 8) {
  const chat = await db.chat.create({ data: { title: "Long" } });
  const history: UIMessage[] = [];
  for (let turn = 0; turn < turns; turn++) for (const role of ["user", "assistant"] as const) {
    const id = `${role}-${turn}`, text = words(`${role} turn ${turn} marker-${turn}`);
    await db.message.create({ data: { chatId: chat.id, role, clientMessageId: id, content: text, createdAt: new Date(2026, 10, 1, 0, turn, role === "user" ? 0 : 1) } });
    history.push({ id, role, parts: [{ type: "text", text }] });
  }
  return { chat, history };
}
const loaded = async (chatId: string) => mapStoredMessagesToUI(await db.message.findMany({ where: { chatId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).uiMessages;
const latest = (text = "What next?"): UIMessage => ({ id: "latest", role: "user", parts: [{ type: "text", text }] });
const firstChunk = async (reader: ReadableStreamDefaultReader<Uint8Array>) => new TextDecoder().decode((await reader.read()).value);
const readAll = async (reader: ReadableStreamDefaultReader<Uint8Array>) => { let text = ""; for (;;) { const item = await reader.read(); if (item.done) return text; text += new TextDecoder().decode(item.value); } };

test("a conversation with no summary starts its response first, says it is organizing, and answers from the summary", async t => {
  await capacity(32_000);
  const { chat, history } = await longChat();
  const summary = gatedSummary(t), prompts = answers(t);
  const response = await post({ chatId: chat.id, messages: [...history, latest()] });
  assert.equal(response.status, 200, "the response starts without the summary");
  const reader = response.body!.getReader();
  assert.match(await firstChunk(reader), /"data-context-status".*"organizing":true/);
  await summary.reached;
  assert.equal(prompts.length, 0, "the answer waits for the summary here");
  summary.release();
  const rest = await readAll(reader);
  assert.match(rest, /"organizing":false/);
  assert.match(rest, /Answered/);
  assert.match(prompts[0], /planning a trip to Lisbon/);
  assert.doesNotMatch(prompts[0], /Incomplete excerpts/, "the summary covers everything the window dropped");
  assert.match((await db.chat.findUniqueOrThrow({ where: { id: chat.id } })).summary!, /Lisbon/);
  assert.equal((await db.agentRun.findFirstOrThrow({ where: { chatId: chat.id }, orderBy: { startedAt: "desc" } })).status, "succeeded");
});

test("when the summary cannot be written, the answer still comes, from labelled excerpts", async t => {
  await capacity(32_000);
  const { chat, history } = await longChat();
  t.mock.method(languageModel, "doGenerate", async () => { throw new Error("summary provider down"); });
  const prompts = answers(t);
  const wire = await wireText(await post({ chatId: chat.id, messages: [...history, latest()] }));
  assert.match(wire, /Answered/);
  assert.doesNotMatch(wire, /"type":"error"/);
  assert.match(prompts[0], /Incomplete excerpts/);
  assert.equal((await db.chat.findUniqueOrThrow({ where: { id: chat.id } })).summary, null);
});

test("stopping while context is being organized closes the run and the summary still lands for the next request", async t => {
  await capacity(32_000);
  const { chat, history } = await longChat();
  const summary = gatedSummary(t), prompts = answers(t);
  const response = await post({ chatId: chat.id, messages: [...history, latest()] });
  const reader = response.body!.getReader();
  await firstChunk(reader);
  await summary.reached;
  // The service holds the turn; stopping it there is what ends it.
  assert.equal(stopTurn(chat.id), true);
  await reader.cancel().catch(() => null);
  await t.waitFor(async () => assert.equal((await db.agentRun.findFirstOrThrow({ where: { chatId: chat.id } })).status, "cancelled"));
  assert.equal(prompts.length, 0, "a stopped turn asks the model nothing");
  summary.release();
  await compactionsSettled();
  assert.match((await db.chat.findUniqueOrThrow({ where: { id: chat.id } })).summary!, /Lisbon/);
});

test("a conversation with an older summary answers at once from it and excerpts, and a finished turn catches up in the background", async t => {
  await capacity(32_000);
  const { chat, history } = await longChat(12);
  const covered = await db.message.findFirstOrThrow({ where: { chatId: chat.id, clientMessageId: "assistant-1" } });
  await db.chat.update({ where: { id: chat.id }, data: { summary: "[Task state v1]\nOld summary of the first turns.", summaryUpToMessageId: covered.id, summaryRevision: 0, historyRevision: 0 } });
  const summary = gatedSummary(t), prompts = answers(t);
  const response = await post({ chatId: chat.id, messages: [...history, latest()] });
  const wire = await wireText(response);
  assert.match(wire, /Answered/, "the answer did not wait for the gated summary");
  assert.doesNotMatch(wire, /data-context-status/);
  assert.match(prompts[0], /Old summary of the first turns/);
  assert.match(prompts[0], /Incomplete excerpts/, "the gap behind the summary is filled with excerpts");
  await summary.reached;
  summary.release();
  await compactionsSettled();
  const saved = await db.chat.findUniqueOrThrow({ where: { id: chat.id } });
  assert.match(saved.summary!, /Lisbon/);
  assert.notEqual(saved.summaryUpToMessageId, covered.id, "coverage moved forward");
  assert.match(summary.inputs[0], /Old summary of the first turns/, "built on the earlier summary");
});

test("a summary survives the turns after it: saving an answer leaves it, and only rewriting what it covers clears it", async () => {
  const { saveChatMessage } = await import("@/lib/chat/store");
  const { chat } = await longChat(3);
  const covered = await db.message.findFirstOrThrow({ where: { chatId: chat.id, clientMessageId: "assistant-1" } });
  await db.chat.update({ where: { id: chat.id }, data: { summary: "Kept", summaryUpToMessageId: covered.id, summaryRevision: 0, summaryModelId: "m" } });
  const read = () => db.chat.findUniqueOrThrow({ where: { id: chat.id } });
  // A new answer, saved the way every turn saves one.
  await saveChatMessage({ chatId: chat.id, role: "assistant", content: "New answer", clientMessageId: "new-answer", updateExisting: true });
  assert.equal((await read()).summary, "Kept");
  assert.equal((await read()).historyRevision, 0, "appending changes no history");
  // An answer continuing after an approval rewrites a message the summary ends before.
  await saveChatMessage({ chatId: chat.id, role: "assistant", content: "Continued answer", clientMessageId: "new-answer", updateExisting: true });
  const continued = await read();
  assert.equal(continued.summary, "Kept");
  assert.equal(continued.historyRevision, 1, "a summary still being written from the old text is refused");
  assert.equal(continued.summaryRevision, 1, "the stored one stays valid");
  // Rewriting what it covers makes it wrong.
  await saveChatMessage({ chatId: chat.id, role: "assistant", content: "Edited", clientMessageId: "assistant-0", updateExisting: true });
  const edited = await read();
  assert.equal(edited.summary, null);
  assert.equal(edited.summaryUpToMessageId, null);
  assert.equal(edited.historyRevision, 2);
});

test("a finished turn folds only once the window is nearly used, and only one job runs per conversation", async t => {
  await capacity(32_000);
  const summary = gatedSummary(t);
  const short = await db.chat.create({ data: { title: "Short" } });
  await db.message.create({ data: { chatId: short.id, role: "user", clientMessageId: "u", content: "Hello" } });
  assert.equal(await compactAfterTurn({ chatId: short.id, modelRef: CHAT_MODEL_REF }), null);
  assert.equal(summary.inputs.length, 0, "a short conversation costs no model call");
  const { chat } = await longChat();
  const first = compactAfterTurn({ chatId: chat.id, modelRef: CHAT_MODEL_REF });
  const second = compactAfterTurn({ chatId: chat.id, modelRef: CHAT_MODEL_REF });
  assert.equal(first, second, "the same job");
  await summary.reached;
  summary.release();
  assert.ok(await first);
  const calls = summary.inputs.length;
  const saved = await db.chat.findUniqueOrThrow({ where: { id: chat.id } });
  assert.ok(saved.summaryUpToMessageId);
  // Done now: nothing new to fold, so no further call.
  await compactAfterTurn({ chatId: chat.id, modelRef: CHAT_MODEL_REF });
  assert.equal(summary.inputs.length, calls);
});

test("a job cannot overwrite a history that moved on, a deleted conversation, or run through a restore", async t => {
  await capacity(32_000);
  const edited = await longChat();
  const summary = gatedSummary(t);
  const job = compactAfterTurn({ chatId: edited.chat.id, modelRef: CHAT_MODEL_REF });
  await summary.reached;
  await assert.rejects(exclusiveDataOperation(async () => null), { code: "CONFLICT" }, "a restore waits for the job to write");
  await db.chat.update({ where: { id: edited.chat.id }, data: { historyRevision: { increment: 1 } } });
  summary.release();
  assert.equal(await job, null);
  assert.equal((await db.chat.findUniqueOrThrow({ where: { id: edited.chat.id } })).summary, null);
  assert.equal(await exclusiveDataOperation(async () => "free"), "free");

  t.mock.restoreAll();
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {});
  const removed = await longChat();
  const again = gatedSummary(t);
  const second = compactAfterTurn({ chatId: removed.chat.id, modelRef: CHAT_MODEL_REF });
  await again.reached;
  await db.chat.delete({ where: { id: removed.chat.id } });
  again.release();
  assert.equal(await second, null);
});

test("the auxiliary model does the summaries when chosen, and the conversation's model otherwise", async t => {
  await capacity(32_000);
  assert.deepEqual(await auxiliaryModel(CHAT_MODEL_REF), CHAT_MODEL_REF, "none chosen");
  const current = await getModelPreferences();
  assert.equal(preferencesSchema.safeParse({ ...current, auxiliary: { providerId: "openrouter", modelId: "not/in-library" } }).success, false);
  await saveModelPreferences({ ...current, auxiliary: OTHER_MODEL });
  assert.deepEqual(await auxiliaryModel(CHAT_MODEL_REF), OTHER_MODEL);
  const { chat } = await longChat();
  t.mock.method(languageModel, "doGenerate", async () => summaryAnswer("Earlier: Lisbon."));
  await compactAfterTurn({ chatId: chat.id, modelRef: CHAT_MODEL_REF });
  assert.equal((await db.chat.findUniqueOrThrow({ where: { id: chat.id } })).summaryModelId, `${OTHER_MODEL.providerId}:${OTHER_MODEL.modelId}`);
  await removeModel(OTHER_MODEL);
  assert.equal((await getModelPreferences()).auxiliary, null, "removing it from the library clears the choice");
  assert.deepEqual(await auxiliaryModel(CHAT_MODEL_REF), CHAT_MODEL_REF);
  const { auxiliary: _dropped, ...older } = await getModelPreferences();
  assert.equal(preferencesSchema.parse(older).auxiliary, null, "settings saved before this existed still read");
});

test("a person can fold a conversation from the slash menu, naming what to keep, and the next request starts from it", async t => {
  await capacity(200_000);
  const { chat, history } = await longChat(4);
  const inputs: { system: string; prompt: string }[] = [];
  t.mock.method(languageModel, "doGenerate", async options => {
    inputs.push({ system: JSON.stringify(options.prompt[0]), prompt: JSON.stringify(options.prompt) });
    return summaryAnswer("Earlier: agreed on Lisbon in May.");
  });
  const run = async (input: Record<string, unknown>, chatId: string = chat.id) => { const response = await runTool({ tool: "compactContext", input, chatId }); return { status: response.status, body: await response.json() }; };
  const done = await run({ focus: "keep the travel dates" });
  assert.equal(done.status, 200);
  assert.equal(done.body.data.status, "compacted");
  assert.equal(inputs.length, 1);
  assert.match(inputs[0].system, /keep the travel dates/);
  assert.match(inputs[0].prompt, /marker-2/, "turns before the latest exchange are folded");
  assert.doesNotMatch(inputs[0].prompt, /marker-3/, "the latest exchange is kept as it is");
  // Nothing new since: asking again costs no call.
  assert.equal((await run({})).body.data.status, "nothing");
  assert.equal(inputs.length, 1);
  // The window now starts after the summary, though the browser still sends every turn.
  const prompts = answers(t);
  await wireText(await post({ chatId: chat.id, messages: [...history, latest()] }));
  assert.match(prompts[0], /agreed on Lisbon in May/);
  assert.doesNotMatch(prompts[0], /marker-1/);
  assert.match(prompts[0], /marker-3/);

  const single = await db.chat.create({ data: { title: "New" } });
  await db.message.create({ data: { chatId: single.id, role: "user", clientMessageId: "only", content: "Hello" } });
  assert.equal((await run({}, single.id)).body.data.status, "nothing", "nothing to fold in a first exchange");
  assert.equal((await run({}, "missing-chat")).status, 404);
  const failing = await longChat(3);
  t.mock.restoreAll();
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {});
  t.mock.method(languageModel, "doGenerate", async () => { throw new Error("provider down"); });
  assert.equal((await run({}, failing.chat.id)).status, 502, "a person who asked hears that it failed");
  assert.equal(getToolDescriptor("compactContext")?.surface.template, "always");
});

test("a later turn gets the real tool records in full, and a call that never finished stays only as a note", async t => {
  const chat = await db.chat.create({ data: { title: "Records" } });
  const output = { body: `FULL-OUTPUT ${"file contents line\n".repeat(600)}END-OF-OUTPUT` };
  await db.message.create({ data: { chatId: chat.id, role: "user", clientMessageId: "u1", content: "Read it", createdAt: new Date(1000) } });
  await db.message.create({ data: { chatId: chat.id, role: "assistant", clientMessageId: "a1", createdAt: new Date(2000), content: encodePersistedAssistantToolMessage({ type: "assistant-tool-message", text: "It says this.", reasoning: "PRIVATE-REASONING", tools: [
    { toolName: "searchKnowledge", toolCallId: "done", state: "output-available", input: { query: "q" }, output, approval: { id: "settled", approved: true } },
    { toolName: "createTask", toolCallId: "never-finished", state: "input-available", input: { title: "x", prompt: "Do it.", cron: "0 9 * * *", timeZone: "UTC" } },
  ] }) } });
  const prompts = answers(t);
  await wireText(await post({ chatId: chat.id, messages: [...await loaded(chat.id), { id: "u2", role: "user", parts: [{ type: "text", text: "And then?" }] }] }));
  const prompt = JSON.parse(prompts[0]) as { role: string; content: unknown }[];
  const roles = prompt.map(message => message.role);
  assert.deepEqual(roles.slice(1), ["user", "assistant", "tool", "assistant", "user"], "calls, then results, then the answer");
  assert.match(prompts[0], /END-OF-OUTPUT/, "nothing is cut while there is room");
  assert.doesNotMatch(prompts[0], /PRIVATE-REASONING/);
  assert.doesNotMatch(prompts[0], /"toolCallId":"never-finished"/);
  assert.match(prompts[0], /It says this/);
  assert.match(prompts[0], /never-finished/, "it is still mentioned as a note");
  assert.doesNotMatch(JSON.stringify(prompt.at(-1)), /Incomplete excerpts/);
});

test("DeepSeek gets stored reasoning back with a tool turn, and a model without tools gets text", () => {
  const turn: UIMessage = { id: "a", role: "assistant", parts: [
    { type: "reasoning", text: "thought", state: "done" }, { type: "text", text: "Done" },
    { type: "tool-webSearch", toolCallId: "c", state: "output-available", input: {}, output: { hits: 1 } },
  ] as UIMessage["parts"] };
  const ask: UIMessage = { id: "u", role: "user", parts: [{ type: "text", text: "go" }] };
  const earlier: UIMessage = { id: "u0", role: "user", parts: [{ type: "text", text: "before" }] };
  const types = (options: Parameters<typeof buildChatContext>[1], message = turn) => buildChatContext([earlier, message, ask], options).messages[1].parts.map(part => part.type);
  assert.deepEqual(types({ toolRecords: { replaysReasoning: true } }), ["reasoning", "tool-webSearch", "step-start", "text"]);
  assert.deepEqual(types({ toolRecords: {} }), ["tool-webSearch", "step-start", "text"]);
  assert.deepEqual(types({}), ["text"], "without tools, a record of them would be refused");
  const noReasoning = { ...turn, parts: turn.parts.filter(part => part.type !== "reasoning") };
  assert.deepEqual(types({ toolRecords: { replaysReasoning: true } }, noReasoning), ["tool-webSearch", "step-start", "text"], "DeepSeek accepts a tool turn without reasoning, so the record stays");
  const noText = { ...turn, parts: turn.parts.filter(part => part.type === "tool-webSearch") };
  const ending = buildChatContext([earlier, noText, ask], { toolRecords: {} }).messages[1].parts.at(-1)!;
  assert.equal(ending.type, "text", "a turn always ends in text, so it cannot read as a tool loop still running");
});

test("there is one summary: it leads the prompt, and tool work folded during a turn is not sent or summarized again", async t => {
  const chat = await db.chat.create({ data: { title: "One summary" } });
  await db.message.create({ data: { chatId: chat.id, role: "user", clientMessageId: "u1", content: "Run them", createdAt: new Date(1000) } });
  await db.message.create({ data: { chatId: chat.id, role: "assistant", clientMessageId: "a1", createdAt: new Date(2000), content: encodePersistedAssistantToolMessage({ type: "assistant-tool-message", text: "Both ran.", tools: [
    { toolName: "searchKnowledge", toolCallId: "folded-call", state: "output-available", input: { query: "old" }, output: { body: "FOLDED-RESULT" } },
    { toolName: "searchKnowledge", toolCallId: "kept-call", state: "output-available", input: { query: "new" }, output: { body: "KEPT-RESULT" } },
  ] }) } });
  assert.equal(await commitTurnFold({ chatId: chat.id, expected: null, summary: "[Task state v1]\nFolded the first search.", change: { calls: ["folded-call"], toolCalls: [{ toolName: "readProjectFile", input: { grantId: "g", path: "a.ts" } }, { toolName: "readPluginSkill", input: { packageId: "pkg" } }] }, modelId: "openrouter:m" }), true);
  const saved = await db.chat.findUniqueOrThrow({ where: { id: chat.id } });
  assert.equal(saved.summaryUpToMessageId, null, "it ends at no message yet");
  assert.deepEqual(JSON.parse(saved.summaryState!), { calls: ["folded-call"], files: [{ grantId: "g", path: "a.ts" }], skills: ["pkg"], log: [] });
  assert.equal(await commitTurnFold({ chatId: chat.id, expected: null, summary: "stale", change: {}, modelId: "m" }), false, "a fold from before another write is refused");
  assert.equal((await db.chat.findUniqueOrThrow({ where: { id: chat.id } })).summary, "[Task state v1]\nFolded the first search.");

  const prompts = answers(t);
  await wireText(await post({ chatId: chat.id, messages: [...await loaded(chat.id), { id: "u2", role: "user", parts: [{ type: "text", text: "Next?" }] }] }));
  const prompt = JSON.parse(prompts[0]) as { role: string; content: { type: string; text?: string }[] }[];
  assert.equal(prompt[1].role, "user");
  assert.match(JSON.stringify(prompt[1]), /Summary of earlier conversation[\s\S]*Folded the first search/);
  assert.doesNotMatch(prompts[0], /FOLDED-RESULT/);
  assert.match(prompts[0], /KEPT-RESULT/);

  // Folding the stored turn later skips what the summary already holds.
  const inputs: string[] = [];
  t.mock.method(languageModel, "doGenerate", async options => { inputs.push(JSON.stringify(options.prompt)); return summaryAnswer("Everything so far."); });
  const response = await runTool({ tool: "compactContext", input: {}, chatId: chat.id });
  assert.equal((await response.json()).data.status, "compacted");
  assert.doesNotMatch(inputs[0], /FOLDED-RESULT/);
  assert.match(inputs[0], /KEPT-RESULT/);
  assert.match(inputs[0], /Folded the first search/, "built on the summary");
  const after = await db.chat.findUniqueOrThrow({ where: { id: chat.id } });
  assert.ok(after.summaryUpToMessageId, "now it ends at a message");
  assert.deepEqual(JSON.parse(after.summaryState!).skills, ["pkg"], "what to put back carries over");
});

test("after a fold the files in use come back as they are now, within bounds, and only from this conversation's folder", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ria-restore-")));
  try {
    writeFileSync(join(root, "small.ts"), "export const answer = 42;\n");
    writeFileSync(join(root, "large.ts"), "const x = 1234567890;\n".repeat(2000));
    writeFileSync(join(root, "shown.ts"), "already in the conversation\n");
    const grant = await createGrant({ path: root });
    const state = foldIntoState(EMPTY_SUMMARY_STATE, { toolCalls: ["small.ts", "large.ts", "shown.ts", "deleted.ts"].map(path => ({ toolName: "readProjectFile", input: { grantId: grant.id, path } })).concat([{ toolName: "readProjectFile", input: { grantId: "another-folder", path: "other.ts" } }]) });
    const inputTokens = 181_000;
    const inUse = new Set(["shown.ts"]);
    const text = await restoredText({ state, inUse, workspaceId: grant.id, allowFiles: true, allowSkills: true, inputTokens });
    assert.match(text, /File small\.ts as it was when this summary was written:\nexport const answer = 42/);
    assert.match(text, /Referenced file: large\.ts/);
    assert.doesNotMatch(text, /1234567890/, "a large file comes back as a reference");
    assert.doesNotMatch(text, /shown\.ts|already in the conversation/, "what is still in the conversation is not repeated");
    assert.doesNotMatch(text, /deleted\.ts|other\.ts/);
    assert.equal(await restoredText({ state, inUse, workspaceId: grant.id, allowFiles: false, allowSkills: true, inputTokens }), "", "a template without file access gets none");
    assert.equal(await restoredText({ state, inUse, workspaceId: null, allowFiles: true, allowSkills: true, inputTokens }), "");
    const many = foldIntoState(EMPTY_SUMMARY_STATE, { toolCalls: Array.from({ length: 8 }, (_, index) => { writeFileSync(join(root, `f${index}.ts`), `file ${index}\n`); return { toolName: "editProjectFile", input: { grantId: grant.id, path: `f${index}.ts` } }; }) });
    const recent = await restoredText({ state: many, inUse: new Set(), workspaceId: grant.id, allowFiles: true, allowSkills: false, inputTokens });
    assert.equal(recent.match(/as it was when this summary was written/g)?.length, 5, "the five most recent");
    assert.match(recent, /f7\.ts/); assert.doesNotMatch(recent, /f2\.ts/);
    // On a small window the same files cannot all come back, or the request could never be sent.
    for (let index = 0; index < 5; index++) writeFileSync(join(root, `f${index + 3}.ts`), `const value = ${"1234567890".repeat(100)};\n`);
    const tight = await restoredText({ state: many, inUse: new Set(), workspaceId: grant.id, allowFiles: true, allowSkills: false, inputTokens: 15_000 });
    assert.ok(estimateTextTokens(tight) <= 15_000 * RESTORED_SHARE + 200, `used ${estimateTextTokens(tight)}`);
    assert.match(tight, /Referenced file/, "what does not fit goes back as a path");
    assert.equal(tight.match(/f\d\.ts/g)?.length, 5, "every file is still named");
    await revokeGrant(grant.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the skills used before a fold come back within their limits, and only while they are enabled", async () => {
  const manifest = (id: string, size: number) => ({ format: "ria-plugin", schemaVersion: 1, id, name: id, version: "1.0.0", description: "Fixture", author: "Test", skills: [{ id: "main", name: `Skill ${id}`, description: "Fixture", instructions: `START-OF-${id} ${"steps to follow ".repeat(size)}` }], connections: [] });
  await db.pluginPackage.deleteMany({});
  await db.pluginPackage.create({ data: { id: "p1", packageId: "pkg.small", manifest: manifest("pkg.small", 20), digest: "a", enabled: true } });
  await db.pluginPackage.create({ data: { id: "p2", packageId: "pkg.large", manifest: manifest("pkg.large", 350), digest: "b", enabled: true } });
  await db.pluginPackage.create({ data: { id: "p3", packageId: "pkg.disabled", manifest: manifest("pkg.disabled", 20), digest: "c", enabled: false } });
  const state = foldIntoState(EMPTY_SUMMARY_STATE, { toolCalls: ["pkg.small", "pkg.large", "pkg.disabled", "pkg.missing"].map(packageId => ({ toolName: "readPluginSkill", input: { packageId } })) });
  const restore = (inputTokens: number) => restoredText({ state, inUse: new Set(), workspaceId: null, allowFiles: true, allowSkills: true, inputTokens });
  const text = await restore(181_000);
  assert.match(text, /START-OF-pkg\.small/);
  assert.match(text, /START-OF-pkg\.large/);
  assert.doesNotMatch(text, /pkg\.disabled|pkg\.missing/, "a skill since disabled is not brought back");
  assert.equal(await restoredText({ state, inUse: new Set(), workspaceId: null, allowFiles: true, allowSkills: false, inputTokens: 181_000 }), "");
  const tight = await restore(2_000);
  assert.ok(estimateTextTokens(tight) <= 2_000 * RESTORED_SHARE + 80, `used ${estimateTextTokens(tight)}`);
  assert.match(tight, /cut to fit/);
  await db.pluginPackage.deleteMany({});
});

test("a step that still does not fit gives up what was put back, then shortens the newest result, before it is refused", async () => {
  const result = (id: string, size: number): ModelMessage[] => [
    { role: "assistant", content: [{ type: "tool-call", toolName: "readProjectFile", toolCallId: id, input: { path: `${id}.txt` } }] },
    { role: "tool", content: [{ type: "tool-result", toolName: "readProjectFile", toolCallId: id, output: { type: "json", value: { text: `HEAD-${id} ${"1234567890".repeat(size)} TAIL-${id}` } } }] },
  ];
  const manager = createStepContext({ budget: contextBudget({ contextLength: 10_000 }), system: "system", summarize: async () => "state", restoreAfterFold: async () => `RESTORED ${"1234567890".repeat(120)}` });
  const { messages } = await manager.prepare([{ role: "user", content: "go" }, ...result("old", 400), ...result("new", 900)]);
  const text = JSON.stringify(messages);
  assert.doesNotMatch(text, /RESTORED/, "what can be read again goes first");
  assert.match(text, /HEAD-new/); assert.match(text, /TAIL-new/);
  assert.ok(text.length < 20_000, "the newest result is an excerpt now");
  assert.ok(manager.report.estimatedInputTokens <= manager.report.budget.inputTokens);
});

test("what was put back sits under the summary, unchanged from request to request, so a prompt cache keeps matching it", async () => {
  const seen: Set<string>[] = [];
  const history = (turn: string): ModelMessage[] => [
    { role: "assistant", content: [{ type: "tool-call", toolName: "readProjectFile", toolCallId: "still", input: { path: "shown.ts" } }] },
    { role: "tool", content: [{ type: "tool-result", toolName: "readProjectFile", toolCallId: "still", output: { type: "json", value: { ok: true } } }] },
    { role: "user", content: turn },
  ];
  const request = async (turn: string) => {
    const manager = createStepContext({ budget: contextBudget({ contextLength: 200_000 }), system: "system", summarize: async () => "unused", handoff: { state: "the summary", calls: [] },
      restoreAfterFold: async inUse => { seen.push(inUse); return "File old.ts as it was when this summary was written:\nRESTORED-CONTENT"; } });
    const first = await manager.prepare(history(turn));
    await manager.prepare(history(turn));
    return first.messages;
  };
  const one = await request("first question"), two = await request("second question");
  assert.equal(one[0].content, two[0].content, "the opening message is the same on both requests");
  assert.match(one[0].content as string, /the summary[\s\S]*RESTORED-CONTENT/);
  assert.doesNotMatch(JSON.stringify(one.slice(1)), /RESTORED-CONTENT/, "it does not travel with the latest message");
  assert.deepEqual([...seen[0]], ["shown.ts"], "a file still in the conversation is not repeated");
  assert.equal(seen.length, 2, "read once per request, not on every step");
  const none = createStepContext({ budget: contextBudget({ contextLength: 200_000 }), system: "system", summarize: async () => "unused", restoreAfterFold: async () => "RESTORED-CONTENT" });
  assert.doesNotMatch(JSON.stringify((await none.prepare(history("hello"))).messages), /RESTORED-CONTENT/, "with no summary nothing was folded away");
});

test("a fold reads the tool results themselves, not the excerpts the model was shown", async () => {
  const body = (name: string, rows: number) => Array.from({ length: rows }, (_, index) => `${name} row ${index}`).join("\n");
  const records: string[][] = [];
  const read = (id: string, rows: number): ModelMessage[] => [
    { role: "assistant", content: [{ type: "tool-call", toolName: "readProjectFile", toolCallId: id, input: { path: `${id}.txt` } }] },
    { role: "tool", content: [{ type: "tool-result", toolName: "readProjectFile", toolCallId: id, output: { type: "json", value: { text: body(id, rows) } } }] },
  ];
  const manager = createStepContext({ budget: contextBudget({ contextLength: 16_000 }), system: "system", summarize: async evidence => { records.push(evidence); return "state"; } });
  const { messages: shown } = await manager.prepare([{ role: "user", content: "go" }, ...read("alpha", 1_600), ...read("beta", 1_600), ...read("gamma", 10)]);
  assert.ok((manager.report.excerptedToolResults ?? 0) >= 1, "the model was shown excerpts");
  assert.equal(manager.report.compactions, 0, "which were enough for now");
  await manager.recoverFromOverflow();
  assert.ok(manager.report.compactions >= 1);
  const rows = (text: string) => text.match(/alpha row \d+/g)?.length ?? 0;
  assert.ok(rows(records.flat().join("\n")) > rows(JSON.stringify(shown)), "more of a result reaches the summary than the excerpt showed");
});

test("the provider's count is kept with the turn, and a conversation is scaled by its own latest request", async () => {
  const manager = createStepContext({ budget: contextBudget({ contextLength: 200_000 }), system: "system", summarize: async () => "state" });
  await manager.prepare([{ role: "user", content: "hello ".repeat(200) }]);
  manager.observeUsage(150);
  assert.equal(manager.report.measuredInputTokens, 150);
  assert.ok((manager.report.observedRatio ?? 0) > 0);
  await manager.prepare([{ role: "user", content: "hello ".repeat(200) }]);
  assert.equal(manager.report.measuredInputTokens, undefined, "a step not yet sent has no reported count");
  assert.ok(manager.report.observedRatio, "the ratio of the last step counted stands until another is");

  await recordContextCalibration(CHAT_MODEL_REF, 0.9);
  const budget = { contextWindow: 100, capacitySource: "configured", counting: "character-class-estimate" };
  const said = (observedRatio: number, modelLabel = `${CHAT_MODEL_REF.providerId}/${CHAT_MODEL_REF.modelId}`) => [{ id: "a", role: "assistant", parts: [], metadata: { modelLabel, contextBudget: { checks: 1, compactions: 0, degraded: false, estimatedInputTokens: 1, observedRatio, budget } } }] as UIMessage[];
  assert.equal(await conversationCalibration(CHAT_MODEL_REF, said(0.6)), 0.6, "its own request first");
  assert.equal(await conversationCalibration(CHAT_MODEL_REF, said(0.41)), 0.41, "Chinese as DeepSeek counts it");
  assert.equal(await conversationCalibration(CHAT_MODEL_REF, said(0.2)), MIN_CALIBRATION, "never below the bound");
  assert.equal(await conversationCalibration(CHAT_MODEL_REF, said(0.6, "openrouter/another-model")), 0.9, "another model's count says nothing about this one");
  assert.equal(await conversationCalibration(CHAT_MODEL_REF, []), 0.9, "a new conversation goes by what the model has seen");
});

test("the turn before a request stays in the window with its tool calls, however large their results", async () => {
  const stored = (id: string, size: number): UIMessage[] => [
    { id: `user-${id}`, role: "user", parts: [{ type: "text", text: `question ${id}` }] },
    { id: `answer-${id}`, role: "assistant", parts: [
      { type: "tool-readProjectFile", toolCallId: `read-${id}`, state: "output-available", input: { path: `${id}.txt` }, output: { text: "row 1234567 ".repeat(size) } },
      { type: "tool-runTerminalCommand", toolCallId: `run-${id}`, state: "output-available", input: { command: "COMMAND-RAN" }, output: { exitCode: 0 } },
      { type: "text", text: `reply ${id}` },
    ] as UIMessage["parts"] },
  ];
  const conversation = [...stored("old", 200), ...stored("large", 5_000), { id: "latest", role: "user", parts: [{ type: "text", text: "which command did you run?" }] } as UIMessage];
  const window = { maxTokens: 8_000, refillRatio: 0.3, maxMessages: conversation.length };
  const kept = buildChatContext(conversation, { ...window, toolRecords: { keepPreviousToolTurn: true } });
  assert.deepEqual(kept.messages.map(message => message.id), ["user-large", "answer-large", "latest"], "the older turn goes, the one before the request stays");
  assert.match(JSON.stringify(kept.messages), /COMMAND-RAN/);
  const dropped = buildChatContext(conversation, { ...window, toolRecords: {} });
  assert.deepEqual(dropped.messages.map(message => message.id), ["latest"], "a job folding older turns still folds it");

  const longText: UIMessage[] = [{ id: "user-text", role: "user", parts: [{ type: "text", text: "word ".repeat(9_000) }] }, ...stored("x", 10).slice(1), conversation.at(-1)!];
  assert.deepEqual(buildChatContext(longText, { ...window, toolRecords: { keepPreviousToolTurn: true } }).messages.map(message => message.id), ["latest"], "text that cannot be shortened may still drop out");

  const foldedAway = buildChatContext(conversation, { ...window, maxTokens: 12_000, refillRatio: undefined, toolRecords: { covered: ["read-large"] } });
  assert.equal(foldedAway.omittedMessages, 0, "calls the summary stands for take no room");
});

test("a conversation reloaded mid-turn shortens what the model has seen before paying for a fold", async () => {
  // A reload holds every call of the turn in one assistant message.
  const ids = ["one", "two", "three"];
  const packed: ModelMessage[] = [
    { role: "user", content: "read them, then run it" },
    { role: "assistant", content: [...ids.map(id => ({ type: "tool-call" as const, toolName: "readProjectFile", toolCallId: id, input: { path: `${id}.txt` } })), { type: "tool-call" as const, toolName: "runTerminalCommand", toolCallId: "pending", input: { command: "go" } }, { type: "tool-approval-request" as const, approvalId: "a", toolCallId: "pending" }] },
    { role: "tool", content: [...ids.map(id => ({ type: "tool-result" as const, toolName: "readProjectFile", toolCallId: id, output: { type: "json" as const, value: { text: `${id} ${"row 1234567 ".repeat(600)}` } } })), { type: "tool-approval-response" as const, approvalId: "a", approved: true }] },
  ];
  let summaries = 0;
  const manager = createStepContext({ budget: contextBudget({ contextLength: 20_000 }), system: "system", summarize: async () => { summaries++; return "state"; } });
  const { messages } = await manager.prepare(packed);
  assert.equal(summaries, 0, "excerpts were enough, so no model call");
  assert.ok((manager.report.excerptedToolResults ?? 0) >= 1);
  const resumed = JSON.stringify(messages);
  assert.ok((resumed.match(/row 1234567/g)?.length ?? 0) >= 600, "the result it read last, and was working from, is whole");
  assert.match(resumed, /three row 1234567/);
  const fresh: ModelMessage = { role: "tool", content: [{ type: "tool-result", toolName: "runTerminalCommand", toolCallId: "pending", output: { type: "json", value: { stdout: `NEW-OUTPUT ${"row 1234567 ".repeat(100)}` } } }] };
  const next = await manager.prepare([...packed, fresh]);
  assert.match(JSON.stringify(next.messages), /NEW-OUTPUT[\s\S]{1000}/, "what just arrived is whole");
  assert.ok(JSON.stringify(messages).includes("pending"));
});

test("a fold that would free little is not paid for while the step still fits", async () => {
  // Calls with small results: nothing to excerpt, and folding them frees little. The
  // bulk is the latest request, which no fold may touch.
  const call = (id: string): ModelMessage[] => [
    { role: "assistant", content: [{ type: "tool-call", toolName: "readProjectFile", toolCallId: id, input: { path: "a" } }] },
    { role: "tool", content: [{ type: "tool-result", toolName: "readProjectFile", toolCallId: id, output: { type: "json", value: { ok: true } } }] },
  ];
  let summaries = 0;
  const budget = contextBudget({ contextLength: 20_000 });
  const manager = createStepContext({ budget, system: "system", summarize: async () => { summaries++; return "state"; } });
  const request = "word ".repeat(Math.floor(budget.triggerTokens * 4 / 5));
  await manager.prepare([{ role: "user", content: request }, ...call("a"), ...call("b"), ...call("c")]);
  assert.ok(manager.report.estimatedInputTokens >= budget.triggerTokens && manager.report.estimatedInputTokens <= budget.inputTokens, "at the trigger, still within the input budget");
  assert.equal(summaries, 0);
  assert.equal(manager.report.compactions, 0);
});

test("a later request repeats what the earlier ones sent, step by step, so a provider's cache keeps matching", async t => {
  const prompts: unknown[][] = [];
  t.mock.method(languageModel, "doStream", async options => {
    prompts.push(structuredClone(options.prompt));
    const step = prompts.length;
    return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "a" }); controller.enqueue({ type: "text-delta", id: "a", delta: step === 1 ? "Let me look." : `Answer ${step}.` }); controller.enqueue({ type: "text-end", id: "a" });
      if (step === 1) controller.enqueue({ type: "tool-call", toolCallId: "lookup-1", toolName: "readConversationHistory", input: JSON.stringify({ query: "anything" }) });
      controller.enqueue({ type: "finish", finishReason: { unified: step === 1 ? "tool-calls" : "stop", raw: undefined }, usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } } });
      controller.close();
    } }) };
  });
  const chat = await db.chat.create({ data: { title: "Cache" } });
  const send = async (id: string, text: string) => {
    const rows = await db.message.findMany({ where: { chatId: chat.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const response = await post({ chatId: chat.id, model: CHAT_MODEL_REF, messages: [...mapStoredMessagesToUI(rows).uiMessages, { id, role: "user", parts: [{ type: "text", text }] }] });
    assert.equal(response.status, 200); await response.text(); await compactionsSettled();
  };
  await send("first", "First question");
  assert.equal(prompts.length, 2, "a tool step, then the answer");
  await send("second", "Second question");
  assert.equal(prompts.length, 3);
  const [, finalOfFirst, next] = prompts;
  assert.deepEqual(next.slice(0, finalOfFirst.length), finalOfFirst, "everything the first turn last sent is repeated exactly, its context block included");
  assert.match(JSON.stringify(next.slice(1, 2)), /Context for this request/);
  assert.match(JSON.stringify(next[finalOfFirst.length]), /Answer 2/, "then its answer");
});

test("an excerpt grows with the window, and on a small one frees most of a long file", () => {
  assert.equal(shownExcerptCharacters(13_000), 1_600);
  assert.equal(shownExcerptCharacters(113_000), 7_062);
  assert.equal(shownExcerptCharacters(1_000_000), 24_000);
  const lines = Array.from({ length: 150 }, (_, index) => ({ line: index + 1, text: `note ${index}: the rules for this part are kept beside the code they apply to and reviewed each quarter.` }));
  const part = { type: "tool-readProjectFile", toolCallId: "c", state: "output-available", input: {}, output: { path: "a.js", hash: "h", totalLines: 150, nextLine: null, lines } } as UIMessage["parts"][number];
  assert.ok(historicalToolText(part, shownExcerptCharacters(13_000)).length <= 1_600);
  assert.match(historicalToolText(part, shownExcerptCharacters(13_000)), /left out; read them with startLine/);
});

test("results of calls made together are sent in call order, however they finished", async () => {
  const manager = createStepContext({ budget: contextBudget({ contextLength: 200_000 }), system: "system", summarize: async () => "unused" });
  const result = (id: string) => ({ type: "tool-result" as const, toolName: "readProjectFile", toolCallId: id, output: { type: "json" as const, value: { id } } });
  const source: ModelMessage[] = [{ role: "user", content: "go" },
    { role: "assistant", content: ["slow", "fast"].map(id => ({ type: "tool-call" as const, toolName: "readProjectFile", toolCallId: id, input: {} })) },
    { role: "tool", content: [result("fast"), result("slow")] }];
  const { messages } = await manager.prepare(source);
  assert.deepEqual((messages[2].content as { toolCallId: string }[]).map(part => part.toolCallId), ["slow", "fast"]);
  assert.deepEqual((source[2].content as { toolCallId: string }[]).map(part => part.toolCallId), ["fast", "slow"], "the source messages are untouched");
});

test("what a request was sent with is kept only while it is small enough to send again", async () => {
  const { keepRequestContext } = await import("@/lib/chat/model-context");
  const chat = await db.chat.create({ data: { title: "Kept" } });
  await db.message.create({ data: { chatId: chat.id, role: "user", clientMessageId: "asked", content: "Question" } });
  await keepRequestContext(chat.id, "asked", ["small block"]);
  assert.equal((await db.message.findFirstOrThrow({ where: { chatId: chat.id } })).requestContext, JSON.stringify(["small block"]));
  await keepRequestContext(chat.id, "asked", ["x".repeat(70_000)]);
  assert.equal((await db.message.findFirstOrThrow({ where: { chatId: chat.id } })).requestContext, null);
});

test("a summary reads the conversation just sent, runs nothing, and falls back to the records", async t => {
  const conversation = { system: "the system prompt", messages: [{ role: "user", content: "Fix the ledger." }, { role: "assistant", content: "Done." }] as ModelMessage[], whole: ["FULL-RESULT-OF-AN-EXCERPT"],
    tools: { danger: { description: "Never run", inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => { throw new Error("A summary must not run a tool"); } } } as ToolSet };
  const prompts: string[] = [];
  let replies = [summaryAnswer("Handoff from the conversation.")];
  t.mock.method(languageModel, "doGenerate", async options => { prompts.push(JSON.stringify({ prompt: options.prompt, tools: options.tools, toolChoice: options.toolChoice })); return replies.shift() ?? summaryAnswer("Handoff from the records."); });
  const direct = await summarizeWithAuxiliary({ main: CHAT_MODEL_REF, records: ["record"], conversation });
  assert.match(direct.state, /Handoff from the conversation/);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Fix the ledger[\s\S]*Write the handoff now[\s\S]*FULL-RESULT-OF-AN-EXCERPT/, "the conversation first, then what to do, then what it only showed as excerpts");
  assert.match(prompts[0], /"toolChoice":\{"type":"none"\}/);

  // A model that calls a tool instead has written no summary, and nothing ran.
  replies = [{ ...summaryAnswer(""), content: [{ type: "tool-call" as const, toolCallId: "c", toolName: "danger", input: "{}" }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" } }] as unknown as typeof replies;
  prompts.length = 0;
  const fallback = await summarizeWithAuxiliary({ main: CHAT_MODEL_REF, records: ["record"], conversation });
  assert.match(fallback.state, /Handoff from the records/);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /New evidence to fold in/);

});

test("a fold offers the conversation only when nothing in it is still waiting for a result", async () => {
  const offered: unknown[] = [];
  const summarize = async (_records: string[], _previous: string, sent?: unknown) => { offered.push(sent); return "state"; };
  const pending: ModelMessage = { role: "assistant", content: [{ type: "tool-call", toolName: "runTerminalCommand", toolCallId: "waiting", input: { command: "go" } }, { type: "tool-approval-request", approvalId: "a", toolCallId: "waiting" }] };
  const bulky = (id: string): ModelMessage[] => [
    { role: "assistant", content: [{ type: "tool-call", toolName: "readProjectFile", toolCallId: id, input: { path: "a", script: `progress ${"0".repeat(22)}\n`.repeat(110) } }] },
    { role: "tool", content: [{ type: "tool-result", toolName: "readProjectFile", toolCallId: id, output: { type: "json", value: { ok: true } } }] },
  ];
  const go: ModelMessage = { role: "user", content: "go" };
  await createStepContext({ budget: contextBudget({ contextLength: 10_000 }), system: "system", summarize }).prepare([go, ...bulky("a"), ...bulky("b"), ...bulky("c")]);
  assert.ok(offered.at(-1), "a complete conversation is offered");
  offered.length = 0;
  await createStepContext({ budget: contextBudget({ contextLength: 10_000 }), system: "system", summarize }).prepare([go, ...bulky("a"), ...bulky("b"), ...bulky("c"), pending]);
  assert.ok(offered.length, "it still folds");
  assert.equal(offered.at(-1), undefined);
});

test("what was put back is read once and sent unchanged, and a later change is reported instead", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ria-restore-")));
  try {
    writeFileSync(join(root, "old.ts"), "first version\n");
    writeFileSync(join(root, "newer.ts"), "newer\n");
    utimesSync(join(root, "old.ts"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    const grant = await createGrant({ path: root });
    const state = foldIntoState(EMPTY_SUMMARY_STATE, { toolCalls: ["newer.ts", "old.ts"].map(path => ({ toolName: "readProjectFile", input: { grantId: grant.id, path }, output: { hash: "old" } })) });
    assert.deepEqual(state.files.map(file => file.hash), ["old", "old"]);
    const first = await restoredContext({ state, inUse: new Set(), workspaceId: grant.id, allowFiles: true, allowSkills: false, inputTokens: 181_000 });
    assert.ok(first.text.indexOf("File newer.ts") < first.text.indexOf("File old.ts"), "the most recently modified first, though it was read earlier");
    assert.equal(first.seen.length, 2);
    let reads = 0;
    const manager = createStepContext({ budget: contextBudget({ contextLength: 200_000 }), system: "system", summarize: async () => "unused", handoff: { state: "the summary", calls: [], restored: first.text }, restoreAfterFold: async () => { reads++; return "read again"; } });
    writeFileSync(join(root, "old.ts"), "second version\n");
    const { messages } = await manager.prepare([{ role: "user", content: "go" }]);
    assert.equal(reads, 0);
    assert.match(messages[0].content as string, /first version/, "the same bytes as when the summary was written");

    const seen = new Map(first.seen.map(file => [file.path, file.hash!]));
    const note = await changedFiles({ seen, grantId: grant.id });
    assert.match(note, /old\.ts \(changed\)/);
    assert.doesNotMatch(note, /newer\.ts/, "an unchanged file says nothing");
    rmSync(join(root, "newer.ts"));
    assert.match(await changedFiles({ seen, grantId: grant.id }), /newer\.ts \(no longer exists\)/);
    assert.equal(await changedFiles({ seen: new Map([["old.ts", readProjectHash(root, "old.ts")]]), grantId: grant.id }), "", "the model's own latest view is not news");
    await revokeGrant(grant.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an exact record of what was done travels under the summary, written by no model", async () => {
  const messages: ModelMessage[] = [
    { role: "assistant", content: [{ type: "tool-call", toolName: "runTerminalCommand", toolCallId: "run", input: { command: "npm test" } }, { type: "tool-call", toolName: "editProjectFile", toolCallId: "edit", input: { grantId: "g", path: "a.ts" } }] },
    { role: "tool", content: [{ type: "tool-result", toolName: "runTerminalCommand", toolCallId: "run", output: { type: "json", value: { exitCode: 2 } } }, { type: "tool-result", toolName: "editProjectFile", toolCallId: "edit", output: { type: "json", value: { path: "a.ts", created: false, added: 3, removed: 1, hash: "h1" } } }] },
  ];
  const state = foldIntoState({ ...EMPTY_SUMMARY_STATE, restored: "from the summary before" }, { toolCalls: toolCallsIn(messages) });
  assert.equal(state.restored, undefined, "what was put back belonged to the summary before");
  assert.equal(state.files[0].hash, "h1");
  assert.match(recordedFacts(state), /ran: npm test -> exit 2/);
  assert.match(recordedFacts(state), /edited: a\.ts \(\+3 -1\)/);
  assert.equal(recordedFacts(EMPTY_SUMMARY_STATE), "");
  const manager = createStepContext({ budget: contextBudget({ contextLength: 200_000 }), system: "system", summarize: async () => "unused", handoff: { state: "the summary", calls: [], restored: "" }, recorded: () => recordedFacts(state) });
  assert.match((await manager.prepare([{ role: "user", content: "go" }])).messages[0].content as string, /the summary\n\nRecorded by the application[\s\S]*npm test/);
});

test("the model can look up what a summary left out, only in its own conversation", async () => {
  const chat = await db.chat.create({ data: { title: "Lookup" } });
  const other = await db.chat.create({ data: { title: "Other" } });
  const long = `start ${"x".repeat(30_000)} PELICAN-7319`;
  await db.message.create({ data: { chatId: chat.id, role: "user", content: "Where is the access code?", createdAt: new Date(1000) } });
  await db.message.create({ data: { chatId: chat.id, role: "assistant", createdAt: new Date(2000), content: encodePersistedAssistantToolMessage({ type: "assistant-tool-message", text: "Found it.", tools: [{ toolCallId: "read-1", toolName: "readProjectFile", state: "output-available", input: { path: "a.txt" }, output: { text: long } }] }) } });
  await db.message.create({ data: { chatId: other.id, role: "user", content: "SECRET-OF-ANOTHER-CHAT" } });

  const found = await lookupConversationHistory(chat.id, { query: "pelican-7319" });
  assert.equal(found.found, true);
  assert.equal((found as { matches: { toolCallId?: string; snippet: string }[] }).matches[0].toolCallId, "read-1");
  assert.match((found as { matches: { snippet: string }[] }).matches[0].snippet, /PELICAN-7319/);
  assert.ok((found as { matches: { snippet: string }[] }).matches[0].snippet.length < 1_000, "a match is a snippet, not the record");

  const first = await lookupConversationHistory(chat.id, { toolCallId: "read-1" }) as { text: string; nextOffset: number };
  assert.equal(first.text.length, 20_000);
  const rest = await lookupConversationHistory(chat.id, { toolCallId: "read-1", offset: first.nextOffset }) as { text: string; nextOffset: number | null };
  assert.match(rest.text, /PELICAN-7319/);
  assert.equal(rest.nextOffset, null);
  assert.equal((await lookupConversationHistory(chat.id, { query: "SECRET-OF-ANOTHER-CHAT" })).found, false);
  assert.equal((await lookupConversationHistory(chat.id, { toolCallId: "elsewhere" })).found, false);
  await assert.rejects(lookupConversationHistory(null, { query: "x" }));

  const tool = getToolDescriptor("readConversationHistory")!;
  assert.equal(tool.surface.user, null, "it is the model's, not a person's");
  assert.equal(tool.surface.underlying, "model");
  assert.notEqual(tool.surface.template, "selectable", "and no template chooses it");
  const refused = await runTool({ tool: "readConversationHistory", input: { query: "PELICAN" }, chatId: chat.id });
  assert.equal(refused.status, 400, "a person cannot run it");
  const offered = await post({ chatId: chat.id, model: CHAT_MODEL_REF, invocation: { toolId: "readConversationHistory" }, messages: [{ id: "chose-lookup", role: "user", metadata: { invocation: { toolId: "readConversationHistory" } }, parts: [{ type: "text", text: "look it up" }] }] });
  assert.notEqual(offered.status, 200, "or choose it for the model");
  await offered.text();
  assert.equal(tool.inputSchema.safeParse({ query: "a", toolCallId: "b" }).success, false, "one way of looking at a time");
});

test("a finished turn decides from what the provider counted, not from the estimate", async t => {
  await capacity(32_000);
  const budget = contextBudget(await modelInLibrary("chat", CHAT_MODEL_REF), (await getModelPreferences()).contextLimits[`openrouter:${CHAT_MODEL_REF.modelId}`]);
  const chat = await db.chat.create({ data: { title: "Measured" } });
  const report = (measured: number) => ({ checks: 1, compactions: 0, degraded: false, estimatedInputTokens: budget.triggerTokens, measuredInputTokens: measured, observedRatio: 0.5, usageCalibration: 0.5, budget: { contextWindow: budget.contextWindow, capacitySource: budget.capacitySource, counting: budget.counting, inputTokens: budget.inputTokens, triggerTokens: budget.triggerTokens } });
  const turns = async (measured: number, offset: number) => {
    for (let index = 0; index < 2; index++) {
      await db.message.create({ data: { chatId: chat.id, role: "user", clientMessageId: `u-${offset}-${index}`, content: `question ${index} ${"word ".repeat(6000)}`, createdAt: new Date(2026, 10, 1, offset, index, 0) } });
      await db.message.create({ data: { chatId: chat.id, role: "assistant", clientMessageId: `a-${offset}-${index}`, content: encodePersistedAssistantToolMessage({ type: "assistant-tool-message", text: "ok", tools: [], modelLabel: `${CHAT_MODEL_REF.providerId}/${CHAT_MODEL_REF.modelId}`, contextBudget: report(measured) }), createdAt: new Date(2026, 10, 1, offset, index, 1) } });
    }
  };
  let calls = 0;
  t.mock.method(languageModel, "doGenerate", async () => { calls++; return summaryAnswer("Earlier."); });
  await turns(Math.floor(budget.triggerTokens * 0.4), 0);
  await compactAfterTurn({ chatId: chat.id, modelRef: CHAT_MODEL_REF });
  assert.equal(calls, 0, "the estimate reached the trigger, but the provider counted far less, so there is room");
  await turns(budget.triggerTokens - 50, 1);
  await compactAfterTurn({ chatId: chat.id, modelRef: CHAT_MODEL_REF });
  assert.ok(calls > 0, "the provider's count plus another such turn reaches it");
});

test("a fold during a turn puts the files back at once, leaving out what is still in view", async () => {
  const seen: Set<string>[] = [];
  const block = (id: string, path: string): ModelMessage[] => [
    { role: "assistant", content: [{ type: "tool-call", toolName: "readProjectFile", toolCallId: id, input: { path, script: `progress ${"0".repeat(22)}\n`.repeat(110) } }] },
    { role: "tool", content: [{ type: "tool-result", toolName: "readProjectFile", toolCallId: id, output: { type: "json", value: { ok: true } } }] },
  ];
  const manager = createStepContext({ budget: contextBudget({ contextLength: 10_000 }), system: "system", summarize: async () => "state",
    restoreAfterFold: async inUse => { seen.push(inUse); return "File old.ts as it was when this summary was written:\nRESTORED-CONTENT"; } });
  const { messages } = await manager.prepare([{ role: "user", content: "go" }, ...block("one", "old.ts"), ...block("two", "new.ts")]);
  assert.equal(manager.report.compactions, 1);
  assert.match(messages[0].content as string, /state[\s\S]*RESTORED-CONTENT/);
  assert.deepEqual([...seen[0]], ["new.ts"], "the file still in view is not brought back");
  const failing = createStepContext({ budget: contextBudget({ contextLength: 10_000 }), system: "system", summarize: async () => "state", restoreAfterFold: async () => { throw new Error("cannot read"); } });
  const carried = await failing.prepare([{ role: "user", content: "go" }, ...block("one", "old.ts"), ...block("two", "new.ts")]);
  assert.match(carried.messages[0].content as string, /state/, "a failure to put things back does not stop the turn");
});

test("a finished turn folds early when another turn its size would not fit, so the next request does not wait", async t => {
  await capacity(32_000);
  const window = (await conversationWindow(await modelInLibrary("chat", CHAT_MODEL_REF), CHAT_MODEL_REF)).maxTokens;
  const sized = (tokens: number) => "word ".repeat(Math.ceil(tokens * 4 / 5));
  const chatWith = async (turns: number[]) => {
    const chat = await db.chat.create({ data: { title: "Sized" } });
    for (const [index, tokens] of turns.entries()) for (const role of ["user", "assistant"] as const) await db.message.create({ data: { chatId: chat.id, role, clientMessageId: `${role}-${index}`, content: role === "user" ? sized(tokens) : "ok", createdAt: new Date(2026, 10, 1, 0, index, role === "user" ? 0 : 1) } });
    return chat;
  };
  let calls = 0;
  t.mock.method(languageModel, "doGenerate", async () => { calls++; return summaryAnswer("Earlier."); });
  const room = await chatWith([0.2, 0.2, 0.2].map(share => window * share));
  await compactAfterTurn({ chatId: room.id, modelRef: CHAT_MODEL_REF });
  assert.equal(calls, 0, "60% with small turns: the next one fits, so nothing to do yet");
  const tight = await chatWith([0.2, 0.2, 0.35].map(share => window * share));
  await compactAfterTurn({ chatId: tight.id, modelRef: CHAT_MODEL_REF });
  assert.ok(calls > 0, "75% with a 35% turn: another like it would not fit");
  assert.ok((await db.chat.findUniqueOrThrow({ where: { id: tight.id } })).summary);
  const before = calls;
  const early = await chatWith([0.45]);
  await compactAfterTurn({ chatId: early.id, modelRef: CHAT_MODEL_REF });
  assert.equal(calls, before, "one very large turn alone does not start folding below half the window");
});

test("a finished turn folds when the measured input says the next request would reach the trigger, though the window says it fits", async t => {
  await capacity(32_000);
  const { contextBudget: budgetOf } = await import("@/lib/models/context-budget");
  const budget = budgetOf(await modelInLibrary("chat", CHAT_MODEL_REF), (await getModelPreferences()).contextLimits[`openrouter:${CHAT_MODEL_REF.modelId}`]);
  const window = budget.triggerTokens;
  const sized = (tokens: number) => "word ".repeat(Math.ceil(tokens * 4 / 5));
  const answer = (estimatedInputTokens: number) => encodePersistedAssistantToolMessage({ type: "assistant-tool-message", text: "ok", tools: [], modelLabel: "openrouter/test", contextBudget: { checks: 1, compactions: 0, degraded: false, estimatedInputTokens, budget } as never });
  const chatWith = async (measured: number) => {
    const chat = await db.chat.create({ data: { title: "Measured" } });
    for (let index = 0; index < 3; index++) {
      await db.message.create({ data: { chatId: chat.id, role: "user", clientMessageId: `user-${index}`, content: sized(window * 0.2), createdAt: new Date(2026, 10, 1, 0, index, 0) } });
      await db.message.create({ data: { chatId: chat.id, role: "assistant", clientMessageId: `assistant-${index}`, content: answer(measured), createdAt: new Date(2026, 10, 1, 0, index, 1) } });
    }
    return chat;
  };
  let calls = 0;
  t.mock.method(languageModel, "doGenerate", async () => { calls++; return summaryAnswer("Earlier."); });
  await compactAfterTurn({ chatId: (await chatWith(Math.floor(window * 0.6))).id, modelRef: CHAT_MODEL_REF });
  assert.equal(calls, 0, "60% used and a 20% turn: the next request fits");
  await compactAfterTurn({ chatId: (await chatWith(Math.floor(window * 0.85))).id, modelRef: CHAT_MODEL_REF });
  assert.ok(calls > 0, "85% used with instructions and tools counted, though the turns alone are only 60% of the window");
});

test("a request that must fold before it can start says so, and its response starts first", async t => {
  await capacity(32_000);
  const { contextBudget: budgetOf } = await import("@/lib/models/context-budget");
  const window = budgetOf(await modelInLibrary("chat", CHAT_MODEL_REF), (await getModelPreferences()).contextLimits[`openrouter:${CHAT_MODEL_REF.modelId}`]).triggerTokens;
  // Under the window on its own, over the trigger once instructions and tools are added.
  const chat = await db.chat.create({ data: { title: "Tight" } });
  const history: UIMessage[] = [];
  for (let index = 0; index < 2; index++) for (const role of ["user", "assistant"] as const) {
    const id = `${role}-${index}`, text = role === "user" ? "word ".repeat(Math.ceil(window * 0.47 * 4 / 5)) : "ok";
    await db.message.create({ data: { chatId: chat.id, role, clientMessageId: id, content: text, createdAt: new Date(2026, 10, 1, 0, index, role === "user" ? 0 : 1) } });
    history.push({ id, role, parts: [{ type: "text", text }] });
  }
  const summary = gatedSummary(t), prompts = answers(t);
  const pending = post({ chatId: chat.id, messages: [...history, latest()] });
  await summary.reached;
  const response = await pending;
  assert.equal(response.status, 200, "the response started while the fold was running");
  const reader = response.body!.getReader();
  assert.match(await firstChunk(reader), /"data-context-status".*"organizing":true/);
  assert.equal(prompts.length, 0);
  summary.release();
  const rest = await readAll(reader);
  assert.match(rest, /"organizing":false/);
  assert.match(rest, /Answered/);
  assert.match(prompts[0], /planning a trip to Lisbon/);
});

test("the auxiliary setting is written only once chosen, so an older build can still read the rest", async () => {
  await seedTestModelPreferences(db);
  const stored = async () => (await db.workspacePreference.findUniqueOrThrow({ where: { id: "local" } })).settings as Record<string, unknown>;
  await saveModelPreferences(await getModelPreferences());
  assert.equal("auxiliary" in await stored(), false);
  assert.equal((await getModelPreferences()).auxiliary, null, "it still reads as unset");
  await saveModelPreferences({ ...await getModelPreferences(), auxiliary: OTHER_MODEL });
  assert.deepEqual((await stored()).auxiliary, OTHER_MODEL);
  await saveModelPreferences({ ...await getModelPreferences(), auxiliary: null });
  assert.equal("auxiliary" in await stored(), false, "clearing it takes it out again");
});

test("a fold that keeps failing stops costing calls until the conversation has grown, and a person can still try", async t => {
  await capacity(32_000);
  const { chat } = await longChat();
  let calls = 0;
  t.mock.method(languageModel, "doGenerate", async () => { calls++; throw new Error("summary provider down"); });
  for (let attempt = 0; attempt < 3; attempt++) await compactAfterTurn({ chatId: chat.id, modelRef: CHAT_MODEL_REF });
  const failing = calls;
  assert.ok(failing >= 3);
  await compactAfterTurn({ chatId: chat.id, modelRef: CHAT_MODEL_REF });
  assert.equal(calls, failing, "paused");
  assert.equal((await runTool({ tool: "compactContext", input: {}, chatId: chat.id })).status, 502);
  assert.ok(calls > failing, "a person's request still tries");
  const tried = calls;
  for (let index = 0; index < 10; index++) await db.message.create({ data: { chatId: chat.id, role: "user", clientMessageId: `more-${index}`, content: "more" } });
  await compactAfterTurn({ chatId: chat.id, modelRef: CHAT_MODEL_REF });
  assert.ok(calls > tried, "tries again once the conversation has grown");
});

test("if the auxiliary model fails, the model the work is for takes over", async t => {
  await capacity(32_000);
  await saveModelPreferences({ ...await getModelPreferences(), auxiliary: OTHER_MODEL });
  const { chat } = await longChat();
  let calls = 0;
  t.mock.method(languageModel, "doGenerate", async () => { if (++calls === 1) throw new Error("auxiliary down"); return summaryAnswer("Earlier: Lisbon."); });
  assert.ok(await compactAfterTurn({ chatId: chat.id, modelRef: CHAT_MODEL_REF }));
  assert.equal((await db.chat.findUniqueOrThrow({ where: { id: chat.id } })).summaryModelId, `${CHAT_MODEL_REF.providerId}:${CHAT_MODEL_REF.modelId}`);
});

test("the summary can be read back for the transcript, and a conversation with none has nothing to show", async () => {
  const { GET } = await import("@/app/api/conversations/[id]/summary/route");
  const read = async (id: string) => { const response = await GET(new NextRequest(`http://localhost/api/conversations/${id}/summary`, { headers: { cookie: localAccessCookie() } }), { params: Promise.resolve({ id }) }); assert.equal(response.status, 200); return (await response.json()).data; };
  assert.equal(await read("no-such-conversation"), null);
  const { chat } = await longChat(2);
  assert.equal(await read(chat.id), null);
  const covered = await db.message.findFirstOrThrow({ where: { chatId: chat.id, clientMessageId: "assistant-0" } });
  await db.chat.update({ where: { id: chat.id }, data: { summary: "[Task state v1]\nWhat happened.", summaryUpToMessageId: covered.id, summaryRevision: 0 } });
  assert.deepEqual(await read(chat.id), { summary: "What happened.", coveredIds: [covered.id, "assistant-0"] });
});

test("a summary sees more of each tool result when its model has room, and the usual record otherwise", () => {
  assert.equal(summaryRecordCharacters(15_000), 6000, "a small model's summary still sees the data itself");
  assert.equal(summaryRecordCharacters(181_000), 22_625);
  assert.equal(summaryRecordCharacters(1_000_000), 24_000);
  const lines = Array.from({ length: 300 }, (_, index) => ({ line: index + 1, text: index === 150 ? "the access code is PELICAN-7319" : `filler ${index} ${"text ".repeat(4)}` }));
  const part = { type: "tool-readProjectFile", toolCallId: "c", state: "output-available", input: { path: "notes.txt" }, output: { path: "notes.txt", hash: "abc", totalLines: 300, nextLine: null, lines } } as UIMessage["parts"][number];
  assert.doesNotMatch(historicalToolText(part), /PELICAN-7319/, "the usual record keeps only the ends");
  const left = /\[lines (\d+)-(\d+) left out; read them with startLine \1, lineCount (\d+)\]/.exec(historicalToolText(part));
  assert.ok(left, "and says which lines it left out and how to get them");
  assert.equal(Number(left[2]) - Number(left[1]) + 1, Number(left[3]));
  assert.match(historicalToolText(part), /path=notes\.txt hash=abc totalLines=300/);
  assert.match(historicalToolText(part, summaryRecordCharacters(181_000)), /PELICAN-7319/);
  assert.ok(historicalToolText(part, summaryRecordCharacters(181_000)).length <= 22_625);
});

test("the rules for writing a summary are not passed off as rules for the conversation", () => {
  const instructions = taskStateInstructions(1000);
  assert.doesNotMatch(instructions, /Do not execute anything/);
  assert.match(instructions, /leave them out of the handoff/);
});

test("the model is told to use its judgment on tools unless the user said not to", () => {
  const prompt = buildSystemPrompt(true);
  assert.match(prompt, /the user does not have to ask/);
  assert.match(prompt, /says in this conversation not to use a tool/);
  assert.doesNotMatch(buildSystemPrompt(false), /the user does not have to ask/);
});
