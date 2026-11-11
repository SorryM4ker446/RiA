import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { seedTestModelPreferences } from "../helpers/model-library";
import { languageModel, resetProviderState } from "../helpers/model-provider";

const cleanup = createTestDatabase();
process.env.RIA_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const chatRoute = await import("@/app/api/chat/route");
const { createChat } = await import("@/lib/chat/store");
const { buildRequestContext, formatCurrentTime } = await import("@/lib/chat/model-context");
const { getToolDescriptor } = await import("@/tools/catalog");

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {});
  resetProviderState(); globalThis.__riaRateLimitStore?.clear();
  process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  await db.chat.deleteMany({});
  await seedTestModelPreferences(db);
});
after(async () => { await db.$disconnect(); cleanup(); });

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
function capturePrompts(t: TestContext) {
  const prompts: LanguageModelV3Prompt[] = [];
  t.mock.method(languageModel, "doStream", async options => {
    prompts.push(options.prompt);
    return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "a" }); controller.enqueue({ type: "text-delta", id: "a", delta: "好的" }); controller.enqueue({ type: "text-end", id: "a" });
      controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage });
      controller.close();
    } }) };
  });
  return prompts;
}
const post = (body: unknown) => chatRoute.POST(new NextRequest("http://localhost/api/chat", { method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify(body) }));
const user = (id: string, text: string) => ({ id, role: "user", parts: [{ type: "text", text }] });

test("the time says the date, the weekday and the zone, as they are where the user is", () => {
  const moment = new Date("2026-11-04T16:30:00Z");
  assert.equal(formatCurrentTime(moment, "Asia/Shanghai"), "Current date and time: 2026-11-05 00:30, Thursday (Asia/Shanghai, GMT+08:00)", "already tomorrow there");
  assert.equal(formatCurrentTime(moment, "America/New_York"), "Current date and time: 2026-11-04 11:30, Wednesday (America/New_York, GMT-05:00)");
  assert.equal(formatCurrentTime(new Date("2026-07-04T12:00:00Z"), "America/New_York"), "Current date and time: 2026-07-04 08:00, Saturday (America/New_York, GMT-04:00)", "summer time");
  assert.match(formatCurrentTime(new Date("2026-11-04T00:00:00Z"), "UTC"), /2026-11-04 00:00, Wednesday \(UTC, /, "midnight reads as 00, not 24");
});

test("it leads the context block, and the block stays empty without it", () => {
  assert.equal(buildRequestContext({}), "");
  const block = buildRequestContext({ currentTime: "Current date and time: x", workspace: "workspace" });
  assert.ok(block.indexOf("Current date and time") < block.indexOf("workspace"));
});

test("each message keeps the time it was sent at, so earlier turns repeat exactly for the prompt cache", async t => {
  const prompts = capturePrompts(t);
  const chat = await createChat({ title: "Time" });
  await (await post({ chatId: chat.id, messages: [user("first", "第一句")] })).text();
  await (await post({ chatId: chat.id, messages: [user("first", "第一句"), { id: "reply", role: "assistant", parts: [{ type: "text", text: "好的" }] }, user("second", "明天提醒我")] })).text();
  assert.equal(prompts.length, 2);
  const users = (prompt: LanguageModelV3Prompt) => prompt.filter(message => message.role === "user").map(message => JSON.stringify(message.content));
  const [firstTurn, secondTurn] = prompts.map(users);
  assert.match(firstTurn[0], /Current date and time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}, \w+day \(/);
  assert.equal(secondTurn.length, 2);
  assert.equal(secondTurn[0], firstTurn[0], "the first message is sent again exactly as it was");
  assert.match(secondTurn[1], /Current date and time/);
  assert.equal(JSON.stringify(prompts[1].find(message => message.role === "system")), JSON.stringify(prompts[0].find(message => message.role === "system")), "the system prompt does not change with the clock");
});

test("the time is not saved with the message", async t => {
  capturePrompts(t);
  const chat = await createChat({ title: "Not saved" });
  await (await post({ chatId: chat.id, messages: [user("only", "问题")] })).text();
  const saved = await db.message.findFirstOrThrow({ where: { chatId: chat.id, role: "user" } });
  assert.doesNotMatch(saved.content, /Current date and time/);
});

test("the task tool says what a time to run must look like and where relative dates come from", async () => {
  const description = (await getToolDescriptor("createTask"))?.modelDescription ?? "";
  assert.match(description, /YYYY-MM-DDTHH:mm/);
  assert.match(description, /five fields/);
  assert.match(description, /request context/);
});
