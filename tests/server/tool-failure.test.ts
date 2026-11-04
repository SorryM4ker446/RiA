import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { InvalidToolInputError, NoSuchToolError } from "ai";
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
const { decodePersistedAssistantToolMessage, readToolError } = await import("@/lib/ai/ui-message");
const { mapStoredMessagesToUI, hasLaterUserMessage } = await import("@/features/chat/page-utils");
const { createTurnFailureReader, describeTurnFailure, ToolRunError } = await import("@/lib/chat/tool-failure");
const { ApiError } = await import("@/lib/server/api-error");

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {});
  resetProviderState(); globalThis.__riaRateLimitStore?.clear();
  process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  await db.chat.deleteMany({});
  await seedTestModelPreferences(db);
});
after(async () => { await db.$disconnect(); cleanup(); });

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const post = (body: unknown) => chatRoute.POST(new NextRequest("http://localhost/api/chat", { method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify(body) }));

/** The model's first step calls the tool with this input; its next step answers. */
function callOnce(t: TestContext, toolName: string, input: unknown) {
  const prompts: LanguageModelV3Prompt[] = [];
  t.mock.method(languageModel, "doStream", async options => {
    prompts.push(options.prompt);
    const first = prompts.length === 1;
    return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      if (first) controller.enqueue({ type: "tool-call", toolCallId: "call-1", toolName, input: JSON.stringify(input) });
      else { controller.enqueue({ type: "text-start", id: "a" }); controller.enqueue({ type: "text-delta", id: "a", delta: "换个方式" }); controller.enqueue({ type: "text-end", id: "a" }); }
      controller.enqueue({ type: "finish", finishReason: { unified: first ? "tool-calls" : "stop", raw: undefined }, usage });
      controller.close();
    } }) };
  });
  return prompts;
}
const ask = async () => {
  const chat = await createChat({ title: "Tool failure" });
  await (await post({ chatId: chat.id, messages: [{ id: `user-${chat.id}`, role: "user", parts: [{ type: "text", text: "明天提醒我" }] }] })).text();
  const row = await db.message.findFirstOrThrow({ where: { chatId: chat.id, role: "assistant" } });
  return { row, tool: decodePersistedAssistantToolMessage(row.content)?.tools[0] };
};

test("a call refused for bad input records why and what was sent, not an unavailable model", async t => {
  const input = { title: "交周报", dueDate: "tomorrow 10:00" };
  const prompts = callOnce(t, "createTask", input);
  const { row, tool } = await ask();
  assert.equal(tool?.state, "output-error");
  assert.deepEqual(tool?.input, input, "the record shows what the model sent");
  const shown = readToolError(tool!.errorText!);
  assert.match(shown, /模型填写的工具参数不正确/);
  assert.match(shown, /截止时间需要 ISO 日期/);
  assert.doesNotMatch(shown, /模型服务|Type validation failed/);
  // The model is still told, in full, so it can correct the call.
  assert.match(JSON.stringify(prompts[1]), /Invalid input for tool createTask/);
  // And the record reads the same after a reload.
  const part = mapStoredMessagesToUI([row]).uiMessages[0].parts.find(item => item.type === "tool-createTask") as { input?: unknown; errorText?: string };
  assert.deepEqual(part.input, input);
  assert.equal(readToolError(part.errorText!), shown);
});

test("each kind of failure says what it is", () => {
  const invalid = new InvalidToolInputError({ toolName: "createTask", toolInput: "{}", cause: { issues: [{ code: "invalid_type", path: ["title"], message: "Required" }, { code: "custom", path: ["dueDate"], message: "日期不对" }] } });
  assert.equal(describeTurnFailure(invalid).message, "模型填写的工具参数不正确：title: Required; 日期不对");
  assert.equal(describeTurnFailure(new InvalidToolInputError({ toolName: "x", toolInput: "{}", cause: new Error("bad") })).message, "模型填写的工具参数不正确");
  assert.equal(describeTurnFailure(new NoSuchToolError({ toolName: "madeUp" })).message, "模型调用了不存在的工具：madeUp");
  const thrown = new ToolRunError(new TypeError("secret internal detail"));
  assert.equal(thrown.message, "secret internal detail", "the model still reads the original");
  assert.equal(describeTurnFailure(thrown).message, "工具执行失败");
  const known = new ApiError({ code: "NOT_FOUND", message: "没找到" });
  assert.equal(describeTurnFailure(known), known, "a failure that already says what it is stays as it is");
  // Anything else really is the provider, and that is still what it says.
  assert.equal(describeTurnFailure(new Error("socket hang up")).message, "模型服务暂时不可用，请稍后重试。");
});

test("the second report of a refused call says the same as the first, and only that one is recognized", () => {
  const read = createTurnFailureReader();
  const refused = new InvalidToolInputError({ toolName: "createTask", toolInput: "{}", cause: { issues: [{ code: "custom", path: ["dueDate"], message: "日期不对" }] } });
  const first = read(refused);
  assert.equal(read(refused.message), first);
  assert.equal(read("some other text").message, "模型服务暂时不可用，请稍后重试。");
  assert.equal(createTurnFailureReader()(refused.message).message, "模型服务暂时不可用，请稍后重试。", "another turn knows nothing of it");
});

test("a stored error reads as a sentence, and older plain text stays readable", () => {
  assert.equal(readToolError(JSON.stringify({ error: { code: "X", message: "原因", details: {} } })), "原因");
  assert.equal(readToolError("plain failure"), "plain failure");
  assert.equal(readToolError("{\"unexpected\":1}"), "{\"unexpected\":1}");
  assert.equal(readToolError("null"), "null");
});

test("a message counts as moved on from only once another user message follows it", () => {
  const message = (id: string, role: "user" | "assistant") => ({ id, role, parts: [] });
  const messages = [message("q1", "user"), message("a1", "assistant"), message("q2", "user"), message("a2", "assistant")];
  assert.equal(hasLaterUserMessage(messages, "q1"), true);
  assert.equal(hasLaterUserMessage(messages, "q2"), false, "its own answer does not count");
  assert.equal(hasLaterUserMessage(messages, "missing"), false);
});
