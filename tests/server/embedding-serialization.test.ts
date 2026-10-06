import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const knowledgeRoute = await import("@/app/api/knowledge/route");
const knowledgeIdRoute = await import("@/app/api/knowledge/[id]/route");
const memoryRoute = await import("@/app/api/memory/route");
const retrievalRoute = await import("@/app/api/retrieval/route");

/**
 * A stored vector of the size a real embedding model produces. 1536 floats
 * serialise to roughly 30 kB of JSON, so a list of these is the difference
 * between a page of text and megabytes of numbers no client reads.
 */
const VECTOR_DIMENSIONS = 1536;
const embedding = Array.from({ length: VECTOR_DIMENSIONS }, (_, index) => Math.sin(index) * 0.5 + 0.5);

/** Exactly what the knowledge page renders, and nothing else. */
const ENTRY_FIELDS = ["confirmed", "createdAt", "id", "key", "lastUsedAt", "score", "source", "updatedAt", "value"];

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
const fieldsOf = (row: Record<string, unknown>) => Object.keys(row).sort();

async function seedEmbeddedMemory(key: string) {
  return db.memory.create({
    data: {
      key,
      value: `value for ${key}`,
      score: 0.5,
      embedding,
      embeddingModelId: "text-embedding-3-small",
      embeddingModelProvider: "openrouter",
    },
  });
}

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  globalThis.__privateAiRateLimitStore.clear();
  cookie = localAccessCookie();
  await db.memory.deleteMany({});
});
after(async () => { await db.$disconnect(); cleanup(); });

test("the knowledge list returns the entry, not the vector stored with it", async () => {
  await seedEmbeddedMemory("one");
  await seedEmbeddedMemory("two");
  await seedEmbeddedMemory("three");

  const response = await knowledgeRoute.GET(req("/api/knowledge?limit=100"));
  const text = await response.clone().text();
  const body = await payload(response);

  assert.equal(body.data.length, 3);
  for (const row of body.data) assert.deepEqual(fieldsOf(row), ENTRY_FIELDS, "the list returns exactly what the page renders");
  // Three entries of a couple of hundred characters each. With the vectors
  // attached this is well over 90 kB of JSON.
  assert.ok(text.length < 4096, `the list response should not carry the vectors, was ${text.length} bytes`);

  // Narrowing the projection is not dropping data: retrieval still needs the
  // vector, so the row keeps it.
  const stored = await db.memory.findUnique({ where: { key: "one" } });
  assert.ok(Array.isArray(stored?.embedding) && stored.embedding.length === VECTOR_DIMENSIONS);
});

test("accepting a candidate does not hand its vector back", async () => {
  const entry = await db.memory.create({
    data: { key: "candidate", value: "inferred", source: "assistant", confirmed: false, embedding, embeddingModelId: "text-embedding-3-small", embeddingModelProvider: "openrouter" },
  });

  // Confirming only: the value is untouched, so the stored vector survives the
  // write and would otherwise be serialised straight back to the browser.
  const body = await payload(await knowledgeIdRoute.PATCH(req(`/api/knowledge/${entry.id}`, "PATCH", { confirmed: true }), context(entry.id)));
  assert.deepEqual(fieldsOf(body.data), ENTRY_FIELDS);
  assert.equal(body.data.confirmed, true);

  const stored = await db.memory.findUnique({ where: { id: entry.id } });
  assert.ok(Array.isArray(stored?.embedding), "the write itself still keeps the vector");
});

test("editing a candidate returns the edited entry and not the rewritten vector", async () => {
  const entry = await db.memory.create({
    data: { key: "candidate", value: "inferred", source: "assistant", confirmed: false, embedding, embeddingModelId: "text-embedding-3-small", embeddingModelProvider: "openrouter" },
  });

  const response = await knowledgeIdRoute.PATCH(req(`/api/knowledge/${entry.id}`, "PATCH", { value: "corrected" }), context(entry.id));
  const text = await response.clone().text();
  const body = await payload(response);

  assert.equal(body.data.value, "corrected");
  assert.equal(body.data.confirmed, true);
  assert.deepEqual(fieldsOf(body.data), ENTRY_FIELDS);
  assert.ok(text.length < 4096, `the edit response should not carry the vector, was ${text.length} bytes`);
});

test("creating an entry echoes the stored entry, not the vector columns", async () => {
  const knowledge = await payload(await knowledgeRoute.POST(req("/api/knowledge", "POST", { key: "created", value: "content" })), 201);
  assert.deepEqual(fieldsOf(knowledge.data), ENTRY_FIELDS);

  const memory = await payload(await memoryRoute.POST(req("/api/memory", "POST", { key: "created", value: "content" })), 201);
  assert.deepEqual(fieldsOf(memory.data), ENTRY_FIELDS);
});

test("the read paths that already narrowed their projection stay narrow", async () => {
  await seedEmbeddedMemory("language");

  const listed = await payload(await memoryRoute.GET(req("/api/memory?query=language")));
  assert.equal(listed.data.length, 1);
  assert.deepEqual(fieldsOf(listed.data[0]), ["id", "key", "score", "updatedAt", "value"]);

  const retrieved = await payload(await retrievalRoute.POST(req("/api/retrieval", "POST", { query: "language" })));
  assert.equal(retrieved.data.length, 1);
  assert.deepEqual(fieldsOf(retrieved.data[0]), ["id", "key", "score", "updatedAt", "value"]);
});