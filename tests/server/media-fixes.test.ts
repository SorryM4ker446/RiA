import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import { createTestDatabase } from "../helpers/database";
import { testPng } from "../helpers/model-provider";
import { seedTestModelPreferences } from "../helpers/model-library";

const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");

const storage = await import("@/lib/media/storage");
const { listChatMessagePage } = await import("@/lib/chat/store");
const { encodePersistedUserMessage } = await import("@/lib/ai/ui-message");
const { MEDIA_LIMITS } = await import("@/lib/media/limits");

/** Every stored byte lives somewhere below the media root, and a test database
 *  keeps its media directory for the whole process, so writes are compared to a
 *  baseline taken before the test rather than to an absolute count. */
function storedFiles(directory = process.env.MEDIA_DIRECTORY!): string[] {
  mkdirSync(directory, { recursive: true });
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? storedFiles(join(directory, entry.name)) : [join(directory, entry.name)]).sort();
}
function dataUrl(bytes: Buffer) { return `data:image/png;base64,${bytes.toString("base64")}`; }
function legacyUserMessage(text: string, files: Array<{ url: string; mediaType: string }>) {
  return encodePersistedUserMessage({ type: "user-message", text, files });
}
async function newChat() { return db.chat.create({ data: { title: "Legacy media" } }); }
async function readConversations(chatId: string, times: number) {
  for (let read = 0; read < times; read += 1) {
    const page = await listChatMessagePage(chatId, { limit: 50 });
    assert.ok(page, "the conversation should still be readable");
  }
}

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
  await db.message.deleteMany({});
  await db.chat.deleteMany({});
  await db.mediaAsset.deleteMany({});
  await db.modelRequest.deleteMany({});
  await db.workspacePreference.deleteMany({});
  await seedTestModelPreferences(db);
});
after(async () => { await db.$disconnect(); cleanup(); });

test("a media file that cannot be removed leaves the asset live and retryable", async () => {
  const asset = await storage.createMediaAsset({ bytes: testPng, mediaType: "image/png", kind: "attachment" });
  const file = join(process.env.MEDIA_DIRECTORY!, asset.relativePath);
  // The media root stops being a usable directory after the asset is claimed,
  // the same class of failure as a locked or unreadable directory.
  const blocked = `${process.env.MEDIA_DIRECTORY!}.blocked`;
  const original = process.env.MEDIA_DIRECTORY;
  writeFileSync(blocked, "not a directory");
  process.env.MEDIA_DIRECTORY = blocked;
  try {
    await assert.rejects(storage.deleteMediaAsset(asset.id), (error: { code?: string }) => error.code === "NOT_FOUND");
  } finally {
    process.env.MEDIA_DIRECTORY = original;
  }
  // The claim is released, so the asset stays in the library and a retry frees it.
  assert.equal((await db.mediaAsset.findUnique({ where: { id: asset.id } }))?.deletedAt, null);
  assert.ok(existsSync(file));
  assert.equal(await storage.deleteMediaAsset(asset.id), testPng.length);
  assert.equal(existsSync(file), false);
  assert.equal(await db.mediaAsset.count({ where: {} }), 0);
});

test("a rejected legacy attachment stores nothing across repeated reads", async () => {
  const chat = await newChat();
  const baseline = storedFiles();
  const content = legacyUserMessage("Old attachment", [
    { url: dataUrl(testPng), mediaType: "image/png" },
    { url: "/api/media/not-an-asset-id", mediaType: "image/png" },
  ]);
  await db.message.create({ data: { chatId: chat.id, role: "user", content } });
  await readConversations(chat.id, 3);
  assert.equal(await db.mediaAsset.count({ where: {} }), 0);
  assert.deepEqual(storedFiles(), baseline);
  assert.equal((await db.message.findFirst({ where: { chatId: chat.id } }))?.content, content);
});

test("an oversized legacy attachment set is rejected before any bytes are stored", async () => {
  const chat = await newChat();
  const baseline = storedFiles();
  // Three individually valid attachments that only fail the combined size limit.
  const bytes = Buffer.concat([testPng.subarray(0, 8), Buffer.alloc(7 * 1024 * 1024 - 8)]);
  assert.ok(bytes.length < MEDIA_LIMITS.attachmentBytes);
  assert.ok(bytes.length * 3 > MEDIA_LIMITS.totalAttachmentBytes);
  const content = legacyUserMessage("Old attachments", Array.from({ length: 3 }, () => ({ url: dataUrl(bytes), mediaType: "image/png" })));
  await db.message.create({ data: { chatId: chat.id, role: "user", content } });
  await readConversations(chat.id, 2);
  assert.equal(await db.mediaAsset.count({ where: {} }), 0);
  assert.deepEqual(storedFiles(), baseline);
  assert.equal((await db.message.findFirst({ where: { chatId: chat.id } }))?.content, content);
});

test("a legacy attachment is migrated once however often the conversation is read", async () => {
  const chat = await newChat();
  const baseline = storedFiles();
  const content = legacyUserMessage("Old attachment", [{ url: dataUrl(testPng), mediaType: "image/png" }]);
  const message = await db.message.create({ data: { chatId: chat.id, role: "user", content } });
  await readConversations(chat.id, 3);
  const [asset] = await db.mediaAsset.findMany({ where: {} });
  assert.equal(await db.mediaAsset.count({ where: {} }), 1);
  assert.equal(await db.messageMedia.count({ where: { messageId: message.id } }), 1);
  assert.deepEqual(storedFiles().filter((path) => !baseline.includes(path)), [join(process.env.MEDIA_DIRECTORY!, asset.relativePath)]);
  assert.equal((await db.message.findFirst({ where: { chatId: chat.id } }))?.content.includes("base64"), false);
});
