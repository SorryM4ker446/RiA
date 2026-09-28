import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";

const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const { saveMemory, getRelevantMemories } = await import("@/lib/memory/store");
const { persistToolMemory } = await import("@/tools/memory-policy");
const knowledgeRoute = await import("@/app/api/knowledge/route");
const knowledgeIdRoute = await import("@/app/api/knowledge/[id]/route");

let cookie: string;
const req = (path: string, method = "GET", body?: unknown) => new NextRequest(`http://localhost${path}`, {
  method,
  headers: { cookie, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const payload = async (response: Response, status = 200) => {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
};
const keysOf = (entries: { key: string }[]) => entries.map((entry) => entry.key);

beforeEach(async () => {
  globalThis.__privateAiRateLimitStore?.clear();
  cookie = localAccessCookie();
  await db.memory.deleteMany({});
});
after(async () => { await db.$disconnect(); cleanup(); });

test("a memory the assistant inferred waits for the user before it is used", async () => {
  await saveMemory({ key: "语言偏好", value: "回答请使用中文", source: "manual" });
  await persistToolMemory({
    workspaceId: "local", toolId: "createTask", trigger: "auto", state: "output-available",
    input: { title: "整理资料" }, output: { taskId: "t1" }, assistantText: "已创建任务",
  });

  const candidate = await db.memory.findFirst({ where: { key: { startsWith: "tool:" } } });
  assert.ok(candidate, "the tool memory should be stored");
  assert.equal(candidate.source, "assistant");
  assert.equal(candidate.confirmed, false);

  // It is listed, so the user can see and correct what was inferred.
  const list = await payload(await knowledgeRoute.GET(req("/api/knowledge?view=candidates")));
  assert.equal(list.data.some((row: { id: string }) => row.id === candidate.id), true);

  // And it is not in the context until it is accepted. The manual entry is what
  // proves the search itself is working: without it "not found" would look the
  // same either way.
  const before = await getRelevantMemories({ query: "回答请使用中文" });
  assert.deepEqual(keysOf(before), ["语言偏好"], "only the confirmed memory is retrieved");
  assert.equal(before.some((entry) => entry.id === candidate.id), false, "an unaccepted candidate must not be retrieved");

  await payload(await knowledgeIdRoute.PATCH(req(`/api/knowledge/${candidate.id}`, "PATCH", { confirmed: true }), context(candidate.id)));
  const after = await getRelevantMemories({ query: "createTask 任务" });
  assert.equal(after.some((entry) => entry.id === candidate.id), true, "an accepted memory is retrieved");
  // And the use is recorded, so the page can say the memory did something.
  const used = await db.memory.findUnique({ where: { id: candidate.id } });
  assert.ok(used.lastUsedAt, "using a memory should stamp when it was used");
});

test("editing a memory replaces its text and counts as accepting it", async () => {
  const created = await saveMemory({ key: "输出风格", value: "先给结论", source: "assistant" });
  assert.equal(created.confirmed, false, "an inferred entry starts as a candidate");
  const updated = await payload(await knowledgeIdRoute.PATCH(req(`/api/knowledge/${created.id}`, "PATCH", { value: "先给结论，再给三点理由" }), context(created.id)));
  assert.equal(updated.data.value, "先给结论，再给三点理由");
  assert.equal(updated.data.confirmed, true, "editing is how a wrong memory is corrected");

  const found = await getRelevantMemories({ query: "输出风格" });
  assert.equal(found.find((entry) => entry.id === created.id)?.value, "先给结论，再给三点理由");
});

test("deleting a memory stops it from being retrieved", async () => {
  const created = await saveMemory({ key: "临时记下的偏好", value: "不要使用表情符号", source: "manual" });
  assert.deepEqual(keysOf(await getRelevantMemories({ query: "不要使用表情符号" })), ["临时记下的偏好"]);
  await payload(await knowledgeIdRoute.DELETE(req(`/api/knowledge/${created.id}`, "DELETE"), context(created.id)));
  assert.deepEqual(keysOf(await getRelevantMemories({ query: "不要使用表情符号" })), []);
});

test("the knowledge list separates accepted entries from candidates", async () => {
  const manual = await saveMemory({ key: "我确认的", value: "内容 A", source: "manual" });
  const candidate = await saveMemory({ key: "待确认的", value: "内容 B", source: "assistant" });
  const confirmed = await payload(await knowledgeRoute.GET(req("/api/knowledge?view=confirmed")));
  const candidates = await payload(await knowledgeRoute.GET(req("/api/knowledge?view=candidates")));
  assert.equal(confirmed.data.some((row: { id: string }) => row.id === manual.id), true);
  assert.equal(confirmed.data.some((row: { id: string }) => row.id === candidate.id), false);
  assert.equal(candidates.data.length, 1);
  assert.equal(candidates.data[0].id, candidate.id);
  assert.equal(candidates.data[0].source, "assistant");
  // The view is opt-in, so the default still shows everything the user may edit.
  const all = await payload(await knowledgeRoute.GET(req("/api/knowledge")));
  assert.equal(all.data.length, 2);
});

test("an execution record bounds the turn and can be stopped without undoing it", async () => {
  const { startRun, checkRunAllowance, recordStep, finishRun, listRuns, cancelRun } = await import("@/lib/agent/runs");
  const { getChat, createChat } = await import("@/lib/chat/store");
  const chat = await createChat({ title: "执行记录" });
  const run = await startRun({ chatId: chat.id, goal: "整理资料并建任务" });
  assert.equal(run.status, "running");

  const step = await recordStep({ runId: run.id, position: 1, kind: "tool", toolName: "createTask", state: "done", input: { title: "整理" }, output: { taskId: "t1" } });
  assert.equal(step.state, "done");

  const budgeted = await startRun({ chatId: chat.id, goal: "会超预算的一轮", budget: { maxSteps: 1 } });
  assert.equal((await checkRunAllowance(budgeted.id)).allowed, true);
  await recordStep({ runId: budgeted.id, position: 1, kind: "tool", toolName: "createTask" });
  const refused = await checkRunAllowance(budgeted.id);
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason, "step-budget");

  // A stopped run refuses further steps and its open steps are marked, so
  // nothing is left looking like it is still in flight.
  const stopped = await cancelRun(run.id, "用户停止");
  assert.equal(stopped.status, "cancelled");
  const afterStop = await checkRunAllowance(run.id);
  assert.equal(afterStop.allowed, false);
  assert.equal(afterStop.reason, "run-cancelled");

  const views = await listRuns(chat.id);
  const view = views.find((item) => item.id === run.id);
  assert.equal(view.status, "cancelled");
  assert.equal(view.stopReason, "用户停止");
  assert.equal(view.steps.length, 1);
  // The work that already happened is still recorded as done.
  assert.equal(view.steps[0].state, "done");

  await finishRun(budgeted.id, "failed", "step-budget");
  assert.equal((await listRuns(chat.id)).find((item) => item.id === budgeted.id).status, "failed");
});

test("an ephemeral conversation neither reads nor writes long-term memory", async () => {
  const { saveMemory, getRelevantMemories } = await import("@/lib/memory/store");
  const { createChat } = await import("@/lib/chat/store");
  const { updateConversation: patchConversation } = await import("@/lib/conversations/mutations");
  await saveMemory({ key: "语言偏好", value: "回答请使用中文", source: "manual" });
  const chat = await createChat({ title: "临时会话" });
  const updated = await patchConversation(chat.id, { ephemeral: true });
  assert.equal(updated.ephemeral, true);
  // The switch belongs to the conversation, so another one is unaffected.
  const other = await createChat({ title: "普通会话" });
  assert.equal((await patchConversation(other.id, { pinned: true })).ephemeral, false);
});

test("the stated preferences reach the prompt, and an empty preference section does not", async () => {
  const { formatPersona, buildSystemPrompt } = await import("@/lib/chat/model-context");
  const persona = { name: "老王", language: "中文", answerStyle: "先给结论", notes: "避免术语" };
  const rendered = formatPersona(persona);
  assert.match(rendered, /Address the user as: 老王\./);
  assert.match(rendered, /Reply in: 中文\./);
  assert.match(rendered, /Answer style: 先给结论\./);
  const prompt = buildSystemPrompt("none", "none", true, [], persona);
  assert.match(prompt, /\[User Preferences\]/);
  // Nothing stated means nothing rendered: an empty section would invite the
  // model to invent a preference the user never expressed.
  assert.equal(formatPersona({ name: "", language: "", answerStyle: "", notes: "" }), "");
  assert.equal(formatPersona(null), "");
  assert.equal(buildSystemPrompt("none", "none", true, []).includes("[User Preferences]"), false);
});

test("a conversation scoped to a topic does not retrieve documents outside it", async () => {
  const { indexDocument } = await import("@/lib/documents/store");
  const { searchDocuments } = await import("@/lib/documents/retrieval");
  await indexDocument({
    filename: "范围内.md",
    collection: "产品资料",
    format: "md",
    byteSize: 10,
    pages: [{ pageNumber: 1, text: "部署流程与回滚窗口的说明" }],
  });
  await indexDocument({
    filename: "范围外.md",
    collection: "私人笔记",
    format: "md",
    byteSize: 10,
    pages: [{ pageNumber: 1, text: "部署流程的私人记录" }],
  });

  const all = await searchDocuments("部署流程");
  assert.equal(all.length, 2, "an unscoped search sees every topic");

  const scoped = await searchDocuments("部署流程", 4, ["产品资料"]);
  assert.deepEqual(scoped.map((source) => source.filename), ["范围内.md"], "a scoped search ignores other topics");
  // An empty scope is not a scope of nothing; it is the default of everything.
  assert.equal((await searchDocuments("部署流程", 4, [""])).length, 2);
});

test("a long conversation is summarized without losing the original messages", async () => {
  const { summarizeOlderTurns, describeSummaryCoverage, SUMMARY_TRIGGER_MESSAGES } = await import("@/lib/chat/summary");
  const { createChat, saveChatMessage } = await import("@/lib/chat/store");
  // Summarizing needs a chat model; without one the caller keeps the excerpts.
  const { seedTestModelPreferences } = await import("../helpers/model-library");
  await seedTestModelPreferences(db);
  const chat = await createChat({ title: "长对话" });
  const messages = [];
  for (let index = 0; index < SUMMARY_TRIGGER_MESSAGES + 6; index += 1) {
    const message = await saveChatMessage({ chatId: chat.id, role: index % 2 === 0 ? "user" : "assistant", content: `第 ${index} 条消息` });
    messages.push({ id: message.id, role: index % 2 === 0 ? "user" : "assistant", text: `第 ${index} 条消息` });
  }

  // The summary is a condensation, not a replacement: the turns it covers are
  // still there afterwards.
  const result = await summarizeOlderTurns({ chatId: chat.id, messages, keepRecent: 10 });
  assert.ok(result, "a long conversation should produce a summary");
  const stored = await db.chat.findUnique({ where: { id: chat.id } });
  assert.equal(stored.summaryUpToMessageId, result.upToMessageId);
  assert.ok((await db.message.count({ where: { chatId: chat.id } })) >= SUMMARY_TRIGGER_MESSAGES, "the messages are kept");

  // Asked again about the same span, nothing is summarized twice.
  assert.equal(await summarizeOlderTurns({ chatId: chat.id, messages, keepRecent: 10 }), null);
  assert.equal(describeSummaryCoverage({ upToMessageId: stored.summaryUpToMessageId }).includes("摘要"), true);
  assert.equal(describeSummaryCoverage({ upToMessageId: null }).length > 0, true);

  // A short conversation is left alone rather than summarized for no reason.
  const short = await summarizeOlderTurns({ chatId: chat.id, messages: messages.slice(0, 4), keepRecent: 10 });
  assert.equal(short, null);
});
