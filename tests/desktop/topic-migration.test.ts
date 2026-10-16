import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const { runDesktopMigrations } = require("../../electron-dist/migrations.js");
test("topic migration preserves old conversation settings and enforces cascade and unlink ownership after restart", () => {
  const root = mkdtempSync(join(tmpdir(), "private-ai-topic-upgrade-"));
  try {
    const databaseFile = join(root, "app.db"), migrationsDirectory = resolve("src/db/migrations"), migration = "20261009090000_knowledge_topics";
    const before = new DatabaseSync(databaseFile);
    try {
      before.exec("CREATE TABLE desktop_migrations (name TEXT PRIMARY KEY, appliedAt DATETIME DEFAULT CURRENT_TIMESTAMP)");
      for (const name of readdirSync(migrationsDirectory).filter(name => name < migration).sort()) { before.exec(readFileSync(join(migrationsDirectory, name, "migration.sql"), "utf8")); before.prepare("INSERT INTO desktop_migrations (name) VALUES (?)").run(name); }
      before.exec("INSERT INTO chats (id,title,documentScope,ephemeral,assistantConfig,updatedAt) VALUES ('old','Existing conversation','财务',1,'{\"snapshot\":true}',CURRENT_TIMESTAMP)");
    } finally { before.close(); }
    const options = { databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger: { info() {}, warn() {}, error() {} } };
    const result = runDesktopMigrations(options); assert.deepEqual(result.applied, [migration]); assert.ok(result.backupFile);
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
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "private-ai-topic-upgrade-"))) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
