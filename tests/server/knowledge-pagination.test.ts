import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const knowledge = await import("@/app/api/knowledge/route");
const entry = await import("@/app/api/knowledge/[id]/route");
let cookie: string;
const date = new Date("2026-08-01T00:00:00Z");
const request = (query = "", auth = cookie) => new NextRequest(`http://localhost/api/knowledge${query ? `?${query}` : ""}`, { headers: auth ? { cookie: auth } : {} });
async function list(query = "") {
  const response = await knowledge.GET(request(query));
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {});
  globalThis.__privateAiRateLimitStore?.clear();
  cookie = localAccessCookie();
  await db.memory.deleteMany({});
});
after(async () => { await db.$disconnect(); cleanup(); });

test("knowledge pages reach every entry beyond one hundred with equal timestamps", async () => {
  const ids = Array.from({ length: 127 }, (_, i) => `memory-${String(i).padStart(3, "0")}`);
  await db.memory.createMany({ data: ids.map(id => ({ id, key: id, value: "正文", updatedAt: date, embedding: [1, 2, 3] })) });
  let page = await list("limit=25");
  assert.equal(page.data.length, 25);
  assert.equal("embedding" in page.data[0], false);
  const collected = page.data.map(row => row.id);
  while (page.pageInfo.hasMore) {
    page = await list(`limit=25&cursor=${page.pageInfo.nextCursor}`);
    assert.ok(page.data.length <= 25);
    collected.push(...page.data.map(row => row.id));
  }
  assert.deepEqual(collected, [...ids].reverse());
  assert.equal(page.pageInfo.nextCursor, null);
});

test("knowledge cursor boundaries survive anchor deletion and newer inserts", async () => {
  await db.memory.createMany({ data: ["a", "b", "c", "d"].map(id => ({ id, key: id, value: "正文", updatedAt: date })) });
  const first = await list("limit=2");
  assert.deepEqual(first.data.map(row => row.id), ["d", "c"]);
  await db.memory.delete({ where: { id: "c" } });
  await db.memory.create({ data: { key: "最新", value: "新内容" } });
  const next = await list(`limit=2&cursor=${first.pageInfo.nextCursor}`);
  assert.deepEqual(next.data.map(row => row.id), ["b", "a"]);
  assert.equal(next.pageInfo.hasMore, false);
});

test("knowledge search combines title or content matching with confirmation filters", async () => {
  await db.memory.createMany({ data: [
    { key: "云南旅行", value: "徒步", confirmed: true },
    { key: "旧偏好", value: "去云南", confirmed: false, source: "assistant" },
    { key: "Other", value: "HELLO 100%_done", confirmed: true },
    { key: "没有匹配", value: "100percentXdone", confirmed: true },
  ] });
  assert.equal((await list("q=云南")).data.length, 2);
  assert.deepEqual((await list("q=云南&view=confirmed")).data.map(row => row.key), ["云南旅行"]);
  assert.deepEqual((await list("q=云南&view=candidates")).data.map(row => row.key), ["旧偏好"]);
  assert.deepEqual((await list(`q=${encodeURIComponent("%_done")}`)).data.map(row => row.key), ["Other"]);
  assert.deepEqual((await list("q=hello")).data.map(row => row.key), ["Other"]);
  assert.deepEqual((await list("q=找不到")).pageInfo, { nextCursor: null, hasMore: false });
});

test("knowledge cursors are bound to the normalized search and view", async () => {
  await db.memory.createMany({ data: ["one", "two"].map(key => ({ key, value: "match", updatedAt: date })) });
  const first = await list("limit=1&q=match&view=confirmed");
  const cursor = first.pageInfo.nextCursor;
  for (const query of [`q=match&view=all&cursor=${cursor}`, `q=other&view=confirmed&cursor=${cursor}`]) {
    assert.equal((await knowledge.GET(request(query))).status, 400);
  }
  const next = await list(`q=%20match%20&view=confirmed&cursor=${cursor}`);
  assert.equal(next.data.length, 1);
  assert.notEqual(next.data[0].id, first.data[0].id);
});

test("knowledge queries reject invalid and duplicate parameters after authenticating", async () => {
  for (const query of ["limit=0", "limit=101", "limit=1.5", "limit=", "limit=2&limit=3", "q=a&q=b", "view=all&view=confirmed", "view=bad", "cursor=", "cursor=garbage", "cursor=a&cursor=b", "unexpected=1", `q=${"x".repeat(121)}`, "q=a%00b"]) {
    const response = await knowledge.GET(request(query));
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).error.code, "VALIDATION_ERROR");
  }
  assert.equal((await knowledge.GET(request("limit=bad", ""))).status, 401);
});

test("acceptance removes a matching candidate and confirmed edits change search membership", async () => {
  const candidate = await db.memory.create({ data: { key: "偏好", value: "旧内容", confirmed: false, source: "assistant" } });
  assert.equal((await list("view=candidates&q=旧内容")).data.length, 1);
  const patch = new NextRequest(`http://localhost/api/knowledge/${candidate.id}`, {
    method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ value: "新内容" }),
  });
  assert.equal((await entry.PATCH(patch, { params: Promise.resolve({ id: candidate.id }) })).status, 200);
  assert.equal((await list("view=candidates")).data.length, 0);
  assert.equal((await list("q=旧内容")).data.length, 0);
  assert.equal((await list("q=新内容&view=confirmed")).data[0].id, candidate.id);
});
