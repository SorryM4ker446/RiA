import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { after, beforeEach, test, type TestContext } from "node:test";
import { createTestDatabase } from "../helpers/database";
import { seedTestModelPreferences } from "../helpers/model-library";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { createAccountBackup, inspectAccountBackup } = await import("@/lib/backups/archive");
const { backupFile } = await import("@/lib/backups/files");
const { restoreAccountBackup } = await import("@/lib/backups/restore");
const { exclusiveDataOperation } = await import("@/lib/server/data-operations");
const { conversationCollections } = await import("@/lib/conversations/document-scope");

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {}); t.mock.method(console, "warn", () => {});
  await db.chat.deleteMany(); await db.workspacePreference.deleteMany();
  await seedTestModelPreferences(db);
});
after(async () => { await db.$disconnect(); cleanup(); });

/** Rewrites an archive's manifest, as an archive written by an earlier version would hold it. */
async function asOlderArchive(id: string, change: (manifest: Record<string, unknown>) => void) {
  const path = await backupFile(id);
  const bytes = await readFile(path);
  const length = bytes.readUInt32BE(8);
  const manifest = JSON.parse(bytes.subarray(44, 44 + length).toString("utf8"));
  change(manifest);
  const json = Buffer.from(JSON.stringify(manifest));
  const header = Buffer.alloc(44); bytes.copy(header, 0, 0, 8); header.writeUInt32BE(json.length, 8); createHash("sha256").update(json).digest().copy(header, 12);
  await writeFile(path, Buffer.concat([header, json, bytes.subarray(44 + length)]));
}

test("a new archive holds nothing of knowledge topics", async () => {
  await db.chat.create({ data: { title: "Plain" } });
  const backup = await exclusiveDataOperation(() => createAccountBackup(false));
  const bytes = await readFile(await backupFile(backup.id));
  const raw = JSON.parse(bytes.subarray(44, 44 + bytes.readUInt32BE(8)).toString("utf8"));
  assert.equal("topics" in raw || "artifacts" in raw, false);
  assert.equal(raw.chats.some((chat: Record<string, unknown>) => "topicId" in chat || "documentScope" in chat), false);
});

test("an archive from while topics existed restores its conversations as ordinary ones and its finished results as conversations", async () => {
  const kept = await db.chat.create({ data: { title: "Plain" } });
  const backup = await exclusiveDataOperation(() => createAccountBackup(false));
  const at = new Date("2026-10-20T08:00:00.000Z").toISOString(), later = new Date("2026-10-20T08:05:00.000Z").toISOString();
  const topicConfig = { name: "差旅", description: "", collections: ["财务"], assistantTemplateId: null };
  const result = (id: string, status: string, content: string | null) => ({
    id, topicId: "topic-1", requestHash: (id === "ready-result" ? "a" : "b").repeat(64), title: "核销总结", kind: "summary", topicRevision: 1, status, errorCode: content ? null : "UPSTREAM_FAILED", content,
    metadata: { brief: "费用核销时限", topic: topicConfig, assistant: null, model: null, responseModelId: null, sources: [], diagnostics: null, unknownCitations: [] },
    createdAt: at, updatedAt: later,
  });
  await asOlderArchive(backup.id, manifest => {
    const [plain] = manifest.chats as Array<Record<string, unknown>>;
    manifest.topics = [{ id: "topic-1", config: topicConfig, revision: 1, createdAt: at, updatedAt: at }];
    manifest.artifacts = [result("ready-result", "ready", "十个工作日内核销。"), result("failed-result", "failed", null)];
    manifest.chats = [
      { ...plain, id: "topic-chat", title: "专题对话", topicId: "topic-1", documentScope: "财务" },
      { ...plain, id: "other-chat", title: "旧对话", topicId: null, documentScope: "医疗" },
    ];
  });
  assert.equal((await inspectAccountBackup(backup.id)).counts.results, 1, "the preview counts only results that have text");
  await db.chat.delete({ where: { id: kept.id } });
  await exclusiveDataOperation(() => restoreAccountBackup(backup.id));

  // The conversations come back as ordinary ones, searching the whole library.
  for (const title of ["专题对话", "旧对话"]) assert.deepEqual(conversationCollections(await db.chat.findFirstOrThrow({ where: { title } })), []);
  const converted = await db.chat.findFirstOrThrow({ where: { title: "差旅 · 核销总结" }, include: { messages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } } });
  assert.deepEqual(conversationCollections(converted), []);
  assert.deepEqual(converted.messages.map(message => [message.role, message.content]), [["user", "费用核销时限"], ["assistant", "十个工作日内核销。"]]);
  assert.equal(await db.chat.count(), 3, "a result without text does not become a conversation");
});

test("an archive whose topic data does not hang together is refused", async () => {
  await db.chat.create({ data: { title: "Plain" } });
  const backup = await exclusiveDataOperation(() => createAccountBackup(false));
  await asOlderArchive(backup.id, manifest => {
    const [plain] = manifest.chats as Array<Record<string, unknown>>;
    manifest.chats = [{ ...plain, topicId: "missing-topic" }];
  });
  await assert.rejects(inspectAccountBackup(backup.id));
});
