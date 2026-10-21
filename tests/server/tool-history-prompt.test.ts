import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { seedTestModelPreferences, CHAT_MODEL_REF } from "../helpers/model-library";
import { languageModel, resetProviderState } from "../helpers/model-provider";
const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const chatRoute = await import("@/app/api/chat/route");
const { encodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
const { mapStoredMessagesToUI } = await import("@/features/chat/page-utils");
const { summarizeOlderTurns } = await import("@/lib/chat/summary");
beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {});
  resetProviderState();
  globalThis.__privateAiRateLimitStore?.clear();
  await db.chat.deleteMany({});
  process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  await seedTestModelPreferences(db);
});
after(async () => { await db.$disconnect(); cleanup(); });

function terminalMessage(commentary: string) {
  return encodePersistedAssistantToolMessage({ type: "assistant-tool-message", text: commentary, tools: [{
    toolName: "runTerminalCommand", toolCallId: "build-call", state: "output-available",
    input: { grantId: "folder", command: "# padding\n".repeat(100_000) + "npm test" },
    output: { status: "failed", exitCode: 2, truncated: false,
      stdout: "progress\n".repeat(1000) + "src/main.ts:42: error TS2304: Cannot find name widget\n" + "progress\n".repeat(1000) + "Tests: 34 passed, 2 failed",
      stderr: "Compile failed", fileChanges: { complete: true, files: [{ path: "src/main.ts", kind: "modified" }] },
    },
  }] });
}
function promptText(prompt: { content: string | unknown[] }[]) {
  return prompt.map(message => typeof message.content === "string" ? message.content : message.content.map(part => {
    const text = part as { type: string; text?: string };
    return text.type === "text" ? text.text : "";
  }).join("\n")).join("\n");
}

for (const longCommentary of [false, true]) test(`the next model request receives terminal diagnostics through ${longCommentary ? "the older-history excerpt" : "recent history"}`, async () => {
  const chat = await db.chat.create({ data: { title: "Continue a build" } });
  const original = terminalMessage(longCommentary ? "build 1234567890 ".repeat(5500) : "Build attempted");
  const rows = [
    await db.message.create({ data: { chatId: chat.id, role: "user", clientMessageId: "build-user", content: "Build the application", createdAt: new Date(1000) } }),
    await db.message.create({ data: { chatId: chat.id, role: "assistant", clientMessageId: "build-answer", content: original, createdAt: new Date(2000) } }),
  ];
  const response = await chatRoute.POST(new NextRequest("http://localhost/api/chat", { method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify({ chatId: chat.id, model: CHAT_MODEL_REF, messages: [
    ...mapStoredMessagesToUI(rows).uiMessages, { id: "follow-up", role: "user", parts: [{ type: "text", text: "Fix the reported build error" }] },
  ] }) }));
  assert.equal(response.status, 200);
  await response.text();
  const prompt = promptText(languageModel.doStreamCalls.at(-1)!.prompt);
  assert.match(prompt, /error TS2304: Cannot find name widget/);
  assert.match(prompt, /"exitCode":2/);
  if (!longCommentary) {
    assert.match(prompt, /Tests: 34 passed, 2 failed/);
    assert.match(prompt, /modified: src\/main\.ts/);
  } else assert.match(prompt, /Incomplete excerpts/);
  assert.equal((await db.message.findUniqueOrThrow({ where: { id: rows[1].id } })).content, original);
  assert.equal(await db.agentStep.count({ where: { run: { chatId: chat.id } } }), 0);
});

test("long-term summary input retains the latest tool failure after long assistant commentary", async t => {
  // The shared fixture echoes its prompt; a real summary is capped at 2,048
  // output tokens, so answer briefly and inspect what the summarizer received.
  const prompts: string[] = [];
  t.mock.method(languageModel, "doGenerate", async (options: Parameters<typeof languageModel.doGenerate>[0]) => {
    prompts.push(promptText(options.prompt));
    return { content: [{ type: "text" as const, text: "Build failed with TS2304; 2 tests failed." }], finishReason: { unified: "stop" as const, raw: "stop" },
      usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } }, warnings: [] };
  });
  const chat = await db.chat.create({ data: { title: "Summarize a long build task" } });
  const rows = [];
  for (let i = 0; i < 44; i++) rows.push(await db.message.create({ data: {
    chatId: chat.id, role: i % 2 ? "assistant" : "user", clientMessageId: `summary-${i}`, createdAt: new Date(i * 1000),
    content: i === 19 ? terminalMessage("older commentary ".repeat(2000)) : `Turn ${i}`,
  } }));
  const summary = await summarizeOlderTurns({ chatId: chat.id, messages: rows.map(row => ({ id: row.id, role: row.role, text: "" })), keepRecent: 24 });
  assert.ok(summary);
  const prompt = prompts.join("\n");
  for (const fact of ['"exitCode":2', "Cannot find name widget", "Tests: 34 passed, 2 failed", "modified: src/main.ts"]) assert.ok(prompt.includes(fact), fact);
});
