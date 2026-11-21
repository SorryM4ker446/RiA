import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
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
const { cleanTitle, nameConversation, TITLE_ATTEMPTS } = await import("@/lib/chat/conversation-title");
const { encodePersistedUserMessage } = await import("@/lib/ai/ui-message");
const chatRoute = await import("@/app/api/chat/route");
const conversationsRoute = await import("@/app/api/conversations/route");
const conversationRoute = await import("@/app/api/conversations/[id]/route");
const messagesRoute = await import("@/app/api/conversations/[id]/messages/route");
const liveTurns = await import("@/lib/chat/live-turns");

beforeEach(async (t: TestContext) => {
  for (const method of ["error", "info", "warn"] as const) t.mock.method(console, method, () => {});
  resetProviderState(); globalThis.__riaRateLimitStore?.clear();
  process.env.APP_RUNTIME = "test"; process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  await db.chat.deleteMany({});
  await seedTestModelPreferences(db);
});
after(async () => { await db.$disconnect(); cleanup(); });

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
/** The title model's replies in turn, and what it was asked. */
function titles(t: TestContext, replies: Array<string | Error | (() => Promise<string>)>) {
  const prompts: string[] = [];
  t.mock.method(languageModel, "doGenerate", async (options: { prompt: unknown }): Promise<LanguageModelV3GenerateResult> => {
    prompts.push(JSON.stringify(options.prompt));
    const next = replies.shift() ?? "{\"title\": \"\"}";
    if (next instanceof Error) throw next;
    const text = typeof next === "function" ? await next() : next;
    return { content: [{ type: "text", text }], finishReason: { unified: "stop", raw: undefined }, warnings: [], usage };
  });
  return prompts;
}
async function conversation(lines: Array<["user" | "assistant", string]>, titleSource = "auto") {
  const chat = await db.chat.create({ data: { title: lines[0][1].slice(0, 60), titleSource } });
  for (const [index, [role, content]] of lines.entries()) await db.message.create({ data: { chatId: chat.id, role, content, createdAt: new Date(Date.now() + index) } });
  return chat.id;
}
const titleOf = async (id: string) => db.chat.findUniqueOrThrow({ where: { id }, select: { title: true, titleSource: true } });

test("a greeting is not named; the request that follows is, once, and the title then stays", async t => {
  const prompts = titles(t, ["{\"title\": \"\"}", "{\"title\": \"精简周报\"}", "{\"title\": \"别的标题\"}"]);
  const id = await conversation([["user", "你好"], ["assistant", "你好！有什么可以帮你的吗？"]]);
  assert.equal(await nameConversation(id, CHAT_MODEL_REF), null);
  assert.deepEqual(await titleOf(id), { title: "你好", titleSource: "auto" }, "the first message stays the title meanwhile");
  await db.message.create({ data: { chatId: id, role: "user", content: "帮我把这份周报改得更简洁一点" } });
  assert.equal(await nameConversation(id, CHAT_MODEL_REF), "精简周报");
  assert.deepEqual(await titleOf(id), { title: "精简周报", titleSource: "named" });
  // It read the conversation as data, latest request first in mind.
  assert.match(prompts[1], /Prioritize the latest substantive user request/);
  assert.match(prompts[1], /帮我把这份周报改得更简洁一点/);
  // Named once: a later message does not rename it.
  await db.message.create({ data: { chatId: id, role: "user", content: "再加一段下周计划" } });
  assert.equal(await nameConversation(id, CHAT_MODEL_REF), null);
  assert.equal((await titleOf(id)).title, "精简周报");
  assert.equal(prompts.length, 2);
});

test("a name the user gives while a title is being written is kept", async t => {
  let release!: () => void;
  titles(t, [() => new Promise(resolve => { release = () => resolve("{\"title\": \"模型的标题\"}"); })]);
  const id = await conversation([["user", "整理第三季度销售数据"]]);
  const naming = nameConversation(id, CHAT_MODEL_REF);
  await new Promise(resolve => setTimeout(resolve, 20));
  const renamed = await conversationRoute.PATCH(new NextRequest(`http://localhost/api/conversations/${id}`, {
    method: "PATCH", headers: { host: "localhost", cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify({ title: "我的季度报告" }),
  }), { params: Promise.resolve({ id }) });
  assert.equal(renamed.status, 200);
  release();
  assert.equal(await naming, null);
  assert.deepEqual(await titleOf(id), { title: "我的季度报告", titleSource: "manual" });
});

test("a failed or malformed reply keeps the first message and is tried again with the next message, up to a limit", async t => {
  titles(t, [new Error("provider down"), "not json at all", "{\"title\": \"\"}", "{\"title\": \"太晚的标题\"}"]);
  const id = await conversation([["user", "能帮我个忙吗"]]);
  assert.equal(await nameConversation(id, CHAT_MODEL_REF), null);
  assert.deepEqual(await titleOf(id), { title: "能帮我个忙吗", titleSource: "auto" });
  await db.message.create({ data: { chatId: id, role: "user", content: "嗯" } });
  assert.equal(await nameConversation(id, CHAT_MODEL_REF), null);
  await db.message.create({ data: { chatId: id, role: "user", content: "随便聊聊" } });
  // The last attempt still names nothing: the first message stays the title for good.
  assert.equal(await nameConversation(id, CHAT_MODEL_REF), null);
  assert.deepEqual(await titleOf(id), { title: "能帮我个忙吗", titleSource: "named" });
  assert.equal(TITLE_ATTEMPTS, 3);
});

test("RiA's own notices are not the user's words, and titles that are not automatic are left alone", async t => {
  const prompts = titles(t, ["{\"title\": \"Debug React useEffect\"}"]);
  const notice = encodePersistedUserMessage({ type: "user-message", text: "[Automatic notice from RiA] Background sub-agents ended.", files: [], notice: { kind: "subagents", titles: ["x"] } });
  const id = await conversation([["user", "My useEffect fires twice in dev"], ["user", notice]]);
  assert.equal(await nameConversation(id, CHAT_MODEL_REF), "Debug React useEffect");
  assert.doesNotMatch(prompts[0], /Automatic notice/);
  const manual = await conversation([["user", "anything"]], "manual");
  const named = await conversation([["user", "anything"]], "named");
  assert.equal(await nameConversation(manual, CHAT_MODEL_REF), null);
  assert.equal(await nameConversation(named, CHAT_MODEL_REF), null);
  assert.equal(prompts.length, 1, "no call for a title that is not automatic");
});

test("what the model writes is tidied into a short single-line title", () => {
  assert.equal(cleanTitle("  “合并 CSV 到 Excel。”  "), "合并 CSV 到 Excel");
  assert.equal(cleanTitle("Decline vendor renewal offer!"), "Decline vendor renewal offer");
  assert.equal(cleanTitle("line one\nline two"), "line one line two");
  assert.equal(Array.from(cleanTitle("非常".repeat(30))).length, 36);
  assert.equal(cleanTitle(""), "");
  assert.equal(cleanTitle(42), "");
});

test("a name identical to an empty conversation's title survives its first saved message", async () => {
  const chat = await db.chat.create({ data: { title: "New Chat", titleSource: "manual" } });
  const id = chat.id;
  const response = await messagesRoute.POST(new NextRequest(`http://localhost/api/conversations/${id}/messages`, {
    method: "POST", headers: { host: "localhost", cookie: localAccessCookie(), "content-type": "application/json" },
    body: JSON.stringify({ role: "user", content: "Plan the team trip" }),
  }), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 201);
  assert.deepEqual(await titleOf(id), { title: "New Chat", titleSource: "manual" });
});

test("a conversation's turn names it once answered, without holding the answer, and a title given on creation is kept", async t => {
  titles(t, ["{\"title\": \"上海团建方案\"}"]);
  // The page creates it from the first message: automatic.
  const created = await conversationsRoute.POST(new NextRequest("http://localhost/api/conversations", {
    method: "POST", headers: { host: "localhost", cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify({ title: "预算人均300，20人", titleSource: "auto" }),
  }));
  const id = (await created.json()).data.id as string;
  const message: UIMessage = { id: `user-${Date.now()}`, role: "user", parts: [{ type: "text", text: "预算人均300，20人，上海，周六一天，求团建方案" }] };
  const response = await chatRoute.POST(new NextRequest("http://localhost/api/chat", { method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify({ chatId: id, messages: [message] }) }));
  assert.equal(response.status, 200);
  await wireText(response);
  for (let wait = 0; wait < 100 && (await titleOf(id)).titleSource === "auto"; wait++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(await titleOf(id), { title: "上海团建方案", titleSource: "named" });
  assert.equal(liveTurns.isTurnLive(id), false);
  // Given a title on creation without saying it came from the first message: that is its name.
  const given = await conversationsRoute.POST(new NextRequest("http://localhost/api/conversations", {
    method: "POST", headers: { host: "localhost", cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify({ title: "第一段" }),
  }));
  assert.equal((await titleOf((await given.json()).data.id)).titleSource, "manual");
});
