/// <reference path="../../src/types/desktop.d.ts" />
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { after, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import type { ToolExecutionOptions } from "ai";
import { createTestDatabase } from "../helpers/database";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { t } = await import("@/lib/locale");
const { startRun } = await import("@/lib/agent/runs");
const { createChatToolSet } = await import("@/tools/catalog");
const { createGrant, revokeGrant } = await import("@/lib/local-files/grants");
const { getCatalog } = await import("@/lib/models/catalog");

// The wrapper is driven directly, so nothing reads the per-call context.
const toolOptions = {} as ToolExecutionOptions;

const temporaryDirectories: string[] = [];
function temporaryDirectory(prefix: string) {
  const path = mkdtempSync(`${tmpdir()}/${prefix}`);
  temporaryDirectories.push(path);
  return path;
}

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  // The search tool is only mounted when it is configured, and both budget
  // refusals below are answered before any request is made.
  process.env.TAVILY_API_KEY = "offline-fixture-placeholder";
  // The wrapper checks the tool quota before anything else.
  globalThis.__privateAiRateLimitStore.clear();
  await db.directoryGrant.deleteMany({});
  await db.agentStep.deleteMany({});
  await db.agentRun.deleteMany({});
  await db.modelCatalogSnapshot.deleteMany({});
});

after(async () => {
  await db.$disconnect();
  for (const path of temporaryDirectories) rmSync(path, { recursive: true, force: true });
  cleanup();
});

test("a local-file tool whose folder is withdrawn mid-turn says the folder is gone", async () => {
  const grant = await createGrant({ path: temporaryDirectory("ria-records-") });
  // The tool set is built while the folder is granted, so the tool is mounted…
  const tools = await createChatToolSet({ toolIds: ["listLocalFiles", "readLocalFile"] });
  assert.ok(tools.listLocalFiles, "the local-file tool is offered while a folder is granted");
  assert.ok(tools.readLocalFile, "the local-file tool is offered while a folder is granted");
  // …and the folder is withdrawn before it runs, as it would be from another window.
  await revokeGrant(grant.id);

  const listed = await tools.listLocalFiles.execute({ grantId: grant.id }, toolOptions);
  const read = await tools.readLocalFile.execute({ grantId: grant.id, path: "notes.md" }, toolOptions);

  // The reason is the tool's own, not the web-search one. Before the fix both
  // carried "notConfigured" and the model was told to check the settings page
  // for a search key it never needed.
  assert.equal(listed.truncated, t("tools.localFiles.noGrant"));
  assert.deepEqual(listed.entries, []);
  assert.equal(read.unavailable, t("tools.localFiles.noGrant"));
  assert.equal(read.text, "");
});

test("a step refused by the run's step budget says the budget, not that the run was stopped", async () => {
  // No room for a step at all, which is what a run that has spent its budget
  // looks like to the next tool call.
  const run = await startRun({ chatId: null, goal: "步骤预算已用尽", budget: { maxSteps: 0 } });
  const tools = await createChatToolSet({ toolIds: ["webSearch"], runId: run.id });
  const refused = await tools.webSearch.execute({ query: "still budget?" }, toolOptions);

  // "runStopped" is what a run the user cancelled reports; a run that ran out
  // of steps is a different fact and the model is told which one happened.
  assert.equal(refused.skipped, "budget");
  assert.deepEqual(refused.results, []);
});

test("a step refused because the run is finished still reports the run as stopped", async () => {
  const run = await startRun({ chatId: null, goal: "运行已被取消", budget: { deadlineMs: -1 } });
  const tools = await createChatToolSet({ toolIds: ["webSearch"], runId: run.id });
  const refused = await tools.webSearch.execute({ query: "too late?" }, toolOptions);

  // The deadline is not a budget the model could work around, and collapsing it
  // into "budget" would send it looking for room that does not exist.
  assert.equal(refused.skipped, "runStopped");
});

test("a provider is not asked for a catalog in a mode it does not offer", async (t: TestContext) => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", (async (input: unknown) => {
    requests.push(String(input));
    return new Response(JSON.stringify({
      data: [{ id: "deepseek-v4-pro", name: "Fixture", output_modalities: ["text"], input_modalities: ["text"] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch);

  // The endpoint is a single list of chat models, so a request for the image
  // catalog does not come back empty — it comes back with the chat models,
  // which would then be stored under "image" and offered as image models.
  const state = await getCatalog("deepseek", "image");
  assert.deepEqual(requests, [], "a mode the provider does not offer is never fetched");
  assert.deepEqual(state.models, []);
  assert.equal(state.source, "empty");
  assert.equal(state.fetchedAt, null);
  assert.equal(
    await db.modelCatalogSnapshot.count({ where: { providerId: "deepseek", mode: "image" } }),
    0,
    "nothing is written to a snapshot for a mode the provider does not offer",
  );

  // The modes it does offer still work, so the refusal is specific rather than
  // the catalog being broken.
  const chat = await getCatalog("deepseek", "chat");
  assert.equal(requests.length, 1);
  assert.equal(chat.models.length, 1);
  assert.equal(chat.models[0].modelId, "deepseek-v4-pro");
  assert.equal(chat.source, "live");
});
