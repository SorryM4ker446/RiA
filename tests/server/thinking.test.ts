import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { seedTestModelPreferences } from "../helpers/model-library";
import { languageModel, resetProviderState } from "../helpers/model-provider";
import { wireText } from "../helpers/wire-text";

const cleanup = createTestDatabase();
process.env.RIA_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const chatRoute = await import("@/app/api/chat/route");
const { createChat } = await import("@/lib/chat/store");
const { decodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
const { mapStoredMessagesToUI } = await import("@/features/chat/page-utils");
const { createThinkingClock, readThinking, reasoningKindOf, thinkingMarks } = await import("@/lib/chat/thinking");

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {});
  resetProviderState(); globalThis.__riaRateLimitStore?.clear();
  process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  await db.chat.deleteMany({});
  await seedTestModelPreferences(db);
});
after(async () => { await db.$disconnect(); cleanup(); });

const usage = (reasoning = 0) => ({ inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10 + reasoning, text: 10, reasoning } });
const post = (body: unknown) => chatRoute.POST(new NextRequest("http://localhost/api/chat", { method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify(body) }));
type Step = { reasoning?: string; reasoningMetadata?: Record<string, Record<string, never[] | unknown>>; tool?: string; text?: string; reasoningTokens?: number };
function script(t: TestContext, steps: Step[]) {
  let index = 0;
  t.mock.method(languageModel, "doStream", async () => {
    const step = steps[index++] ?? { text: "Done." };
    return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      if (step.reasoning) {
        controller.enqueue({ type: "reasoning-start", id: "r", ...(step.reasoningMetadata ? { providerMetadata: step.reasoningMetadata as never } : {}) });
        controller.enqueue({ type: "reasoning-delta", id: "r", delta: step.reasoning });
        controller.enqueue({ type: "reasoning-end", id: "r" });
      }
      if (step.tool) controller.enqueue({ type: "tool-call", toolCallId: `call-${index}`, toolName: step.tool, input: JSON.stringify({ query: "周报" }) });
      if (step.text) { controller.enqueue({ type: "text-start", id: "a" }); controller.enqueue({ type: "text-delta", id: "a", delta: step.text }); controller.enqueue({ type: "text-end", id: "a" }); }
      controller.enqueue({ type: "finish", finishReason: { unified: step.tool ? "tool-calls" : "stop", raw: undefined }, usage: usage(step.reasoningTokens) });
      controller.close();
    } }) };
  });
}
async function saved(chatId: string) {
  const row = await db.message.findFirstOrThrow({ where: { chatId, role: "assistant" } });
  return { payload: decodePersistedAssistantToolMessage(row.content), ui: mapStoredMessagesToUI([row]).uiMessages[0] };
}
const ask = async (t: TestContext, steps: Step[]) => {
  script(t, steps);
  const chat = await createChat({ title: "Thinking" });
  await wireText(await post({ chatId: chat.id, messages: [{ id: `user-${chat.id}`, role: "user", parts: [{ type: "text", text: "想一想" }] }] }));
  return saved(chat.id);
};

test("the clock counts each step's reasoning, not the tools or the answer around it", () => {
  let at = 0;
  const clock = createThinkingClock(() => at);
  assert.equal(clock.report(), null, "nothing reasoned yet");
  clock.stepStarted(); at = 3000; clock.reasoning(); at = 5000; clock.output(); at = 9000;
  clock.stepFinished({ reasoning: [{ type: "reasoning", text: "想" }], hiddenReasoning: false });
  at = 20_000; clock.stepStarted(); at = 22_000; clock.output(); at = 30_000;
  clock.stepFinished({ reasoning: [], hiddenReasoning: false });
  assert.deepEqual(clock.report(), { kind: "full", durationMs: 3000 }, "the second step did not reason");
  clock.stepStarted(); at = 34_000; clock.output(); at = 40_000;
  clock.stepFinished({ reasoning: [], hiddenReasoning: true });
  assert.deepEqual(clock.report(), { kind: "full", durationMs: 7000 }, "hidden reasoning runs to the first output, and readable reasoning names the turn");
  const carried = createThinkingClock(() => 0, { kind: "summary", durationMs: 4000 });
  assert.deepEqual(carried.report(), { kind: "summary", durationMs: 4000 }, "an approval resume that does not reason keeps the turn's earlier record");
  carried.stepStarted(); carried.stepFinished({ reasoning: [{ type: "reasoning", text: "想" }], hiddenReasoning: false });
  assert.deepEqual(carried.report(), { kind: "full", durationMs: 4000 });
});

test("a provider that sent only summary details is not presented as the reasoning itself", () => {
  const details = (...types: string[]) => ({ openrouter: { reasoning_details: types.map(type => ({ type })) } });
  assert.equal(reasoningKindOf([]), null);
  assert.equal(reasoningKindOf([{ type: "reasoning", text: "  " }]), null);
  assert.equal(reasoningKindOf([{ type: "reasoning", text: "想" }]), "full", "a provider with no details sent its reasoning");
  assert.equal(reasoningKindOf([{ type: "reasoning", text: "想", providerMetadata: details("reasoning.text") }]), "full");
  assert.equal(reasoningKindOf([{ type: "reasoning", text: "摘要", providerMetadata: details("reasoning.summary") }]), "summary");
  assert.equal(reasoningKindOf([{ type: "reasoning", text: "摘要", providerMetadata: details("reasoning.summary", "reasoning.text") }]), "full");
});

test("tool calls split the reasoning into stretches, live and from what was stored", () => {
  const parts = [
    { type: "step-start" }, { type: "reasoning", text: "  先查一下", state: "done" },
    { type: "tool-webSearch", toolCallId: "a", state: "output-available", input: {}, output: {} },
    { type: "tool-webSearch", toolCallId: "b", state: "output-available", input: {}, output: {} },
    { type: "tool-createTask", toolCallId: "c", state: "output-available", input: {}, output: {} },
    { type: "step-start" }, { type: "reasoning", text: "再想一步", state: "done" }, { type: "text", text: "回答" },
  ] as never;
  assert.deepEqual(thinkingMarks(parts), [{ at: 4, tools: ["webSearch", "createTask"] }]);
  const live = readThinking({ id: "m", role: "assistant", parts });
  assert.deepEqual(live?.segments, [{ text: "先查一下", tools: ["webSearch", "createTask"] }, { text: "再想一步", tools: [] }]);
  // A stored message has one reasoning part, so its stored marks are what divide it.
  const stored = readThinking({ id: "m", role: "assistant", metadata: { thinking: { kind: "summary", durationMs: 2000, marks: [{ at: 4, tools: ["webSearch"] }] } }, parts: [{ type: "reasoning", text: "先查一下再想一步" }] as never });
  assert.equal(stored?.kind, "summary");
  assert.deepEqual(stored?.segments.map(segment => segment.text), ["先查一下", "再想一步"]);
  // Older messages have only the text.
  assert.deepEqual(readThinking({ id: "m", role: "assistant", parts: [{ type: "reasoning", text: "旧的思考" }] as never })?.segments, [{ text: "旧的思考", tools: [] }]);
  assert.equal(readThinking({ id: "m", role: "assistant", parts: [{ type: "text", text: "回答" }] }), null);
  assert.equal(readThinking({ id: "m", role: "assistant", metadata: { thinking: { kind: "hidden", durationMs: 1000 } }, parts: [{ type: "text", text: "回答" }] })?.kind, "hidden");
});

test("a turn stores what kind of reasoning it had, and reads back the same", async t => {
  const full = await ask(t, [{ reasoning: "逐步推理", text: "回答" }]);
  assert.equal(full.payload?.thinking?.kind, "full");
  assert.equal(typeof full.payload?.thinking?.durationMs, "number");
  assert.equal(readThinking(full.ui)?.text, "逐步推理");

  t.mock.restoreAll();
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {});
  const summary = await ask(t, [{ reasoning: "概括", reasoningMetadata: { openrouter: { reasoning_details: [{ type: "reasoning.summary" }] } }, text: "回答" }]);
  assert.equal(summary.payload?.thinking?.kind, "summary");
  assert.equal(readThinking(summary.ui)?.kind, "summary");

  t.mock.restoreAll();
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {});
  const hidden = await ask(t, [{ reasoningTokens: 200, text: "回答" }]);
  assert.equal(hidden.payload?.thinking?.kind, "hidden");
  assert.equal(hidden.payload?.reasoning, undefined);
  assert.equal(readThinking(hidden.ui)?.kind, "hidden");

  t.mock.restoreAll();
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {});
  const none = await ask(t, [{ text: "回答" }]);
  assert.equal(none.payload?.thinking, undefined, "a plain answer records nothing about reasoning");
  assert.equal(readThinking(none.ui), null);
});

test("a reasoning turn with tool steps stores where the tools fell", async t => {
  const { payload, ui } = await ask(t, [{ reasoning: "先查一下", tool: "searchKnowledge" }, { reasoning: "再想一步", text: "回答" }]);
  assert.deepEqual(payload?.thinking?.marks, [{ at: 4, tools: ["searchKnowledge"] }]);
  assert.deepEqual(readThinking(ui)?.segments, [{ text: "先查一下", tools: ["searchKnowledge"] }, { text: "再想一步", tools: [] }]);
});
