import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { seedTestModelPreferences } from "../helpers/model-library";

// DeepSeek's cache matches a prefix exactly, so this compares the bytes the adapter sends.
process.env.DEEPSEEK_API_KEY = "sk-offline-fixture";
process.env.APP_RUNTIME = "test";
const FLASH = { providerId: "deepseek" as const, modelId: "deepseek-flash" };
type Step = { reasoning?: string; text?: string; call?: { id: string; name: string; args: unknown } };
const bodies: { messages: unknown[]; tools: unknown }[] = [];
let script: Step[] = [];
let outOfBalance = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.includes("chat/completions")) return realFetch(input, init);
  bodies.push(JSON.parse(String(init?.body)));
  if (outOfBalance) return new Response(JSON.stringify({ error: { message: "Insufficient Balance (request_id: secret-request-id)", type: "insufficient_balance_error", code: "invalid_request_error" } }), { status: 402, headers: { "content-type": "application/json" } });
  const step = script.shift() ?? { text: "ok" };
  const chunk = (delta: unknown, finish: string | null = null, usage?: unknown) => `data: ${JSON.stringify({ id: "x", model: FLASH.modelId, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
  return new Response([
    ...(step.reasoning ? [chunk({ reasoning_content: step.reasoning })] : []),
    ...(step.text ? [chunk({ content: step.text })] : []),
    // The model's own spacing in its arguments is not what later requests repeat.
    ...(step.call ? [chunk({ tool_calls: [{ index: 0, id: step.call.id, type: "function", function: { name: step.call.name, arguments: JSON.stringify(step.call.args).replaceAll(":", ": ") } }] })] : []),
    chunk({}, step.call ? "tool_calls" : "stop", { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 0 }),
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
const { setTerminalPermission } = await import("@/lib/terminal/permissions");
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
  await setTerminalPermission(grant.id, true, grant.updatedAt, "full-access");
  const chat = (await db.chat.create({ data: { title: "History", workspaceGrantId: grant.id } })).id;
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
