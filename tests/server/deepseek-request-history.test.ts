import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { NextRequest } from "next/server";
import type { UIMessage } from "ai";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { CHAT_MODEL_REF, seedTestModelPreferences } from "../helpers/model-library";
import type { ModelRef } from "../../src/lib/models/preferences-schema";

// DeepSeek's cache matches a prefix exactly, so this compares the bytes the adapter sends.
process.env.DEEPSEEK_API_KEY = "sk-offline-fixture";
process.env.APP_RUNTIME = "test";
const FLASH = { providerId: "deepseek" as const, modelId: "deepseek-flash" };
const PRO = { providerId: "deepseek" as const, modelId: "deepseek-v4-pro" };
type NativeDetail = { type: "reasoning.text"; text: string; signature: string; format: string } | { type: "reasoning.encrypted"; data: string; format: string };
type Step = { reasoning?: string; details?: NativeDetail[]; text?: string; status?: number; responseModel?: string | null;
  finish?: "length"; call?: { id: string; name: string; args: unknown } };
type WireMessage = { role: string; content?: string; reasoning_content?: string; reasoning_details?: NativeDetail[];
  tool_call_id?: string; tool_calls?: { id: string; function: { name: string } }[] };
const bodies: { model: string; messages: WireMessage[]; tools: unknown }[] = [];
let script: Step[] = [];
let outOfBalance = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.includes("chat/completions")) return realFetch(input, init);
  const body = JSON.parse(String(init?.body)) as { model: string; messages: WireMessage[]; tools: unknown };
  bodies.push(body);
  if (outOfBalance) return new Response(JSON.stringify({ error: { message: "Insufficient Balance (request_id: secret-request-id)", type: "insufficient_balance_error", code: "invalid_request_error" } }), { status: 402, headers: { "content-type": "application/json" } });
  const step = script.shift() ?? { text: "ok" };
  if (step.status) return Response.json({ error: { message: "Offline attempt failed", code: step.status } }, { status: step.status });
  const model = step.responseModel === null ? undefined : step.responseModel ?? body.model;
  const chunk = (delta: unknown, finish: string | null = null, usage?: unknown) => `data: ${JSON.stringify({ id: "x", model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
  return new Response([
    ...(step.reasoning ? [chunk(url.includes("openrouter.ai") ? { reasoning: step.reasoning } : { reasoning_content: step.reasoning })] : []),
    ...(step.details ? [chunk({ reasoning_details: step.details })] : []),
    ...(step.text ? [chunk({ content: step.text })] : []),
    // The model's own spacing in its arguments is not what later requests repeat.
    ...(step.call ? [chunk({ tool_calls: [{ index: 0, id: step.call.id, type: "function", function: { name: step.call.name, arguments: JSON.stringify(step.call.args).replaceAll(":", ": ") } }] })] : []),
    chunk({}, step.finish ?? (step.call ? "tool_calls" : "stop"), { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_cache_hit_tokens: 0 }),
    "data: [DONE]\n\n",
  ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
};

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const chatRoute = await import("@/app/api/chat/route");
const { compactionsSettled } = await import("@/lib/chat/compaction");
const { mapStoredMessagesToUI } = await import("@/features/chat/page-utils");
const { createGrant } = await import("@/lib/local-files/grants");
const { canFallback } = await import("@/lib/models/usage");
const { retryDelay } = await import("@/lib/models/model-retry");
const { describeTurnFailure } = await import("@/lib/chat/tool-failure");
const { clearChatDegradations } = await import("@/lib/models/observe-language");
const { decodePersistedAssistantToolMessage, encodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ria-history-")));
after(async () => { globalThis.fetch = realFetch; await compactionsSettled(); await db.$disconnect(); rmSync(root, { recursive: true, force: true }); cleanup(); });

test("a later turn repeats byte for byte what the last step of the turn before it sent", async t => {
  t.mock.method(console, "info", () => {}); t.mock.method(console, "error", () => {});
  writeFileSync(join(root, "a.txt"), "alpha\nbeta\n");
  const settings = await seedTestModelPreferences(db);
  const now = new Date().toISOString();
  settings.library = [...settings.library, { ...FLASH, name: "Flash", description: "", modes: ["chat"], supportsImageInput: false, endpointImageInput: null, supportsTools: true, contextLength: 1_048_576, pricing: {}, addedAt: now, lastSeenAt: now }];
  settings.chat = { model: FLASH, fallback: null };
  await db.workspacePreference.update({ where: { id: "local" }, data: { settings } });
  const grant = await createGrant({ path: root });
  const chat = (await db.chat.create({ data: { title: "History", workspaceGrantId: grant.id, approvalRule: "full" } })).id;
  let turn = 0;
  const send = async (text: string) => {
    globalThis.__riaRateLimitStore?.clear();
    const rows = await db.message.findMany({ where: { chatId: chat }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const response = await chatRoute.POST(new NextRequest("http://localhost/api/chat", { method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" },
      body: JSON.stringify({ chatId: chat, model: FLASH, messages: [...mapStoredMessagesToUI(rows).uiMessages, { id: `user-${++turn}`, role: "user", parts: [{ type: "text", text }] }] }) }));
    assert.equal(response.status, 200);
    await response.text(); await compactionsSettled();
  };
  const read = (id: string) => ({ id, name: "readProjectFile", args: { grantId: grant.id, path: "a.txt", startLine: 1, lineCount: 10 } });
  // Whitespace counts: a model may say nothing but a line break before calling a tool.
  script = [
    { reasoning: "  ", text: "\n\n", call: read("call_a") },
    { reasoning: "Next.\n", text: "  Reading again. ", call: read("call_b") },
    { call: read("call_c") },
    { reasoning: "Done.", text: "All done.\n" },
  ];
  await send("First question");
  assert.equal(bodies.length, 4);
  const last = bodies.at(-1)!;
  script = [{ text: "Second answer." }];
  await send("Second question");
  const second = bodies.at(-1)!;
  assert.equal(JSON.stringify(second.tools), JSON.stringify(last.tools));
  assert.deepEqual(second.messages.slice(0, last.messages.length), last.messages, "the turn is repeated exactly, context block and whitespace included");
  assert.match(JSON.stringify(second.messages[last.messages.length]), /All done\.\\n/);
  script = [{ text: "Third answer." }];
  await send("Third question");
  assert.deepEqual(bodies.at(-1)!.messages.slice(0, second.messages.length), second.messages, "and so is every turn after it");
});

test("an account out of balance says so, once, without retrying or showing the provider's text", async t => {
  t.mock.method(console, "info", () => {}); t.mock.method(console, "error", () => {});
  const settings = await seedTestModelPreferences(db);
  const now = new Date().toISOString();
  settings.library = [...settings.library, { ...FLASH, name: "Flash", description: "", modes: ["chat"], supportsImageInput: false, endpointImageInput: null, supportsTools: true, contextLength: 1_048_576, pricing: {}, addedAt: now, lastSeenAt: now }];
  settings.chat = { model: FLASH, fallback: null };
  await db.workspacePreference.update({ where: { id: "local" }, data: { settings } });
  const chat = (await db.chat.create({ data: { title: "Out of balance" } })).id;
  globalThis.__riaRateLimitStore?.clear();
  const before = bodies.length;
  outOfBalance = true;
  try {
    const response = await chatRoute.POST(new NextRequest("http://localhost/api/chat", { method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" },
      body: JSON.stringify({ chatId: chat, model: FLASH, messages: [{ id: "broke", role: "user", parts: [{ type: "text", text: "Hello" }] }] }) }));
    const wire = await response.text();
    assert.match(wire, /余额不足|out of balance/);
    assert.match(wire, /DeepSeek/, "it names the provider to top up");
    assert.doesNotMatch(wire, /暂时不可用|temporarily/);
    assert.doesNotMatch(wire, /secret-request-id/);
    assert.equal(bodies.length - before, 1, "waiting will not help, so it is not retried");
  } finally { outOfBalance = false; }
});

test("a fallback model still takes over when the selected one is out of balance", () => {
  const error = Object.assign(new Error("Payment required"), { statusCode: 402 });
  assert.equal(canFallback(error), true);
  assert.equal(retryDelay(error, 0), null);
  assert.match(describeTurnFailure(error).message, /余额不足|out of balance/);
  assert.match(describeTurnFailure(error, "OpenRouter").message, /OpenRouter/);
  assert.match(describeTurnFailure(new Error("boom")).message, /暂时不可用|temporarily/);
});

const signed: NativeDetail = { type: "reasoning.text", text: "ROUTER-NATIVE-TEXT ", signature: "offline-signature", format: "anthropic-claude-v1" };
const encrypted: NativeDetail = { type: "reasoning.encrypted", data: "offline-opaque-block", format: "anthropic-claude-v1" };
const readHistory = (id: string) => ({ id, name: "readConversationHistory", args: { query: "fixture" } });

async function configureHistoryModels(fallback: ModelRef | null = null, extra: ModelRef[] = []) {
  clearChatDegradations();
  process.env.OPENROUTER_API_KEY = "offline-fixture";
  const settings = await seedTestModelPreferences(db);
  const now = new Date().toISOString();
  settings.library = [...settings.library, ...[FLASH, PRO, ...extra].map(ref => ({
    ...ref, name: ref.modelId, description: "", modes: ["chat" as const], supportsImageInput: false, endpointImageInput: null,
    supportsTools: true, contextLength: 128_000, pricing: {}, addedAt: now, lastSeenAt: now,
  }))];
  settings.chat = { model: FLASH, fallback };
  await db.workspacePreference.update({ where: { id: "local" }, data: { settings } });
}

async function loadHistory(chatId: string) {
  return mapStoredMessagesToUI(await db.message.findMany({ where: { chatId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).uiMessages;
}

const user = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

async function answer(chatId: string, model: ModelRef, messages: UIMessage[], steps: Step[]) {
  const before = bodies.length;
  script = steps;
  globalThis.__riaRateLimitStore?.clear();
  const result = await chatRoute.POST(new NextRequest("http://localhost/api/chat", { method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" },
    body: JSON.stringify({ chatId, model, messages }) }));
  assert.equal(result.status, 200);
  const wire = await result.text();
  await compactionsSettled();
  assert.doesNotMatch(wire, /"type":"error"/, wire.slice(-800));
  assert.equal(script.length, 0, "each expected provider step was reached");
  return bodies.slice(before);
}

function paired(request: typeof bodies[number], id: string) {
  const assistant = request.messages.find(message => message.tool_calls?.some(call => call.id === id));
  assert.ok(assistant, id);
  const resultIndex = request.messages.findIndex(message => message.role === "tool" && message.tool_call_id === id);
  assert.ok(resultIndex > request.messages.indexOf(assistant), "the matching tool result follows its call");
  return assistant;
}

test("model switching keeps signed and encrypted reasoning on the original OpenRouter model only", async () => {
  await configureHistoryModels();
  const chat = await db.chat.create({ data: { title: "Provider switch", approvalRule: "full" } });
  const start = await answer(chat.id, CHAT_MODEL_REF, [user("router-start", "Read the fixture.")], [
    { details: [signed, encrypted], call: readHistory("call_router") }, { text: "Read finished." },
  ]);
  assert.deepEqual(paired(start[1], "call_router").reasoning_details, [signed, encrypted]);
  const follow = await answer(chat.id, CHAT_MODEL_REF, [...await loadHistory(chat.id), user("router-follow", "Same model.")], [{ text: "Yes." }]);
  assert.deepEqual(paired(follow[0], "call_router").reasoning_details, [signed, encrypted]);
  const switched = await answer(chat.id, FLASH, [...await loadHistory(chat.id), user("switch-flash", "Switch to Flash.")], [
    { reasoning: "FLASH-NATIVE", call: readHistory("call_flash") }, { text: "Flash finished." },
  ]);
  assert.equal(paired(switched[0], "call_router").reasoning_content, "");
  assert.doesNotMatch(JSON.stringify(switched), /ROUTER-NATIVE|offline-signature|offline-opaque-block/);
  assert.equal(paired(switched[1], "call_flash").reasoning_content, "FLASH-NATIVE");
  const other = await answer(chat.id, PRO, [...await loadHistory(chat.id), user("switch-pro", "Switch to Pro.")], [{ text: "Pro finished." }]);
  assert.equal(paired(other[0], "call_flash").reasoning_content, "");
  assert.doesNotMatch(JSON.stringify(other), /FLASH-NATIVE|ROUTER-NATIVE/);
});

test("a mid-turn fallback uses its own history and persists the provenance of its reply", async () => {
  await configureHistoryModels(CHAT_MODEL_REF);
  const chat = await db.chat.create({ data: { title: "Mid-turn fallback", approvalRule: "full" } });
  await answer(chat.id, CHAT_MODEL_REF, [user("fallback-history", "Prior reference.")], [
    { details: [signed], call: readHistory("call_old_router") }, { text: "Prior answer." },
  ]);
  const turn = await answer(chat.id, FLASH, [...await loadHistory(chat.id), user("fallback-new", "Try Flash first.")], [
    { reasoning: "PRIMARY-PRIVATE", call: readHistory("call_primary") },
    { status: 402 },
    { details: [encrypted], call: readHistory("call_fallback") },
    { text: "Fallback finished." },
  ]);
  assert.deepEqual(turn.map(item => item.model), [FLASH.modelId, FLASH.modelId, CHAT_MODEL_REF.modelId, CHAT_MODEL_REF.modelId]);
  assert.equal(paired(turn[1], "call_primary").reasoning_content, "PRIMARY-PRIVATE");
  assert.ok(paired(turn[2], "call_primary"));
  assert.deepEqual(paired(turn[2], "call_old_router").reasoning_details, [signed], "fallback restores compatible historical reasoning");
  assert.deepEqual(paired(turn[3], "call_fallback").reasoning_details, [encrypted]);
  assert.doesNotMatch(JSON.stringify(turn.slice(2)), /PRIMARY-PRIVATE/);
  const fallbackAnswer = await db.message.findFirstOrThrow({ where: { chatId: chat.id, role: "assistant" }, orderBy: { createdAt: "desc" } });
  assert.deepEqual(decodePersistedAssistantToolMessage(fallbackAnswer.content)?.answeredBy, CHAT_MODEL_REF);
  const next = await answer(chat.id, CHAT_MODEL_REF, [...await loadHistory(chat.id), user("fallback-after", "Continue on the actual fallback.")], [{ text: "Continuing." }]);
  assert.deepEqual(paired(next[0], "call_fallback").reasoning_details, [encrypted], "saved source is the actual model answering the step");
  assert.doesNotMatch(JSON.stringify(next), /PRIMARY-PRIVATE/);
  clearChatDegradations();
});

test("approval continuation honors the saved reasoning source and drops client-supplied replay metadata", async () => {
  await configureHistoryModels();
  const question = { questions: [{ question: "Which format?", options: [{ label: "Report" }, { label: "Notes" }] }] };
  for (const target of [FLASH, PRO]) {
    const chat = await db.chat.create({ data: { title: "Resume " + target.modelId, approvalRule: "ask" } });
    await answer(chat.id, FLASH, [user("approval-start", "Ask before writing.")], [
      { reasoning: "APPROVAL-SAVED", call: { id: "call_approval", name: "askUser", args: question } },
    ]);
    const restored = await loadHistory(chat.id);
    const last = restored.at(-1)!;
    const pending = last.parts.find(part => part.type === "tool-askUser" && "state" in part && part.state === "approval-requested");
    assert.ok(pending && "approval" in pending && pending.approval);
    Object.assign(pending, { state: "approval-responded", approval: { ...pending.approval, approved: true,
      reason: JSON.stringify({ answers: [{ selected: ["Report"] }] }) } });
    last.parts.push({ type: "reasoning", text: "CLIENT-FORGED", providerMetadata: { riaReasoning: {
      ...target, protocol: "deepseek-chat-completions-v1", responseId: "01234567-89ab-4def-8123-456789abcdef",
    } } });
    const [resumed] = await answer(chat.id, target, restored, [{ text: "Report selected." }]);
    assert.equal(paired(resumed, "call_approval").reasoning_content, target === FLASH ? "APPROVAL-SAVED" : "");
    assert.match(resumed.messages.find(item => item.tool_call_id === "call_approval")!.content!, /Report/);
    assert.doesNotMatch(JSON.stringify(resumed), /CLIENT-FORGED/);
    const [back] = await answer(chat.id, FLASH, [...await loadHistory(chat.id), user("approval-later", "Return to Flash.")], [{ text: "Returned." }]);
    assert.equal(paired(back, "call_approval").reasoning_content, "APPROVAL-SAVED", "switching on resume does not overwrite the saved origin");
    assert.doesNotMatch(JSON.stringify(back), /CLIENT-FORGED/);
  }
});

test("fallback reasoning follows the reported response model across saved turns", async () => {
  const concrete = { providerId: "openrouter", modelId: "anthropic/claude-4.6-opus-20260205" } as const;
  const alias = { providerId: "openrouter", modelId: "~anthropic/claude-opus-latest" } as const;
  await configureHistoryModels(alias, [alias, concrete]);
  const chat = await db.chat.create({ data: { title: "Resolved fallback", approvalRule: "full" } });
  const turn = await answer(chat.id, FLASH, [user("alias-start", "Read the fixture.")], [
    { reasoning: "FLASH-FIRST", call: readHistory("call_flash_before_alias") },
    { status: 402 },
    { responseModel: concrete.modelId, details: [encrypted], call: readHistory("call_alias") },
    { responseModel: "anthropic/next-opus-version", text: "Fallback finished." },
  ]);
  assert.ok(paired(turn[3], "call_alias"));
  assert.equal(paired(turn[3], "call_alias").reasoning_details, undefined);
  const stored = await db.message.findFirstOrThrow({ where: { chatId: chat.id, role: "assistant" } });
  const saved = decodePersistedAssistantToolMessage(stored.content)!;
  const origin = saved.steps?.flatMap(step => step.toolReasoning ?? []).find(part => part.id === "call_alias")?.replay.origin;
  assert.equal(origin?.modelId, concrete.modelId);
  const [pinned] = await answer(chat.id, concrete, [...await loadHistory(chat.id), user("alias-pinned", "Reuse the exact fallback model.")], [
    { text: "Continued." },
  ]);
  assert.deepEqual(paired(pinned, "call_alias").reasoning_details, [encrypted]);
  assert.doesNotMatch(JSON.stringify(pinned), /FLASH-FIRST/);
});

test("missing model metadata and earlier request-name records withhold native replay", async () => {
  await configureHistoryModels();
  const chat = await db.chat.create({ data: { title: "Unconfirmed source", approvalRule: "full" } });
  const turn = await answer(chat.id, CHAT_MODEL_REF, [user("unknown-source", "Read twice.")], [
    { responseModel: null, details: [encrypted], call: readHistory("call_unknown_source") },
    { details: [signed], call: readHistory("call_old_source") },
    { text: "Done." },
  ]);
  assert.equal(paired(turn[1], "call_unknown_source").reasoning_details, undefined);
  const stored = await db.message.findFirstOrThrow({ where: { chatId: chat.id, role: "assistant" } });
  const saved = decodePersistedAssistantToolMessage(stored.content)!;
  for (const step of saved.steps ?? []) {
    for (const part of step.reasoningParts ?? []) if (part.replay) delete part.replay.origin.responseId;
    for (const part of step.toolReasoning ?? []) delete part.replay.origin.responseId;
  }
  await db.message.update({ where: { id: stored.id }, data: { content: encodePersistedAssistantToolMessage(saved) } });
  const history = await loadHistory(chat.id);
  assert.match(JSON.stringify(history), /ROUTER-NATIVE-TEXT/);
  const [later] = await answer(chat.id, CHAT_MODEL_REF, [...history, user("older-source", "Continue.")], [{ text: "Continued." }]);
  assert.equal(paired(later, "call_unknown_source").reasoning_details, undefined);
  assert.equal(paired(later, "call_old_source").reasoning_details, undefined);
});

test("approving on a changed model keeps both calls when the fallback reuses a tool ID", async () => {
  await configureHistoryModels(CHAT_MODEL_REF);
  const chat = await db.chat.create({ data: { title: "Fallback tool ID reuse", approvalRule: "ask" } });
  const question = { questions: [{ question: "Which format?", options: [{ label: "Report" }, { label: "Notes" }] }] };
  await answer(chat.id, FLASH, [user("duplicate-call", "Read then ask.")], [
    { reasoning: "PRIMARY-ONLY", call: readHistory("call_shared") },
    { status: 402 },
    { details: [encrypted], call: { id: "call_shared", name: "askUser", args: question } },
  ]);
  const restored = await loadHistory(chat.id);
  const pending = restored.at(-1)?.parts.find(part => part.type === "tool-askUser" && part.state === "approval-requested");
  assert.ok(pending && "approval" in pending && pending.approval);
  assert.notEqual(pending.toolCallId, "call_shared");
  Object.assign(pending, { state: "approval-responded", approval: { ...pending.approval, approved: true,
    reason: JSON.stringify({ answers: [{ selected: ["Report"] }] }) } });
  const [resumed] = await answer(chat.id, PRO, restored, [{ text: "Report selected." }]);
  assert.equal(paired(resumed, "call_shared").tool_calls?.[0]?.function.name, "readConversationHistory");
  assert.equal(paired(resumed, pending.toolCallId).tool_calls?.[0]?.function.name, "askUser");
  assert.deepEqual(resumed.messages.filter(item => item.role === "tool").map(item => item.tool_call_id), ["call_shared", pending.toolCallId]);
  assert.match(resumed.messages.find(item => item.tool_call_id === pending.toolCallId)!.content!, /Report/);
  assert.doesNotMatch(JSON.stringify(resumed), /PRIMARY-ONLY|offline-opaque-block/);
});

test("both signed responses to an automatically continued answer replay in order after reload", async () => {
  await configureHistoryModels();
  const chat = await db.chat.create({ data: { title: "Signed continuation", approvalRule: "full" } });
  const first = { ...signed, text: "First native block", signature: "first-signature" };
  const second = { ...signed, text: "Second native block", signature: "second-signature" };
  const turn = await answer(chat.id, CHAT_MODEL_REF, [user("continuation-start", "Write a report.")], [
    { details: [first], text: "This is the first paragraph of the report. ", finish: "length" },
    { details: [second], text: "This is the last paragraph." },
  ]);
  assert.equal(turn.length, 2);
  const [later] = await answer(chat.id, CHAT_MODEL_REF, [...await loadHistory(chat.id), user("continuation-later", "Continue from the report.")], [{ text: "Done." }]);
  const reply = later.messages.find(message => message.role === "assistant" && message.content?.includes("first paragraph"));
  assert.ok(reply?.content?.includes("last paragraph"));
  assert.deepEqual(reply.reasoning_details, [first, second]);
});
