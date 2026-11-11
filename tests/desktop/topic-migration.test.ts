import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const { runDesktopMigrations } = require("../../electron-dist/migrations.js");
// The last migration with knowledge topics; the one after it removes them.
const LAST_WITH_TOPICS = "20261115100000_task_settings";
test("topic migration preserves old conversation settings and enforces cascade and unlink ownership after restart", () => {
  const root = mkdtempSync(join(tmpdir(), "ria-topic-upgrade-"));
  try {
    const databaseFile = join(root, "app.db"), migrationsDirectory = resolve("src/db/migrations"), migration = "20261009090000_knowledge_topics";
    const before = new DatabaseSync(databaseFile);
    try {
      before.exec("CREATE TABLE desktop_migrations (name TEXT PRIMARY KEY, appliedAt DATETIME DEFAULT CURRENT_TIMESTAMP)");
      for (const name of readdirSync(migrationsDirectory).filter(name => name < migration).sort()) { before.exec(readFileSync(join(migrationsDirectory, name, "migration.sql"), "utf8")); before.prepare("INSERT INTO desktop_migrations (name) VALUES (?)").run(name); }
      before.exec("INSERT INTO chats (id,title,documentScope,ephemeral,assistantConfig,updatedAt) VALUES ('old','Existing conversation','财务',1,'{\"snapshot\":true}',CURRENT_TIMESTAMP)");
    } finally { before.close(); }
    const options = { databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger: { info() {}, warn() {}, error() {} }, upToMigration: LAST_WITH_TOPICS };
    const result = runDesktopMigrations(options); assert.deepEqual(result.applied, readdirSync(migrationsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name >= migration && entry.name <= LAST_WITH_TOPICS).map(entry => entry.name).sort()); assert.ok(result.backupFile);
    const backup = new DatabaseSync(result.backupFile, { readOnly: true });
    try { assert.equal(backup.prepare("PRAGMA table_info(chats)").all().some(row => row.name === "topicId"), false); } finally { backup.close(); }
    assert.deepEqual(runDesktopMigrations(options).applied, []);
    const reopened = new DatabaseSync(databaseFile);
    try {
      reopened.exec("PRAGMA foreign_keys=ON"); const chat = reopened.prepare("SELECT * FROM chats WHERE id='old'").get();
      assert.equal(chat.topicId, null); assert.equal(chat.documentScope, "财务"); assert.equal(chat.ephemeral, 1); assert.equal(chat.assistantConfig, '{"snapshot":true}');
      reopened.exec("INSERT INTO knowledge_topics (id,config,updatedAt) VALUES ('topic','{}',CURRENT_TIMESTAMP); UPDATE chats SET topicId='topic' WHERE id='old'; INSERT INTO knowledge_artifacts (id,topicId,requestHash,title,kind,topicRevision,status,metadata,updatedAt) VALUES ('artifact','topic','hash','Saved','summary',1,'failed','{}',CURRENT_TIMESTAMP); DELETE FROM knowledge_topics WHERE id='topic';");
      assert.equal(reopened.prepare("SELECT topicId FROM chats WHERE id='old'").get().topicId, null); assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM knowledge_artifacts").get().count, 0); assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM chats").get().count, 1);
      assert.deepEqual(reopened.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { reopened.close(); }
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "ria-topic-upgrade-"))) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});

test("removing knowledge topics leaves ordinary conversations behind and turns finished results into conversations", () => {
  const root = mkdtempSync(join(tmpdir(), "ria-topic-upgrade-"));
  try {
    const databaseFile = join(root, "app.db"), migrationsDirectory = resolve("src/db/migrations");
    const options = { databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger: { info() {}, warn() {}, error() {} } };
    runDesktopMigrations({ ...options, upToMigration: LAST_WITH_TOPICS });
    const before = new DatabaseSync(databaseFile);
    try {
      const at = Date.parse("2026-10-20T08:00:00Z"), later = Date.parse("2026-10-20T08:05:00Z");
      before.prepare("INSERT INTO knowledge_topics (id,config,updatedAt) VALUES ('topic',?,?)").run(JSON.stringify({ name: "差旅", description: "", collections: ["财务", "A|B"], assistantTemplateId: null }), at);
      const artifact = before.prepare("INSERT INTO knowledge_artifacts (id,topicId,requestHash,title,kind,topicRevision,status,content,metadata,createdAt,updatedAt) VALUES (?,?,?,?,?,1,?,?,?,?,?)");
      artifact.run("ready", "topic", "a".repeat(64), "核销总结", "summary", "ready", "十个工作日内核销。", JSON.stringify({ brief: "费用核销时限" }), at, later);
      artifact.run("failed", "topic", "b".repeat(64), "未完成", "summary", "failed", null, JSON.stringify({ brief: "x" }), at, later);
      const chat = before.prepare("INSERT INTO chats (id,title,topicId,documentScope,assistantConfig,updatedAt) VALUES (?,?,?,?,?,?)");
      chat.run("topic-chat", "专题对话", "topic", "财务", null, at);
      chat.run("stale-chat", "旧对话", null, "医疗", null, at);
      chat.run("template-chat", "模板对话", null, "医疗", JSON.stringify({ templateId: "t" }), at);
      before.prepare("INSERT INTO messages (id,chatId,role,content) VALUES ('kept-message','topic-chat','user','保留')").run();
    } finally { before.close(); }
    assert.deepEqual(runDesktopMigrations(options).applied, ["20261116100000_remove_knowledge_topics"]);
    const after = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      // Every conversation stays, with nothing of the topic left on it: no link and no scope of its own.
      assert.deepEqual(after.prepare("SELECT id FROM chats ORDER BY id").all().map(row => row.id), ["result-ready", "stale-chat", "template-chat", "topic-chat"]);
      const columns = after.prepare("PRAGMA table_info(chats)").all().map(column => column.name);
      assert.equal(columns.includes("topicId") || columns.includes("documentScope"), false);
      assert.equal(after.prepare("SELECT assistantConfig FROM chats WHERE id = 'template-chat'").get().assistantConfig, JSON.stringify({ templateId: "t" }), "a template conversation keeps its template");
      assert.equal(after.prepare("SELECT title FROM chats WHERE id = 'result-ready'").get().title, "差旅 · 核销总结");
      assert.deepEqual(after.prepare("SELECT role, content FROM messages WHERE chatId = 'result-ready' ORDER BY createdAt, id").all().map(row => ({ ...row })), [
        { role: "user", content: "费用核销时限" }, { role: "assistant", content: "十个工作日内核销。" },
      ]);
      assert.equal(after.prepare("SELECT count(*) AS count FROM chats WHERE id = 'result-failed'").get().count, 0);
      assert.equal(after.prepare("SELECT count(*) AS count FROM messages WHERE id = 'kept-message'").get().count, 1, "messages survive the table rebuild");
      // The converted conversation is found by search like any other.
      assert.equal(after.prepare("SELECT count(*) AS count FROM chat_title_search WHERE text MATCH '核销总结'").get().count, 1);
      const tables = after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
      assert.equal(tables.includes("knowledge_topics") || tables.includes("knowledge_artifacts"), false);
      assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { after.close(); }
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "ria-topic-upgrade-"))) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
