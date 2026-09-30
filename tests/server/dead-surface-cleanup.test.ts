/// <reference path="../../src/types/desktop.d.ts" />
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import type { ToolExecutionOptions } from "ai";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";

const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const { createGrant, listActiveGrants, revokeGrant } = await import("@/lib/local-files/grants");
const { ApiError } = await import("@/lib/server/api-error");
const { createChatToolSet, getToolDescriptor } = await import("@/tools/catalog");
const knowledgeIdRoute = await import("@/app/api/knowledge/[id]/route");
const catalog = await import("@/lib/models/catalog");
const { listModelProviders } = await import("@/lib/models/providers");

// The tool wrapper is driven directly rather than through the model loop, and
// nothing here reads the per-call execution context.
const toolOptions = {} as ToolExecutionOptions;

const directories: string[] = [];
function temporaryDirectory() {
  const directory = realpathSync.native(mkdtempSync(path.join(tmpdir(), "ria-dead-surface-")));
  directories.push(directory);
  return directory;
}

let cookie: string;
const req = (route: string, method = "GET", body?: unknown) => new NextRequest(`http://localhost${route}`, {
  method,
  headers: { cookie, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const payload = async (response: Response, status = 200) => {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
};

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  globalThis.__privateAiRateLimitStore?.clear();
  cookie = localAccessCookie();
  await db.directoryGrant.deleteMany({});
  await db.memory.deleteMany({});
});
after(async () => {
  await db.$disconnect();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  cleanup();
});

// --- 1: the mode assertion nothing calls --------------------------------------

test("the catalog module carries no mode assertion for no caller", () => {
  // Every route reads the mode from its own query schema, so this export was
  // reachable only by name. It stays gone: a second way to read a mode is a
  // second thing that has to agree with the first.
  assert.equal("assertCatalogMode" in catalog, false);
});

// --- 1: the id trust check the provider contract still declares ---------------

test("every provider still answers whether a model id is one of its own", () => {
  const providers = listModelProviders();
  assert.ok(providers.length > 0);
  for (const provider of providers) {
    assert.equal(typeof provider.isTrustedModelId, "function", `${provider.id} declares the check`);
    // The two shapes providers disagree about: a provider-namespaced id and a
    // name carrying a path separator. Which one is accepted is the provider's
    // own rule, so only the answer is asserted, not a fixed expectation here.
    assert.equal(typeof provider.isTrustedModelId("author/name"), "boolean", `${provider.id} answers for a namespaced id`);
    assert.equal(provider.isTrustedModelId(""), false, `${provider.id} refuses an empty id`);
    assert.equal(provider.isTrustedModelId(42), false, `${provider.id} refuses a non-string id`);
  }
});

// --- 3: a withdrawn folder is a configuration problem, not an upstream one ----

test("a folder withdrawn while the tool is running is logged as a configuration error", async (t: TestContext) => {
  const root = temporaryDirectory();
  mkdirSync(path.join(root, "notes"), { recursive: true });
  writeFileSync(path.join(root, "notes", "a.md"), "# A");
  const grant = await createGrant({ path: root });

  const tools = await createChatToolSet({ toolIds: ["readLocalFile"] });
  // The folder is withdrawn while the tool is running: the availability check
  // that ran before the call still saw the grant, so this is the mid-execute
  // branch rather than the one that refuses before the tool starts.
  const descriptor = getToolDescriptor("readLocalFile");
  t.mock.method(descriptor, "execute", async () => {
    await revokeGrant(grant.id);
    throw new Error("the folder is gone");
  });

  const logged: { toolId: string; state: string; errorCode?: string }[] = [];
  t.mock.method(console, "info", (event: string, payload?: unknown) => {
    if (event !== "tool.execution") return;
    const row = payload as { toolId: string; state: string; errorCode?: string };
    logged.push({ toolId: row.toolId, state: row.state, errorCode: row.errorCode });
  });

  const refused = await tools.readLocalFile.execute({ grantId: grant.id, path: "notes/a.md" }, toolOptions);
  assert.equal(typeof refused.unavailable, "string", "the turn continues with the refusal as a result");

  const entry = logged.find(row => row.toolId === "readLocalFile");
  assert.ok(entry, "the execution was logged");
  assert.equal(entry.state, "output-available");
  // The folder was withdrawn by the user, which is fixed in settings — the same
  // code the pre-execution check reports for the same reason. Reading it as an
  // upstream failure tells the user to retry a refusal that will not change.
  assert.equal(entry.errorCode, "CONFIGURATION_ERROR");
});

test("a genuinely transient failure is still logged as an upstream failure", async (t: TestContext) => {
  const root = temporaryDirectory();
  writeFileSync(path.join(root, "a.md"), "# A");
  await createGrant({ path: root });

  const tools = await createChatToolSet({ toolIds: ["readLocalFile"] });
  // The folder stays granted, so this refusal is about the provider rather
  // than about anything the user has to set up.
  const descriptor = getToolDescriptor("readLocalFile");
  t.mock.method(descriptor, "execute", async () => {
    throw new ApiError({ code: "UPSTREAM_FAILED", message: "the lookup service is refusing" });
  });

  const logged: { toolId: string; errorCode?: string }[] = [];
  t.mock.method(console, "info", (event: string, payload?: unknown) => {
    if (event !== "tool.execution") return;
    const row = payload as { toolId: string; errorCode?: string };
    logged.push({ toolId: row.toolId, errorCode: row.errorCode });
  });

  const refused = await tools.readLocalFile.execute({ grantId: (await listActiveGrants())[0].id, path: "a.md" }, toolOptions);
  assert.equal(typeof refused.unavailable, "string");

  const entry = logged.find(row => row.toolId === "readLocalFile");
  assert.ok(entry, "the execution was logged");
  assert.equal(entry.errorCode, "UPSTREAM_FAILED");
});

// --- 4: the edit path reads the entry without its vector ---------------------

const VECTOR_DIMENSIONS = 1536;
const embedding = Array.from({ length: VECTOR_DIMENSIONS }, (_, index) => Math.sin(index) * 0.5 + 0.5);

test("editing and deleting an entry never select the stored vector", async () => {
  const entry = await db.memory.create({
    data: {
      key: "language",
      value: "the user writes 中文",
      score: 0.5,
      source: "assistant",
      confirmed: false,
      embedding,
      embeddingModelId: "text-embedding-3-small",
      embeddingModelProvider: "openrouter",
    },
  });

  // The Prisma delegate is a proxy whose model methods are plain writable
  // properties, so the lookup is wrapped by hand here and put back below.
  const delegate = db.memory as unknown as Record<string, unknown>;
  const original = delegate.findFirst as (args: unknown) => Promise<unknown>;
  const selections: unknown[] = [];
  delegate.findFirst = (args: unknown) => {
    selections.push(args);
    return original.call(delegate, args);
  };
  try {
    // Confirming only: the lookup has to produce the key and the value the
    // handler rewrites, so the narrowed projection still drives the write.
    const confirmed = await payload(await knowledgeIdRoute.PATCH(req(`/api/knowledge/${entry.id}`, "PATCH", { confirmed: true }), context(entry.id)));
    assert.equal(confirmed.data.confirmed, true);
    // Confirming alone leaves the stored wording — and its vector — untouched,
    // so the narrowed lookup changed nothing about what the row holds. The
    // vector is compared through SQLite, which stores it as JSON.
    const afterConfirm = await db.memory.findUniqueOrThrow({ where: { id: entry.id } });
    const vector = afterConfirm.embedding as unknown[];
    assert.equal(vector.length, VECTOR_DIMENSIONS);
    assert.equal(vector[0], embedding[0]);
    assert.equal(afterConfirm.value, "the user writes 中文");

    const edited = await payload(await knowledgeIdRoute.PATCH(req(`/api/knowledge/${entry.id}`, "PATCH", { value: "the user writes 中文和代码" }), context(entry.id)));
    assert.equal(edited.data.value, "the user writes 中文和代码");
    assert.deepEqual(Object.keys(edited.data).sort(), ["confirmed", "createdAt", "id", "key", "lastUsedAt", "score", "source", "updatedAt", "value"]);

    await payload(await knowledgeIdRoute.DELETE(req(`/api/knowledge/${entry.id}`, "DELETE"), context(entry.id)));
    assert.equal(await db.memory.count({ where: { id: entry.id } }), 0);
    const refused = await knowledgeIdRoute.PATCH(req(`/api/knowledge/${entry.id}`, "PATCH", { confirmed: true }), context(entry.id));
    assert.equal(refused.status, 404);

    // Both edits and the deletion went through the scoped lookup, and every one
    // of them named the columns it read instead of pulling the vector out of
    // the database to drop it on the floor.
    assert.equal(selections.length, 4, "each handler looked the entry up once");
    for (const selection of selections) {
      const select = (selection as { select?: Record<string, boolean> }).select;
      assert.ok(select, "the lookup names the columns it reads");
      assert.equal(select.embedding, undefined, "the vector is not read to be thrown away");
      assert.deepEqual(Object.keys(select).sort(), ["id", "key", "value"]);
    }
  } finally {
    delegate.findFirst = original;
  }
});
