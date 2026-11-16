import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { seedTestModelPreferences } from "../helpers/model-library";
import { languageModel, resetProviderState } from "../helpers/model-provider";
import { wireText } from "../helpers/wire-text";

const cleanup = createTestDatabase();
process.env.RIA_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const route = await import("@/app/api/chat/route");

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {});
  resetProviderState(); globalThis.__riaRateLimitStore?.clear();
  process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  await db.chat.deleteMany({});
  await seedTestModelPreferences(db);
});
after(async () => { await db.$disconnect(); cleanup(); });

const ui = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
const request = (body: unknown) => new NextRequest("http://localhost/api/chat", { method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify(body) });
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };

test("a long turn without a checklist reaches the model once as a note on that step, and is never saved", { timeout: 30_000 }, async (t: TestContext) => {
  const prompts: string[] = [];
  t.mock.method(languageModel, "doStream", async (options: { prompt: unknown }) => {
    const step = prompts.length;
    prompts.push(JSON.stringify(options.prompt));
    return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      if (step < 7) controller.enqueue({ type: "tool-call", toolCallId: `look-${step}`, toolName: "readConversationHistory", input: JSON.stringify({ query: `detail ${step}` }) });
      else { controller.enqueue({ type: "text-start", id: "a" }); controller.enqueue({ type: "text-delta", id: "a", delta: "Done." }); controller.enqueue({ type: "text-end", id: "a" }); }
      controller.enqueue({ type: "finish", finishReason: { unified: step < 7 ? "tool-calls" : "stop", raw: undefined }, usage });
      controller.close();
    } }) };
  });
  const chat = await db.chat.create({ data: { title: "Long turn" } });
  const response = await route.POST(request({ chatId: chat.id, messages: [ui("long-user", "Look through everything we discussed.")] }));
  assert.equal(response.status, 200);
  assert.match(await wireText(response), /Done\./);
  const noted = prompts.map(prompt => prompt.includes("without a checklist"));
  // Step 5 is the first to see five calls; the note is on it alone.
  assert.deepEqual(noted, [false, false, false, false, false, true, false, false]);
  const saved = await db.message.findMany({ where: { chatId: chat.id } });
  assert.ok(saved.every(row => !row.content.includes("without a checklist")), "the note is not part of the conversation");
});
