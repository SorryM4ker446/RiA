import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database.mjs";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { createSession } = await import("@/lib/auth/session");
const { saveChatMessage, getRegenerationSnapshot, saveRegeneratedResponse } = await import("@/lib/chat/store");
const { createMediaAsset, getMediaAsset } = await import("@/lib/media/storage");
const { USER_MESSAGE_PREFIX, ASSISTANT_TOOL_MESSAGE_PREFIX } = await import("@/lib/ai/ui-message");
const { IMAGE_MESSAGE_PREFIX } = await import("@/lib/media/message-codec");
const routes = {
  list: await import("@/app/api/conversations/route"),
  detail: await import("@/app/api/conversations/[id]/route"),
  bulk: await import("@/app/api/conversations/bulk-delete/route"),
  export: await import("@/app/api/conversations/[id]/export/route"),
};
let user, other, cookie, otherCookie;
const context = id => ({ params: Promise.resolve({ id }) });
const request = (path = "", method = "GET", body, auth = cookie, headers = {}) => new NextRequest(`http://localhost/api/conversations${path}`, {
  method, headers: { cookie: auth, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function data(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return (await response.json()).data;
}
async function create(title = "Original", owner = user, extra = {}) {
  return db.chat.create({ data: { title, userId: owner.id, ...extra } });
}
async function search(q, auth = cookie, extra = {}) {
  return data(await routes.list.GET(request(`?${new URLSearchParams({ q, ...extra })}`, "GET", undefined, auth)));
}
async function update(id, body, auth = cookie) { return routes.detail.PATCH(request(`/${id}`, "PATCH", body, auth), context(id)); }
beforeEach(async t => {
  t.mock.method(console, "error", () => {});
  globalThis.__privateAiRateLimitStore?.clear();
  user = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  other = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  cookie = `app_session=${await createSession(user.id)}`;
  otherCookie = `app_session=${await createSession(other.id)}`;
});
after(async () => { await db.$disconnect(); cleanup(); });

test("full conversation search finds titles and old Chinese or English message text without indexing media or tool internals", async () => {
  const chat = await create("Launch archive");
  await db.message.createMany({ data: Array.from({ length: 80 }, (_, i) => ({ chatId: chat.id, role: "user", content: i ? `Later message ${i}` : "最早的月光旅行计划 Aurora launch" })) });
  await db.message.create({ data: { chatId: chat.id, role: "user", content: USER_MESSAGE_PREFIX + JSON.stringify({ type: "user-message", text: "附件正文可检索", files: [{ mediaType: "image/png", url: "data:image/png;base64,never-index-media" }] }) } });
  await db.message.create({ data: { chatId: chat.id, role: "assistant", content: ASSISTANT_TOOL_MESSAGE_PREFIX + JSON.stringify({ type: "assistant-tool-message", text: "工具可见回答", tools: [{ toolName: "createTask", toolCallId: "call", state: "output-available", input: { secret: "never-index-tool" } }] }) } });
  for (const q of ["launch", "月光旅行", "月光", "AURORA", "附件正文", "工具可见"]) assert.deepEqual((await search(q)).map(row => row.id), [chat.id]);
  for (const q of ["never-index-media", "never-index-tool", "missing text"]) assert.deepEqual(await search(q), []);
  assert.deepEqual(await search("月光旅行", otherCookie), []);
  await db.$disconnect();
  assert.equal((await search("月光旅行")).length, 1);
});

test("search treats punctuation and FTS operators literally instead of widening the query", async () => {
  const chat = await create();
  for (const content of ['100%_ done', 'literal "quoted" text', 'literal OR expression', 'emoji 😀😃 text']) await db.message.create({ data: { chatId: chat.id, role: "user", content } });
  for (const q of ["%_", '"quoted"', "OR expression", "😀😃"]) assert.equal((await search(q)).length, 1, q);
  for (const q of ['" OR missing', "one OR two", "%; DROP TABLE chats;--"]) assert.deepEqual(await search(q), []);
  assert.equal(await db.chat.count({ where: { userId: user.id } }), 1);
});

test("SQL search indexes follow title edits, message edits, regeneration and cascading deletion", async () => {
  const chat = await create("Old title marker");
  const original = await saveChatMessage({ chatId: chat.id, role: "user", content: "Original question", clientMessageId: "user" });
  await saveChatMessage({ chatId: chat.id, role: "assistant", content: "Old answer marker", clientMessageId: "assistant" });
  await data(await update(chat.id, { title: "New title marker" }));
  assert.equal((await search("New title marker")).length, 1);
  assert.deepEqual(await search("Old title marker"), []);
  await db.message.update({ where: { id: original.id }, data: { content: "Edited question marker" } });
  assert.deepEqual(await search("Original question"), []);
  assert.equal((await search("Edited question marker")).length, 1);
  const snapshot = await getRegenerationSnapshot(user.id, chat.id, "user");
  await saveRegeneratedResponse({ snapshot, userMessageId: "user", content: "Regenerated answer marker", clientMessageId: "replacement" });
  assert.deepEqual(await search("Old answer marker"), []);
  assert.equal((await search("Regenerated answer marker")).length, 1);
  assert.equal((await routes.detail.DELETE(request(`/${chat.id}`, "DELETE"), context(chat.id))).status, 200);
  assert.deepEqual(await search("Regenerated answer marker"), []);
  assert.equal((await db.$queryRaw`SELECT count(*) AS count FROM message_text_search WHERE message_text_search MATCH '"Regenerated answer marker"'`)[0].count, 0n);
});

test("pinned ordering, archive state and normalized tags compose with stable scoped pagination", async () => {
  const date = new Date("2026-08-01T00:00:00Z");
  const chats = [];
  for (let i = 0; i < 7; i++) chats.push(await create(`Match ${i}`, user, { pinned: i < 3, lastMessageAt: date, id: `${user.id}-${i}` }));
  const archived = await create("Match archived", user, { pinned: true, archived: true });
  await data(await update(chats[0].id, { tags: [" Work ", "ＷＯＲＫ", "学习"] }));
  const tagged = await search("Match", cookie, { tag: "WORK" });
  assert.deepEqual(tagged.map(row => row.id), [chats[0].id]);
  assert.deepEqual(tagged[0].tags, ["work", "学习"]);
  const first = await (await routes.list.GET(request("?limit=2"))).json();
  const ids = first.data.map(row => row.id);
  await db.chat.delete({ where: { id: first.data.at(-1).id } });
  let cursor = first.pageInfo.nextCursor;
  while (cursor) {
    const page = await (await routes.list.GET(request(`?limit=2&cursor=${cursor}`))).json();
    ids.push(...page.data.map(row => row.id)); cursor = page.pageInfo.nextCursor;
  }
  assert.deepEqual(ids, [chats[2].id, chats[1].id, chats[0].id, chats[6].id, chats[5].id, chats[4].id, chats[3].id]);
  assert.deepEqual((await data(await routes.list.GET(request("?state=archived")))).map(row => row.id), [archived.id]);
  for (const suffix of ["&state=all", "&tag=work", "&q=Match"]) assert.equal((await routes.list.GET(request(`?cursor=${first.pageInfo.nextCursor}${suffix}`))).status, 400);
  assert.equal((await routes.list.GET(request(`?cursor=${first.pageInfo.nextCursor}`, "GET", undefined, otherCookie))).status, 400);
  await data(await update(archived.id, { archived: false }));
  assert.equal((await data(await routes.list.GET(request())))[0].id, archived.id);
});

test("conversation metadata and query validation reject malformed or foreign updates atomically", async () => {
  const chat = await create();
  for (const body of [{}, { title: "Changed", pinned: "true" }, { archived: 1 }, { tags: ["bad,tag"] }, { tags: ["bad，tag"] }, { tags: Array(9).fill("tag") }, { tags: ["x".repeat(33)] }, { userId: other.id }]) {
    assert.equal((await update(chat.id, body)).status, 400);
    assert.equal((await db.chat.findUnique({ where: { id: chat.id } })).title, "Original");
  }
  assert.equal((await update(chat.id, { pinned: true }, otherCookie)).status, 404);
  for (const query of ["q=x", "q=one&q=two", "tag=one&tag=two", "state=wrong", "state=all&state=active", "unexpected=1", "limit=101", "q=%00abc"]) assert.equal((await routes.list.GET(request(`?${query}`))).status, 400, query);
  await db.session.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(0) } });
  assert.equal((await update(chat.id, { archived: true })).status, 401);
  assert.equal((await routes.list.GET(request("?q=Original"))).status, 401);
});

test("bulk deletion requires explicit confirmation, rejects mixed ownership and retains shared private media", async () => {
  const first = await create("Delete one"), second = await create("Delete two"), keep = await create("Keep"), foreign = await create("Other", other);
  const asset = await createMediaAsset({ userId: user.id, mediaType: "image/png", kind: "attachment", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8XcAAAAASUVORK5CYII=", "base64") });
  for (const chat of [first, keep]) await saveChatMessage({ chatId: chat.id, role: "user", content: USER_MESSAGE_PREFIX + JSON.stringify({ type: "user-message", text: "Shared attachment", files: [{ url: `/api/media/${asset.id}`, mediaType: "image/png" }] }) });
  await data(await update(first.id, { tags: ["delete-tag"] }));
  for (const body of [{ ids: [first.id] }, { ids: [first.id], confirm: false }, { ids: [first.id, first.id], confirm: true }, { ids: [], confirm: true }, { ids: Array.from({ length: 51 }, (_, i) => `id-${i}`), confirm: true }]) assert.equal((await routes.bulk.POST(request("/bulk-delete", "POST", body))).status, 400);
  assert.equal((await routes.bulk.POST(request("/bulk-delete", "POST", { ids: [first.id, foreign.id], confirm: true }))).status, 404);
  assert.ok(await db.chat.findUnique({ where: { id: first.id } }));
  await db.mediaAsset.update({ where: { id: asset.id }, data: { lastUsedAt: new Date(0) } });
  const result = await data(await routes.bulk.POST(request("/bulk-delete", "POST", { ids: [first.id, second.id], confirm: true })));
  assert.equal(result.deletedCount, 2);
  assert.equal(await db.chatTag.count({ where: { chatId: first.id } }), 0);
  assert.equal(await db.messageMedia.count({ where: { assetId: asset.id } }), 1);
  assert.ok((await getMediaAsset(user.id, asset.id)).lastUsedAt.getTime() > 0);
  assert.deepEqual((await search("Shared attachment")).map(row => row.id), [keep.id]);
});

test("exports include complete ordered text and safe references without binary, paths or tool credentials", async () => {
  const chat = await create("Export <script>title</script>");
  await data(await update(chat.id, { pinned: true, archived: true, tags: ["export"] }));
  for (let i = 0; i < 65; i++) await db.message.create({ data: { chatId: chat.id, role: i % 2 ? "assistant" : "user", content: `Message ${i}`, createdAt: new Date(1_000 + i * 1_000) } });
  await db.message.create({ data: { chatId: chat.id, role: "assistant", content: IMAGE_MESSAGE_PREFIX + JSON.stringify({ type: "image-result", text: "Generated image prompt", modelId: "test", dataUrl: "data:image/png;base64,not-exported-binary", relativePath: "not-exported-path" }) } });
  await db.message.create({ data: { chatId: chat.id, role: "assistant", content: ASSISTANT_TOOL_MESSAGE_PREFIX + JSON.stringify({ type: "assistant-tool-message", text: "Tool answer\n```\n<script>untrusted</script>", tools: [{ toolName: "testTool", state: "output-available", toolCallId: "call", input: { key: "not-exported-secret" }, output: { path: "not-exported-path" } }] }) } });
  const response = await routes.export.GET(request(`/${chat.id}/export?format=json`), context(chat.id));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /^attachment; filename="conversation-[a-f0-9]{12}\.json"$/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const json = await response.json();
  assert.equal(json.messages.length, 67);
  assert.equal(json.messages[0].text, "Message 0");
  assert.equal(json.messages[64].text, "Message 64");
  assert.equal(json.conversation.archived, true);
  for (const marker of ["not-exported-binary", "not-exported-path", "not-exported-secret", user.id]) assert.equal(JSON.stringify(json).includes(marker), false);
  const markdown = await routes.export.GET(request(`/${chat.id}/export?format=markdown`), context(chat.id));
  const text = await markdown.text();
  assert.equal(markdown.status, 200);
  assert.match(text, /````text\nTool answer/);
  assert.match(text, /Message 64/);
  assert.equal(text.includes("# Export <script>"), false);
  assert.equal((await routes.export.GET(request(`/${chat.id}/export?format=json`, "GET", undefined, otherCookie), context(chat.id))).status, 404);
  assert.equal((await routes.export.GET(request(`/${chat.id}/export?format=xml`), context(chat.id))).status, 400);
});

test("export refuses oversized histories instead of silently truncating them", async () => {
  const chat = await create();
  await db.message.createMany({ data: Array.from({ length: 5001 }, (_, i) => ({ chatId: chat.id, role: "user", content: `Line ${i}` })) });
  const response = await routes.export.GET(request(`/${chat.id}/export?format=json`), context(chat.id));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "PAYLOAD_TOO_LARGE");
  assert.equal(response.headers.get("content-disposition"), null);
});

test("exports preserve owned asset references and citation snapshots while excluding internal tool fields", async () => {
  const chat = await create("Safe export");
  const asset = await createMediaAsset({ userId: user.id, mediaType: "image/png", kind: "attachment", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8XcAAAAASUVORK5CYII=", "base64") });
  await saveChatMessage({ chatId: chat.id, role: "user", content: USER_MESSAGE_PREFIX + JSON.stringify({ type: "user-message", text: "Attachment text", files: [{ url: `/api/media/${asset.id}`, mediaType: "image/png" }] }) });
  await db.message.create({ data: { chatId: chat.id, role: "assistant", content: ASSISTANT_TOOL_MESSAGE_PREFIX + JSON.stringify({
    type: "assistant-tool-message", text: "Cited answer", tools: [{ toolName: "knowledgeSearch", state: "output-available", toolCallId: "never-export-call", approval: { id: "never-export-approval" }, output: { path: "never-export-path" } }],
    documentSources: [{ documentId: "doc", chunkId: "chunk", filename: "manual.md", ordinal: 0, pageNumber: null, snippet: "Retained citation excerpt" }],
  }) } });
  const response = await routes.export.GET(request(`/${chat.id}/export?format=json`), context(chat.id));
  const snapshot = await response.json();
  assert.equal(response.status, 200);
  assert.equal(snapshot.messages[0].attachments[0].url, `/api/media/${asset.id}`);
  assert.equal(snapshot.messages[1].documentSources[0].excerpt, "Retained citation excerpt");
  for (const marker of ["relativePath", asset.relativePath, "never-export-"]) assert.equal(JSON.stringify(snapshot).includes(marker), false);
  assert.deepEqual(await search(chat.id), []);
});

test("search maintenance handles stable IDs and deletes long histories without leaving indexed text", async () => {
  const chat = await create("Maintenance history");
  await db.message.createMany({ data: Array.from({ length: 1000 }, (_, i) => ({ id: `${user.id}-maintenance-${i}`, chatId: chat.id, role: "user", content: `Maintenance content ${i}` })) });
  for (const id of ['x', 'two', 'quoted"id', '😀😃']) await db.message.create({ data: { id, chatId: chat.id, role: "user", content: "Maintenance content" } });
  await db.$executeRawUnsafe("VACUUM");
  assert.deepEqual((await search("Maintenance content")).map(chat => chat.id), [chat.id]);
  await data(await routes.bulk.POST(request("/bulk-delete", "POST", { ids: [chat.id], confirm: true })));
  assert.deepEqual(await search("Maintenance content"), []);
  assert.equal((await db.$queryRaw`SELECT count(*) AS count FROM message_text_search WHERE text MATCH '"Maintenance content"'`)[0].count, 0n);
});

test("search, export and bulk-delete enforce local quotas, Origin and authentication boundaries", async () => {
  const chat = await create("Quota search");
  for (let i = 0; i < 30; i++) assert.equal((await routes.list.GET(request("?q=Quota"))).status, 200);
  const searchLimit = await routes.list.GET(request("?q=Quota"));
  assert.equal(searchLimit.status, 429);
  assert.ok(searchLimit.headers.get("retry-after"));
  for (let i = 0; i < 6; i++) assert.equal((await routes.export.GET(request(`/${chat.id}/export`), context(chat.id))).status, 200);
  assert.equal((await routes.export.GET(request(`/${chat.id}/export`), context(chat.id))).status, 429);
  for (let i = 0; i < 10; i++) assert.equal((await routes.bulk.POST(request("/bulk-delete", "POST", { ids: ["missing"], confirm: true }))).status, 404);
  assert.equal((await routes.bulk.POST(request("/bulk-delete", "POST", { ids: [chat.id], confirm: true }))).status, 429);
  assert.equal((await routes.bulk.POST(request("/bulk-delete", "POST", { ids: [chat.id], confirm: true }, cookie, { origin: "https://outside.invalid" }))).status, 403);
  assert.equal((await routes.bulk.POST(request("/bulk-delete", "POST", {}, ""))).status, 401);
  assert.equal((await routes.export.GET(request(`/${chat.id}/export`, "GET", undefined, ""), context(chat.id))).status, 401);
  assert.ok(await db.chat.findUnique({ where: { id: chat.id } }));
});
