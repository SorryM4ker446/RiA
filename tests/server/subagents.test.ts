import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import type { LanguageModelV3GenerateResult, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { CHAT_MODEL_REF, seedTestModelPreferences } from "../helpers/model-library";
import { languageModel, resetProviderState } from "../helpers/model-provider";
import { wireText } from "../helpers/wire-text";

const cleanup = createTestDatabase();
process.env.RIA_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const chatRoute = await import("@/app/api/chat/route");
const { createChat } = await import("@/lib/chat/store");
const { runTaskAgent } = await import("@/lib/agents/task");
const { runInternalAgent } = await import("@/lib/agents/internal");
const { getModelPreferences, saveModelPreferences } = await import("@/lib/models/preferences");
const { decodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");

beforeEach(async (t: TestContext) => {
  for (const method of ["error", "info", "warn"] as const) t.mock.method(console, method, () => {});
  resetProviderState(); globalThis.__riaRateLimitStore?.clear();
  process.env.APP_RUNTIME = "test"; process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  await db.chat.deleteMany({}); await db.memory.deleteMany({});
  await seedTestModelPreferences(db);
});
after(async () => { await db.$disconnect(); cleanup(); });

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
type Step = { tool?: { name: string; input: unknown }; tools?: Array<{ name: string; input: unknown }>; text?: string; before?: (signal?: AbortSignal) => Promise<void> };
const isSubagent = (options: { prompt: unknown }) => JSON.stringify(options.prompt).includes("You are a sub-agent of RiA");

/** The parent turn streams; each sub-agent generates. Both follow their own script and record what they were offered. */
function script(t: TestContext, parent: Step[], subagent: (call: number, options: { prompt: unknown }) => Promise<Step> | Step) {
  const seen = { parent: [] as Array<{ tools: string[]; prompt: string }>, subagent: [] as Array<{ tools: string[]; prompt: string }> };
  t.mock.method(languageModel, "doStream", async (options: { tools?: Array<{ name: string }>; prompt: unknown; abortSignal?: AbortSignal }) => {
    const step = parent[seen.parent.length] ?? { text: "Done." };
    seen.parent.push({ tools: (options.tools ?? []).map(tool => tool.name), prompt: JSON.stringify(options.prompt) });
    await step.before?.(options.abortSignal);
    const calls = step.tools ?? (step.tool ? [step.tool] : []);
    return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      calls.forEach((call, index) => controller.enqueue({ type: "tool-call", toolCallId: `parent-${seen.parent.length}-${index}`, toolName: call.name, input: JSON.stringify(call.input) }));
      if (!calls.length) { controller.enqueue({ type: "text-start", id: "a" }); controller.enqueue({ type: "text-delta", id: "a", delta: step.text ?? "Done." }); controller.enqueue({ type: "text-end", id: "a" }); }
      controller.enqueue({ type: "finish", finishReason: { unified: calls.length ? "tool-calls" : "stop", raw: undefined }, usage });
      controller.close();
    } }) };
  });
  const original = languageModel.doGenerate.bind(languageModel);
  t.mock.method(languageModel, "doGenerate", async (options: { prompt: unknown; tools?: Array<{ name: string }> }): Promise<LanguageModelV3GenerateResult> => {
    if (!isSubagent(options)) return original(options as never);
    const call = seen.subagent.length;
    seen.subagent.push({ tools: (options.tools ?? []).map(tool => tool.name), prompt: JSON.stringify(options.prompt) });
    const step = await subagent(call, options);
    const calls = step.tools ?? (step.tool ? [step.tool] : []);
    return {
      content: calls.length ? calls.map((tool, index) => ({ type: "tool-call" as const, toolCallId: `sub-${call}-${index}`, toolName: tool.name, input: JSON.stringify(tool.input) })) : [{ type: "text" as const, text: step.text ?? "Report." }],
      // Input counted roughly as a provider would, so the sub-agent's context planning sees how full the window is.
      finishReason: { unified: calls.length ? "tool-calls" : "stop", raw: undefined }, warnings: [],
      usage: { ...usage, inputTokens: { ...usage.inputTokens, total: Math.ceil(JSON.stringify(options.prompt).length / 3), noCache: Math.ceil(JSON.stringify(options.prompt).length / 3) } },
      providerMetadata: { openrouter: { usage: { cost: 0.002 } } },
    };
  });
  return seen;
}
async function ask(chatId: string, text: string) {
  const message: UIMessage = { id: `user-${Date.now()}`, role: "user", parts: [{ type: "text", text }] };
  const response = await chatRoute.POST(new NextRequest("http://localhost/api/chat", { method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify({ chatId, messages: [message] }) }));
  assert.equal(response.status, 200, await response.clone().text());
  await wireText(response);
}
async function subagentOutputs(chatId: string) {
  const rows = await db.message.findMany({ where: { chatId, role: "assistant" } });
  return rows.flatMap(row => decodePersistedAssistantToolMessage(row.content)?.tools ?? []).filter(tool => tool.toolName === "runSubagent").map(tool => tool.output as { title: string; status: string; report: string; notRun: Array<{ tool: string }>; toolCalls: number });
}
const brief = { title: "Check the policy", task: "Find the travel policy and save it as a knowledge entry named Travel policy." };

test("a sub-agent gets the conversation's tools without questions, scheduling, the checklist, memory, history or more sub-agents, and reports back", async t => {
  const seen = script(t, [{ tool: { name: "runSubagent", input: brief } }, { text: "Here is what it found." }], () => ({ text: "The policy says hotels are booked through the travel desk." }));
  const chat = await createChat({ title: "Sub-agent tools" });
  await ask(chat.id, "Look into the travel policy for me.");
  assert.ok(seen.parent[0].tools.includes("runSubagent"));
  const offered = seen.subagent[0].tools;
  for (const excluded of ["askUser", "createTask", "readWorkspaceActivity", "updatePlan", "runSubagent", "extractMemory", "readConversationHistory"]) assert.ok(!offered.includes(excluded), `${excluded} is not offered to a sub-agent`);
  assert.ok(offered.includes("searchKnowledge") && offered.includes("saveKnowledgeEntry"));
  assert.match(seen.subagent[0].prompt, /Find the travel policy/, "the brief is all it gets");
  assert.ok(!seen.subagent[0].prompt.includes("Look into the travel policy for me"), "nothing of the conversation itself");
  const [output] = await subagentOutputs(chat.id);
  assert.deepEqual([output.title, output.status, output.report], ["Check the policy", "done", "The policy says hotels are booked through the travel desk."]);
});

test("an action the approval rule would ask about is not run and is reported; under full access it runs; both are recorded under the sub-agent's call", async t => {
  const steps: Step[] = [{ tool: { name: "saveKnowledgeEntry", input: { key: "Travel policy", value: "Hotels are booked through the travel desk." } } }, { text: "Saved what I could." }];
  for (const [rule, saved] of [["ask", false], ["full", true]] as const) {
    script(t, [{ tool: { name: "runSubagent", input: brief } }, { text: "Done." }], call => steps[call] ?? { text: "Saved what I could." });
    const chat = await createChat({ title: `Sub-agent ${rule}` });
    await db.chat.update({ where: { id: chat.id }, data: { approvalRule: rule } });
    await db.memory.deleteMany({});
    await ask(chat.id, "Save the travel policy.");
    const [output] = await subagentOutputs(chat.id);
    assert.equal(output.status, "done");
    assert.equal(output.notRun.length, saved ? 0 : 1, `${rule}: what was not run is listed`);
    if (!saved) assert.match(output.notRun[0].tool, /知识条目|knowledge entry/i);
    assert.equal(await db.memory.count({ where: { key: "Travel policy" } }), saved ? 1 : 0, `${rule}: the entry is saved only when the rule allows it`);
    const run = await db.agentRun.findFirstOrThrow({ where: { chatId: chat.id }, include: { steps: { orderBy: { position: "asc" } } } });
    const parent = run.steps.find(step => step.toolName === "runSubagent")!;
    const inner = run.steps.find(step => step.toolName === "saveKnowledgeEntry")!;
    assert.equal(inner.parentToolCallId, parent.toolCallId, "the sub-agent's call is recorded under the call that started it");
    assert.equal(inner.state, saved ? "done" : "skipped");
    assert.ok(Math.abs(run.spentCostUsd - 0.004) < 1e-9, `${rule}: both of its calls are added to the turn's cost (${run.spentCostUsd})`);
    t.mock.restoreAll();
    for (const method of ["error", "info", "warn"] as const) t.mock.method(console, method, () => {});
  }
});

test("sub-agents started in one step run at the same time", async t => {
  let entered = 0; let release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  const seen = script(t, [{ tools: [{ name: "runSubagent", input: { ...brief, title: "First" } }, { name: "runSubagent", input: { ...brief, title: "Second" } }] }, { text: "Both done." }], async call => {
    if (call < 2) {
      if (++entered === 2) release();
      // A second sub-agent that only started after the first finished would never arrive.
      await Promise.race([both, new Promise((_, reject) => setTimeout(() => reject(new Error("the sub-agents ran one after another")), 5_000))]);
    }
    return { text: `Report ${call}` };
  });
  const chat = await createChat({ title: "Parallel" });
  await ask(chat.id, "Do both.");
  assert.equal(seen.subagent.length, 2);
  assert.deepEqual((await subagentOutputs(chat.id)).map(output => output.status), ["done", "done"]);
});

test("stopping the turn stops a sub-agent, and a provider failure is reported rather than thrown", async t => {
  const controller = new AbortController();
  script(t, [], async () => { controller.abort(); throw Object.assign(new Error("aborted"), { name: "AbortError" }); });
  const chat = await createChat({ title: "Stopped" });
  await assert.rejects(runTaskAgent({ task: "Anything", chatId: chat.id, modelRef: CHAT_MODEL_REF, signal: controller.signal, parentToolCallId: "parent", userText: [] }));
  t.mock.restoreAll();
  for (const method of ["error", "info", "warn"] as const) t.mock.method(console, method, () => {});
  script(t, [], () => { throw new Error("Upstream is down"); });
  const failed = await runTaskAgent({ task: "Anything", chatId: chat.id, modelRef: CHAT_MODEL_REF, parentToolCallId: "parent", userText: [] });
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /Upstream is down/);
});

test("an internal sub-agent runs on its own model, falls back once to the main one, and shares one deadline", async () => {
  const other = { providerId: "openrouter" as const, modelId: "google/gemini-3-flash-preview" };
  await saveModelPreferences({ ...(await getModelPreferences()), auxiliary: other });
  const tried: string[] = [];
  const value = await runInternalAgent(CHAT_MODEL_REF, async modelRef => {
    tried.push(modelRef.modelId);
    if (tried.length === 1) throw new Error("first model failed");
    return "ok";
  });
  assert.equal(value, "ok");
  assert.deepEqual(tried, [other.modelId, CHAT_MODEL_REF.modelId]);
  await assert.rejects(runInternalAgent(CHAT_MODEL_REF, (_model, signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("timed out")))), { timeoutMs: 50 }), /time for this call ran out/, "the fallback gets no fresh deadline");
  await assert.rejects(runInternalAgent(CHAT_MODEL_REF, async () => { throw new Error("no fallback here"); }, { fallback: () => false }), /no fallback here/);
});

test("in the execution record, a sub-agent's own calls sit inside the call that started it, in the order they ran", async () => {
  const { executionCalls } = await import("@/features/chat/execution-calls");
  const step = (position: number, toolName: string, toolCallId: string, parentToolCallId?: string) => ({ id: `step-${position}`, position, kind: "tool", toolName, toolCallId, ...(parentToolCallId ? { parentToolCallId } : {}), state: "done" as const, output: null, errorCode: null, startedAt: "2031-01-01T00:00:00.000Z", finishedAt: null });
  const run = { id: "run", chatId: null, goal: "", status: "succeeded" as const, stopReason: null, startedAt: "2031-01-01T00:00:00.000Z", finishedAt: null, budget: { maxSteps: null, maxFailures: null, deadlineMs: null, maxCostUsd: null, spentCostUsd: 0 },
    steps: [step(1, "searchKnowledge", "own"), step(2, "runSubagent", "parent"), step(3, "readWebPage", "inner-1", "parent"), step(4, "saveKnowledgeEntry", "inner-2", "parent")] };
  const calls = executionCalls(run);
  assert.deepEqual(calls.map(call => call.step?.toolName), ["runSubagent", "searchKnowledge"], "newest first, as before, with the inner calls out of the list");
  assert.deepEqual(calls[0].children?.map(call => call.step?.toolName), ["readWebPage", "saveKnowledgeEntry"]);
});

test("a sub-agent's command in a turn someone can stop has no unattended time limit; in a scheduled task it does", async t => {
  const { mkdtempSync, realpathSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createGrant } = await import("@/lib/local-files/grants");
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ria-subagent-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const grant = await createGrant({ path: root });
  const command = process.platform === "win32" ? "[Console]::WriteLine('ready')" : "printf 'ready\n'";
  const seenResults: string[] = [];
  for (const unattended of [false, true]) {
    script(t, [], (call, options) => {
      if (call === 0) return { tool: { name: "runTerminalCommand", input: { grantId: grant.id, command } } };
      seenResults.push(JSON.stringify(options.prompt));
      return { text: "Ran it." };
    });
    const chat = await db.chat.create({ data: { title: "Sub-agent command", workspaceGrantId: grant.id, approvalRule: "full" } });
    const result = await runTaskAgent({ task: "Run the check.", chatId: chat.id, modelRef: CHAT_MODEL_REF, parentToolCallId: `parent-${unattended}`, userText: ["Run the check."], unattended });
    assert.equal(result.status, "done");
    assert.deepEqual(result.notRun, [], "full access runs the command");
    t.mock.restoreAll();
    for (const method of ["error", "info", "warn"] as const) t.mock.method(console, method, () => {});
  }
  assert.match(seenResults[0], /ready/);
  assert.ok(!seenResults[0].includes("timeoutSeconds"), "no time limit was put on the attended command");
  assert.ok(seenResults[1].includes("timeoutSeconds"), "a scheduled task's command gets the unattended limit");
});

test("a sub-agent's summaries draw on the turn's compaction allowance", async t => {
  const { mkdtempSync, realpathSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createGrant } = await import("@/lib/local-files/grants");
  const { createCompactionAllowance } = await import("@/lib/chat/task-summary");
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ria-subagent-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const grant = await createGrant({ path: root });
  // A small window, and commands that print a lot: the sub-agent has to fold its earlier work.
  const preferences = await getModelPreferences();
  await saveModelPreferences({ ...preferences, contextLimits: { ...preferences.contextLimits, [`${CHAT_MODEL_REF.providerId}:${CHAT_MODEL_REF.modelId}`]: { contextLength: 16000, maxOutputTokens: 1000 } } });
  const command = process.platform === "win32" ? "[Console]::WriteLine('evidence ' * 4000)" : "printf 'evidence %.0s' $(seq 4000)";
  script(t, [], call => call < 20 ? { tool: { name: "runTerminalCommand", input: { grantId: grant.id, command } } } : { text: "Looked at everything." });
  const chat = await db.chat.create({ data: { title: "Sub-agent folding", workspaceGrantId: grant.id, approvalRule: "full" } });
  const allowance = createCompactionAllowance(2);
  const folded = await runTaskAgent({ task: "Check the output six times.", chatId: chat.id, modelRef: CHAT_MODEL_REF, parentToolCallId: "parent-fold", userText: ["Check it."], compactionAllowance: allowance });
  assert.ok(folded.status === "done" || /压缩|compact/i.test(folded.error ?? ""), folded.error);
  assert.ok(allowance.remaining < 2, `the sub-agent's folds were counted against the turn (${allowance.remaining} left)`);
});

test("the checklist stays the main assistant's: handing off says to keep it current, and parallel work is one step", async () => {
  const { getToolDescriptor } = await import("@/tools/builtins");
  const subagent = getToolDescriptor("runSubagent")!.modelDescription;
  assert.match(subagent, /cannot see or update your checklist/);
  assert.match(subagent, /mark the step in_progress before handing it off, and update the checklist as soon as the report comes back/);
  // As Claude Code tells its main agent: the report is not the user's to read, and a brief says whether to change anything.
  assert.match(subagent, /The report comes back to you, not to the user[^.]*: tell the user what it found or did in your answer/);
  assert.match(subagent, /whether it should change anything \(edit files, run commands that change things\) or only look and report/);
  const plan = getToolDescriptor("updatePlan")!.modelDescription;
  assert.match(plan, /Work you hand to several sub-agents at once is one step/);
  assert.match(plan, /sub-agents cannot update the checklist/);
});

// --- background sub-agents ----------------------------------------------------

const subagents = await import("@/lib/agents/subagents");
const continuation = await import("@/lib/agents/subagent-continuation");
const liveTurns = await import("@/lib/chat/live-turns");
const { decodePersistedUserMessage } = await import("@/lib/ai/ui-message");
const background = { ...brief, title: "Look in the background", background: true };

async function until<T>(read: () => Promise<T | null | undefined | false>, what: string, ms = 8_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
const ended = (id: string) => until(async () => { const row = await db.subagentRun.findUnique({ where: { id } }); return row && row.status !== "running" ? row : null; }, `sub-agent ${id} to end`);
const aborted = () => Object.assign(new Error("aborted"), { name: "AbortError" });
/** Waits until the signal stops it. */
const blocked = (signal?: AbortSignal) => new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(aborted()), { once: true }));
/** A gate the sub-agent waits at, until the test opens it. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, wait: () => opened };
}
function quiet(t: TestContext) {
  t.mock.restoreAll();
  for (const method of ["error", "info", "warn"] as const) t.mock.method(console, method, () => {});
}

test("a background sub-agent hands back its id at once, the turn goes on, and its report joins the turn's next step", async t => {
  const done = new Promise<void>(resolve => { const off = subagents.onSubagentFinished(() => { off(); resolve(); }); });
  const seen = script(t, [
    { tool: { name: "runSubagent", input: background } },
    // The turn carries on while it runs; the next step waits here until it has ended.
    { tool: { name: "checkSubagents", input: {} }, before: () => done },
    { text: "It found the travel desk rule." },
  ], () => ({ text: "Hotels go through the travel desk." }));
  const chat = await createChat({ title: "Background" });
  await ask(chat.id, "Have a sub-agent look into the policy while you go on.");
  const [output] = await subagentOutputs(chat.id) as unknown as Array<{ id: string; status: string; background: boolean }>;
  assert.equal(output.status, "running", "the call answered at once, before the work was done");
  assert.equal(output.background, true);
  assert.match(seen.parent[2].prompt, /Automatic notice from RiA, not a message from the user/);
  assert.match(seen.parent[2].prompt, /Hotels go through the travel desk/);
  const row = await db.subagentRun.findUniqueOrThrow({ where: { id: output.id } });
  assert.deepEqual([row.status, row.delivered, row.background], ["done", true, true]);
  // Taken by that step, it does not wake the conversation again.
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await db.message.count({ where: { chatId: chat.id, role: "user" } }), 1);
});

test("a report that arrives after the turn has ended wakes the conversation with an automatic notice", async t => {
  continuation.watchSubagentReports();
  const hold = gate();
  const seen = script(t, [{ tool: { name: "runSubagent", input: background } }, { text: "Started it; I will tell you." }, { text: "Here is what it found." }], async () => { await hold.wait(); return { text: "Hotels go through the travel desk." }; });
  const chat = await createChat({ title: "Woken" });
  await ask(chat.id, "Look into it in the background.");
  hold.open();
  const notice = await until(async () => {
    const rows = await db.message.findMany({ where: { chatId: chat.id, role: "user" }, orderBy: { createdAt: "asc" } });
    return rows.length === 2 ? rows[1] : null;
  }, "the woken turn's message");
  assert.deepEqual(decodePersistedUserMessage(notice.content)?.notice, { kind: "subagents", titles: ["Look in the background"] }, "it is RiA's notice, not the user's message");
  await until(async () => !liveTurns.isTurnLive(chat.id) && await db.message.count({ where: { chatId: chat.id, role: "assistant" } }) === 2, "the woken turn to answer");
  assert.match(seen.parent[2].prompt, /Automatic notice from RiA[\s\S]*Hotels go through the travel desk/);
});

test("a sub-agent can be stopped from its card, and stopping a turn stops all of the conversation's", async t => {
  continuation.watchSubagentReports();
  script(t, [{ tools: [{ name: "runSubagent", input: { ...background, title: "One" } }, { name: "runSubagent", input: { ...background, title: "Two" } }] }, { text: "Both started." }],
    async (_call, options) => blocked((options as { abortSignal?: AbortSignal }).abortSignal));
  const chat = await createChat({ title: "Stops" });
  await ask(chat.id, "Start two in the background.");
  const [one, two] = await db.subagentRun.findMany({ where: { chatId: chat.id }, orderBy: { title: "asc" } });
  assert.equal(subagents.stopSubagent("another-chat", one.id), false, "only its own conversation can stop it");
  assert.equal(subagents.stopSubagent(chat.id, one.id), true);
  assert.equal((await ended(one.id)).status, "stopped");
  assert.equal((await db.subagentRun.findUniqueOrThrow({ where: { id: two.id } })).status, "running");
  // A later turn the user stops takes the other one with it.
  quiet(t);
  let answering = false;
  script(t, [{ text: "never", before: signal => { answering = true; return blocked(signal); } }], () => ({ text: "unused" }));
  const asking = ask(chat.id, "Something else meanwhile.").catch(() => {});
  await until(async () => answering, "the second turn to start answering");
  liveTurns.stopTurn(chat.id);
  await asking;
  assert.equal((await ended(two.id)).status, "stopped");
  // Stopped ones wake nothing.
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await db.message.count({ where: { chatId: chat.id, role: "user" } }), 2);
});

test("one still marked running after a restart reads as interrupted, and is told at the next chance", async () => {
  const chat = await createChat({ title: "Restarted" });
  await db.subagentRun.create({ data: { id: "sa_00000000beef", chatId: chat.id, toolCallId: "call-old", title: "Before the restart", task: "Anything", background: true } });
  const [view] = await subagents.listSubagents(chat.id);
  assert.equal(view.status, "interrupted");
  assert.equal(await subagents.hasReportToContinue(chat.id), false, "an interrupted one does not wake the conversation");
  const taken = await subagents.takeSubagentReports(chat.id);
  assert.match(taken.text, /Before the restart \(sa_00000000beef\): was cut off when RiA restarted/);
  assert.equal((await subagents.takeSubagentReports(chat.id)).text, "", "told once");
});

test("a task's run waits for its background sub-agents and the turns their reports wake", async t => {
  const hold = gate();
  script(t, [{ tool: { name: "runSubagent", input: background } }, { text: "Started." }, { text: "Report read." }], async () => { await hold.wait(); return { text: "Finished the check." }; });
  const chat = await createChat({ title: "Task conversation" });
  await ask(chat.id, "Run the check in the background.");
  let settled = false;
  const waiting = continuation.settleSubagentWork(chat.id, new AbortController().signal).then(outcome => { settled = true; return outcome; });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(settled, false, "not done while the sub-agent runs");
  hold.open();
  assert.deepEqual(await waiting, { status: "succeeded" });
  assert.equal(await db.message.count({ where: { chatId: chat.id, role: "assistant" } }), 2, "the woken turn answered before the run counted as done");
});
