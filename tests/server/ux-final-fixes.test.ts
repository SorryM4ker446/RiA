import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import type { UploadableFilePart } from "@/features/chat/page-utils";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { createUploadLock, remainingAttachments, runAttachmentUpload } = await import("@/features/chat/use-media-generation");
const knowledgeRoute = await import("@/app/api/knowledge/route");
const knowledgeIdRoute = await import("@/app/api/knowledge/[id]/route");
const { modelRefKey, upgradeModelPreferences } = await import("@/lib/models/preferences-schema");

// --- the composer's attachments -------------------------------------------------

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

const png = (name: string) => new File(["image-bytes"], name, { type: "image/png" });
const part = (url: string, filename: string): UploadableFilePart => ({ type: "file", url, mediaType: "image/png", filename });

/**
 * The composer wired the way the hook wires it: a view version that every
 * conversation change advances, and the identity of the conversation on screen.
 */
function uploadHarness() {
  const state = { committed: [] as string[], error: null as string | null, locked: false };
  const view = { version: 0, chatId: "A" as string | null };
  const lock = createUploadLock();
  return {
    state,
    view,
    lock,
    options: {
      files: [png("one.png")],
      modelMode: "image" as const,
      existingNames: [] as string[],
      upload: async (): Promise<UploadableFilePart[]> => [part("/api/media/asset-1", "one.png")],
      setPageError: (error: string | null) => { state.error = error; },
      getVersion: () => view.version,
      getConversationId: () => view.chatId,
      commit: (uploaded: UploadableFilePart[]) => { state.committed.push(...uploaded.map((entry) => entry.url)); },
      setUploading: (uploading: boolean) => { state.locked = uploading; },
      lock
    }
  };
}

test("an upload that resolves after the user came back to the same conversation is still theirs", async () => {
  const run = uploadHarness();
  const upload = deferred<UploadableFilePart[]>();

  const pending = runAttachmentUpload({ ...run.options, upload: () => upload.promise });
  // The user looks at another conversation and comes back while the upload is
  // still running. Each switch advances the counter, so a counter cannot tell
  // this apart from having stayed in a conversation that is no longer on screen.
  run.view.chatId = "B";
  run.view.version += 1;
  run.view.chatId = "A";
  run.view.version += 1;

  upload.resolve([part("/api/media/asset-1", "one.png")]);
  await pending;

  assert.deepEqual(run.state.committed, ["/api/media/asset-1"],
    "A is on screen again and the reference was picked in A, so it belongs in the composer");
  assert.equal(run.state.locked, false);
});

test("an upload is never committed into a conversation it was not started in", async () => {
  const run = uploadHarness();
  const upload = deferred<UploadableFilePart[]>();

  const pending = runAttachmentUpload({ ...run.options, upload: () => upload.promise });
  run.view.chatId = "B";
  run.view.version += 1;
  upload.resolve([part("/api/media/asset-1", "one.png")]);
  await pending;

  assert.deepEqual(run.state.committed, [], "B is on screen; A's reference must not land in it");
  assert.equal(run.state.locked, false, "the composer is released either way");
});

test("a failed upload is reported only while its own conversation is on screen", async () => {
  const run = uploadHarness();

  const failing = runAttachmentUpload({
    ...run.options,
    upload: async () => { await Promise.resolve(); throw new Error("upload rejected"); }
  });
  run.view.chatId = "B";
  run.view.version += 1;
  await failing;

  assert.equal(run.state.error, null, "B's composer must not report a failure from A's upload");
  assert.equal(run.state.locked, false, "the composer is released either way");
});

test("an upload that fails in its own conversation is reported", async () => {
  const run = uploadHarness();

  await runAttachmentUpload({ ...run.options, upload: async () => { throw new Error("upload rejected"); } });

  assert.equal(run.state.error, "upload rejected");
});

test("finishing a media turn empties the composer of what it sent and nothing else", () => {
  const sent = [part("/api/media/asset-1", "one.png")];
  // The composer stayed usable for the whole turn, so this one was attached
  // after the prompt was sent and has not been used for anything yet.
  const during = [part("/api/media/asset-1", "one.png"), part("/api/media/asset-2", "two.png")];

  assert.deepEqual(remainingAttachments(during, sent).map((entry) => entry.url), ["/api/media/asset-2"],
    "an attachment added while the generation was running is the user's and stays");
  assert.deepEqual(remainingAttachments(sent, sent), [], "the composer is still emptied of a turn's own references");
  assert.deepEqual(remainingAttachments([part("/api/media/asset-3", "again.png")], sent).map((entry) => entry.url), ["/api/media/asset-3"],
    "re-picking the same picture is a new upload and is kept");
});

// --- legacy rate keys ------------------------------------------------------------

const legacyRate = { inputPerMillion: 3, outputPerMillion: 15, perRequest: null };
const libraryEntry = (modelId: string) => ({
  providerId: "openrouter", modelId, name: modelId, description: "", modes: ["chat"],
  supportsImageInput: false, endpointImageInput: null, supportsTools: true, contextLength: null, pricing: {},
  addedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString()
});

test("a legacy rate key that merely contains a colon is still a bare OpenRouter id", () => {
  const bare = "nvidia/nemotron-3-super-120b-a12b:free";
  const upgraded = upgradeModelPreferences({
    version: 2,
    defaultMode: "chat",
    chat: { modelId: bare, fallbackId: null },
    image: { modelId: null, fallbackId: null },
    video: { modelId: null, fallbackId: null },
    embeddingModelId: null,
    library: [libraryEntry(bare)],
    rates: { [bare]: legacyRate },
    backupRetentionDays: 30,
    backupMaxCount: 10
  });

  // The upgrade has to produce the key the rest of the code looks a rate up by,
  // or the rate is stored and never found.
  assert.deepEqual(Object.keys(upgraded.rates), [`openrouter:${bare}`]);
  assert.deepEqual(upgraded.rates[modelRefKey({ providerId: "openrouter", modelId: bare })], legacyRate,
    "the stored rate must be found by the reference it belongs to");
  assert.equal(upgraded.chat.model?.modelId, bare);
});

test("a rate key that already names a provider is left exactly as it is", () => {
  const keys = {
    "openrouter:anthropic/claude-opus-4.6": legacyRate,
    "deepseek:deepseek-chat": { inputPerMillion: 1, outputPerMillion: 2, perRequest: null },
    "vendor/shared-model": legacyRate,
    "vendor/shared-model:online": { inputPerMillion: 1, outputPerMillion: 4, perRequest: null }
  };
  const upgraded = upgradeModelPreferences({
    version: 1,
    defaultMode: "chat",
    chat: { modelId: "anthropic/claude-opus-4.6", fallbackId: null },
    image: { modelId: "vendor/old-image", fallbackId: null },
    video: { modelId: "vendor/old-video", fallbackId: null },
    rates: keys,
    backupRetentionDays: 30,
    backupMaxCount: 10
  });

  assert.deepEqual(Object.keys(upgraded.rates), [
    "openrouter:anthropic/claude-opus-4.6",
    "deepseek:deepseek-chat",
    "openrouter:vendor/shared-model",
    "openrouter:vendor/shared-model:online"
  ]);
  assert.deepEqual(upgraded.rates["openrouter:anthropic/claude-opus-4.6"], legacyRate);
  assert.deepEqual(upgraded.rates["deepseek:deepseek-chat"], keys["deepseek:deepseek-chat"]);
});

// --- the knowledge list ----------------------------------------------------------

let cookie: string;
const req = (path: string, method = "GET", body?: unknown) => new NextRequest(`http://localhost${path}`, {
  method,
  headers: { cookie, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const payload = async (response: Response, status = 200) => {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
};
const fieldsOf = (row: Record<string, unknown>) => Object.keys(row).sort();

/** The fields the knowledge page's `KnowledgeEntry` type declares, read from it. */
async function clientEntryFields() {
  const page = await readFile("src/app/knowledge/page.tsx", "utf8");
  const block = page.slice(page.indexOf("type KnowledgeEntry = {"));
  assert.ok(block.length > 0, "the knowledge page declares the shape it renders");
  const body = block.slice(0, block.indexOf("};"));
  return [...body.matchAll(/^\s*(\w+):/gm)].map((match) => match[1]).sort();
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

test("what the list returns is exactly what the page's entry type declares", async () => {
  await db.memory.create({ data: { key: "one", value: "value one", score: 0.5 } });

  const listed = await payload(await knowledgeRoute.GET(req("/api/knowledge?limit=100")));
  assert.deepEqual(fieldsOf(listed.data[0]), await clientEntryFields(),
    "a field the page reads must survive the projection, and one it does not must not bloat the response");
});

test("the page can create, accept, edit and delete an entry without losing what it renders", async () => {
  const entryFields = await clientEntryFields();

  // Create, exactly as the page's form does, then reload the list.
  const created = await payload(await knowledgeRoute.POST(req("/api/knowledge", "POST", { key: "输出偏好", value: "先给结论" })), 201);
  assert.deepEqual(fieldsOf(created.data), entryFields);
  const listed = await payload(await knowledgeRoute.GET(req("/api/knowledge?limit=100")));
  assert.equal(listed.data.length, 1);
  assert.equal(listed.data[0].value, "先给结论");

  // Accept: the page rebuilds the row from the response, so the response has to
  // carry the same fields the row it replaces had.
  const candidate = await db.memory.create({ data: { key: "推断", value: "回答请使用中文", source: "assistant", confirmed: false } });
  const accepted = await payload(await knowledgeIdRoute.PATCH(req(`/api/knowledge/${candidate.id}`, "PATCH", { confirmed: true }), context(candidate.id)));
  assert.deepEqual(fieldsOf(accepted.data), entryFields);
  assert.equal(accepted.data.confirmed, true);
  assert.equal(accepted.data.source, "assistant");

  // Edit.
  const edited = await payload(await knowledgeIdRoute.PATCH(req(`/api/knowledge/${created.data.id}`, "PATCH", { value: "先给结论，再给理由" }), context(created.data.id)));
  assert.deepEqual(fieldsOf(edited.data), entryFields);
  assert.equal(edited.data.value, "先给结论，再给理由");
  assert.equal(edited.data.updatedAt !== created.data.updatedAt, true, "the page shows when the entry changed");

  // Delete.
  await payload(await knowledgeIdRoute.DELETE(req(`/api/knowledge/${created.data.id}`, "DELETE"), context(created.data.id)), 200);
  const remaining = await payload(await knowledgeRoute.GET(req("/api/knowledge?limit=100")));
  assert.deepEqual(remaining.data.map((row: { id: string }) => row.id), [candidate.id]);
});
