import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { createChat } = await import("@/lib/chat/store");
const { runsWithoutAsking, APPROVAL_RULES } = await import("@/lib/approvals/rules");
const { conversationApprovalRule } = await import("@/lib/local-files/workspace");
const preferencesRoute = await import("@/app/api/approval-preferences/route");
const conversationRoute = await import("@/app/api/conversations/[id]/route");

const request = (path: string, method = "GET", body?: unknown, cookie = localAccessCookie()) => new NextRequest(`http://localhost${path}`, {
  method, headers: { host: "localhost", cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {});
  globalThis.__riaRateLimitStore?.clear();
  await db.scheduledJob.deleteMany({});
  await db.chat.deleteMany({});
  await db.approvalPreference.deleteMany({});
});
after(async () => { await db.$disconnect(); cleanup(); });

test("each rule decides edits and commands as named: ask asks for both, accepting edits covers edits only, full covers both", () => {
  assert.deepEqual(APPROVAL_RULES.map(rule => [rule, runsWithoutAsking(rule, "edit"), runsWithoutAsking(rule, "command")]), [
    ["ask", false, false],
    ["acceptEdits", true, false],
    ["full", true, true],
  ]);
});

test("a new conversation starts from the default rule, and keeps its own when the default changes", async () => {
  // Nothing chosen yet: ask.
  const read = await preferencesRoute.GET(request("/api/approval-preferences"));
  assert.deepEqual((await read.json()).data, { defaultRule: "ask" });
  const before = await createChat({ title: "Before" });
  assert.equal(before.approvalRule, "ask");
  assert.equal((await preferencesRoute.PUT(request("/api/approval-preferences", "PUT", { defaultRule: "full" }, ""))).status, 401);
  assert.equal((await preferencesRoute.PUT(request("/api/approval-preferences", "PUT", { defaultRule: "sometimes" }))).status, 400);
  assert.equal((await preferencesRoute.PUT(request("/api/approval-preferences", "PUT", { defaultRule: "full", extra: true }))).status, 400);
  assert.equal((await preferencesRoute.PUT(request("/api/approval-preferences", "PUT", { defaultRule: "acceptEdits" }))).status, 200);
  const later = await createChat({ title: "Later" });
  assert.equal(later.approvalRule, "acceptEdits");
  assert.equal((await db.chat.findUniqueOrThrow({ where: { id: before.id } })).approvalRule, "ask", "an existing conversation keeps its rule");
});

test("a conversation changes its own rule, which the next call reads; a task's conversation follows the task's", async () => {
  const chat = await createChat({ title: "Rule" });
  const changed = await conversationRoute.PATCH(request(`/api/conversations/${chat.id}`, "PATCH", { approvalRule: "full" }), ctx(chat.id));
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).data.approvalRule, "full");
  assert.equal(await conversationApprovalRule(chat.id), "full");
  assert.equal((await conversationRoute.PATCH(request(`/api/conversations/${chat.id}`, "PATCH", { approvalRule: "never" }), ctx(chat.id))).status, 400);

  await db.scheduledJob.create({ data: { kind: "prompt", title: "Task", prompt: "Do it.", timeZone: "UTC", nextRunAt: null, chatId: chat.id, approvalRule: "ask", usesMemory: true } });
  assert.equal(await conversationApprovalRule(chat.id), "ask", "the task's rule, not the conversation's own");
  const summary = (await (await conversationRoute.GET(request(`/api/conversations/${chat.id}`), ctx(chat.id))).json()).data;
  assert.deepEqual([summary.approvalRule, summary.ephemeral], ["ask", false], "the task's rule and memory switch are what the conversation shows");
  // The task's settings are changed on the task, not through its conversation.
  for (const body of [{ approvalRule: "full" }, { ephemeral: true }]) {
    assert.equal((await conversationRoute.PATCH(request(`/api/conversations/${chat.id}`, "PATCH", body), ctx(chat.id))).status, 409);
  }
  assert.equal(await conversationApprovalRule(null), "ask");
});
