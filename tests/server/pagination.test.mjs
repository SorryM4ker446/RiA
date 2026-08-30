import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database.mjs";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { createSession } = await import("@/lib/auth/session");
const chats = await import("@/app/api/conversations/route");
const messages = await import("@/app/api/conversations/[id]/messages/route");
const detail = await import("@/app/api/conversations/[id]/route");
const memory = await import("@/app/api/memory/route");
const retrieval = await import("@/app/api/retrieval/route");
const { getRegenerationSnapshot, saveRegeneratedResponse } = await import("@/lib/chat/store");
let user, cookie;
const context = (id) => ({ params: Promise.resolve({ id }) });
const request = (path, auth = cookie, body) => new NextRequest(`http://localhost${path}`, {
  method: body ? "POST" : "GET", headers: { ...(auth ? { cookie: auth } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
beforeEach(async (t) => {
  t.mock.method(console, "error", () => {});
  user = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  cookie = `app_session=${await createSession(user.id)}`;
});
after(async () => { await db.$disconnect(); cleanup(); });

test("conversation cursors page equal timestamps without duplicates and survive anchor deletion", async () => {
  const date = new Date("2026-08-01T00:00:00Z");
  const ids = Array.from({ length: 65 }, (_, i) => `${user.id}-${String(i).padStart(3, "0")}`);
  await db.chat.createMany({ data: ids.map((id) => ({ id, userId: user.id, title: id, lastMessageAt: date })) });
  const first = await (await chats.GET(request("/api/conversations"))).json();
  assert.equal(first.data.length, 30);
  assert.deepEqual(first.data.map((row) => row.id), ids.slice(-30).reverse());
  const boundary = first.data.at(-1).id;
  await db.chat.delete({ where: { id: boundary } });
  await db.chat.create({ data: { userId: user.id, title: "New arrival", lastMessageAt: new Date() } });
  const collected = first.data.map((row) => row.id);
  let cursor = first.pageInfo.nextCursor;
  while (cursor) {
    const page = await (await chats.GET(request(`/api/conversations?cursor=${cursor}`))).json();
    collected.push(...page.data.map((row) => row.id));
    cursor = page.pageInfo.nextCursor;
  }
  assert.deepEqual(collected, [...ids].reverse());
});

test("message pages return the newest bounded window in chronological order", async () => {
  const chat = await db.chat.create({ data: { userId: user.id, title: "Long history" } });
  const ids = Array.from({ length: 125 }, (_, i) => `${chat.id}-${String(i).padStart(3, "0")}`);
  await db.message.createMany({ data: ids.map((id) => ({ id, chatId: chat.id, role: "user", content: id, createdAt: new Date("2026-08-01T00:00:00Z") })) });
  const first = await (await messages.GET(request(`/api/conversations/${chat.id}/messages`), context(chat.id))).json();
  assert.equal(first.data.length, 50);
  assert.deepEqual(first.data.map((row) => row.id), ids.slice(-50));
  let cursor = first.pageInfo.nextCursor;
  let collected = first.data.map((row) => row.id);
  while (cursor) {
    const page = await (await messages.GET(request(`/api/conversations/${chat.id}/messages?cursor=${cursor}`), context(chat.id))).json();
    collected = [...page.data.map((row) => row.id), ...collected];
    cursor = page.pageInfo.nextCursor;
  }
  assert.deepEqual(collected, ids);
  assert.equal((await (await detail.GET(request(`/api/conversations/${chat.id}`), context(chat.id))).json()).data.messageCount, 125);
});

test("pagination validates limits and cursor scope after authentication", async () => {
  for (const query of ["limit=0", "limit=101", "limit=1.5", "limit=", "limit=-1", "limit=2&limit=3", "cursor=garbage", "cursor=", "unexpected=1"]) {
    const response = await chats.GET(request(`/api/conversations?${query}`));
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).error.code, "VALIDATION_ERROR");
  }
  assert.equal((await chats.GET(request("/api/conversations?limit=bad", null))).status, 401);
  await db.chat.createMany({ data: [{ userId: user.id, title: "one" }, { userId: user.id, title: "two" }] });
  const first = await (await chats.GET(request("/api/conversations?limit=1"))).json();
  const other = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  const otherCookie = `app_session=${await createSession(other.id)}`;
  assert.equal((await chats.GET(request(`/api/conversations?cursor=${first.pageInfo.nextCursor}`, otherCookie))).status, 400);
  const chatId = first.data[0].id;
  assert.equal((await messages.GET(request(`/api/conversations/${chatId}/messages`, otherCookie), context(chatId))).status, 404);
  assert.equal((await messages.GET(request(`/api/conversations/${chatId}/messages?cursor=${first.pageInfo.nextCursor}`), context(chatId))).status, 400);
});

test("conversation details count history without loading or migrating media", async () => {
  const chat = await db.chat.create({ data: { userId: user.id, title: "Count only" } });
  const content = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8XcAAAAASUVORK5CYII=";
  await db.message.create({ data: { chatId: chat.id, role: "assistant", content } });
  const response = await detail.GET(request(`/api/conversations/${chat.id}`), context(chat.id));
  assert.equal((await response.json()).data.messageCount, 1);
  assert.equal(await db.mediaAsset.count({ where: { userId: user.id } }), 0);
  assert.equal((await db.message.findFirst({ where: { chatId: chat.id } })).content, content);
});

test("regeneration snapshots inspect only the affected tail and preserve earlier edits", async () => {
  const chat = await db.chat.create({ data: { userId: user.id, title: "Long regeneration" } });
  const ids = Array.from({ length: 120 }, (_, i) => `${chat.id}-${String(i).padStart(3, "0")}`);
  await db.message.createMany({ data: ids.map((id, i) => ({ id, chatId: chat.id, role: i % 2 ? "assistant" : "user", content: id, createdAt: new Date(Date.parse("2026-08-01T00:00:00Z") + i * 1000) })) });
  const snapshot = await getRegenerationSnapshot(user.id, chat.id, ids[118]);
  assert.deepEqual(snapshot.messages.map((row) => row.id), ids.slice(118));
  await db.message.update({ where: { id: ids[0] }, data: { content: "Earlier edit must remain" } });
  await saveRegeneratedResponse({ snapshot, userMessageId: ids[118], content: "Replacement", clientMessageId: "regenerated" });
  assert.equal((await db.message.findUnique({ where: { id: ids[0] } })).content, "Earlier edit must remain");
  assert.equal(await db.message.count({ where: { chatId: chat.id } }), 120);
  assert.equal(await db.message.findUnique({ where: { id: ids[119] } }), null);
});

test("local memory and retrieval integrations retain authenticated user scoping", async () => {
  const saved = await memory.POST(request("/api/memory", cookie, { key: "旅行偏好", value: "喜欢云南徒步", score: 0.8 }));
  assert.equal(saved.status, 201);
  const found = await retrieval.POST(request("/api/retrieval", cookie, { query: "云南徒步", limit: 3 }));
  assert.equal((await found.json()).data[0].key, "旅行偏好");
  const other = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  const otherCookie = `app_session=${await createSession(other.id)}`;
  const empty = await memory.GET(request("/api/memory?query=云南徒步", otherCookie));
  assert.deepEqual((await empty.json()).data, []);
});
