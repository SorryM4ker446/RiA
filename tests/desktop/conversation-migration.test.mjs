import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { test } from "node:test";

const { runDesktopMigrations } = createRequire(import.meta.url)("../../electron-dist/migrations.js");
const migrationsDirectory = resolve("src/db/migrations");
test("conversation migration backfills safe text, survives vacuum and restart, and cascades indexes", () => {
  const root = mkdtempSync(join(tmpdir(), "private-ai-conversation-upgrade-"));
  const databaseFile = join(root, "app.db");
  const migration = "20260831100000_conversation_management";
  const options = { databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger: { info() {}, warn() {}, error() {} } };
  try {
    const old = new DatabaseSync(databaseFile);
    try {
      old.exec("CREATE TABLE desktop_migrations (name TEXT PRIMARY KEY, appliedAt DATETIME DEFAULT CURRENT_TIMESTAMP)");
      for (const entry of readdirSync(migrationsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name < migration).sort((a, b) => a.name.localeCompare(b.name))) {
        old.exec(readFileSync(join(migrationsDirectory, entry.name, "migration.sql"), "utf8"));
        old.prepare("INSERT INTO desktop_migrations (name) VALUES (?)").run(entry.name);
      }
      old.exec("INSERT INTO users (id,email,updatedAt) VALUES ('owner','conversation-upgrade@example.invalid',CURRENT_TIMESTAMP)");
      old.exec("INSERT INTO chats (rowid,id,userId,title,updatedAt) VALUES (42,'chat','owner','月光旅行',CURRENT_TIMESTAMP)");
      const insert = old.prepare("INSERT INTO messages (id,chatId,role,content) VALUES (?,'chat','user',?)");
      insert.run("plain", "最早的历史消息");
      insert.run("structured", '__USER_MESSAGE__:{"type":"user-message","text":"附件的可见正文","files":[{"url":"data:image/png;base64,hidden-binary"}]}');
      insert.run("broken", "__USER_MESSAGE__:{hidden-malformed");
    } finally { old.close(); }
    const applied = runDesktopMigrations(options);
    assert.deepEqual(applied.applied, readdirSync(migrationsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name >= migration).map(entry => entry.name).sort());
    assert.ok(applied.backupFile);
    const backup = new DatabaseSync(applied.backupFile, { readOnly: true });
    try {
      assert.equal(backup.prepare("SELECT title FROM chats").get().title, "月光旅行");
      assert.equal(backup.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='message_text_search'").get().count, 0);
    } finally { backup.close(); }
    const db = new DatabaseSync(databaseFile);
    try {
      db.exec("PRAGMA foreign_keys=ON; VACUUM");
      assert.deepEqual({ ...db.prepare("SELECT pinned,archived FROM chats").get() }, { pinned: 0, archived: 0 });
      assert.equal(db.prepare("SELECT id FROM chat_title_search WHERE chat_title_search MATCH ?").get('"月光旅行"').id, "chat");
      assert.equal(db.prepare("SELECT id FROM message_text_search WHERE message_text_search MATCH ?").get('"可见正文"').id, "structured");
      assert.equal(db.prepare("SELECT count(*) AS count FROM message_text_search WHERE message_text_search MATCH ?").get('"hidden"').count, 0);
      db.exec("UPDATE chats SET pinned=1,archived=1,title='Changed title'; INSERT INTO chat_tags VALUES ('chat','work'); UPDATE messages SET content='Edited history' WHERE id='plain'");
      assert.equal(db.prepare("SELECT count(*) AS count FROM chat_title_search WHERE chat_title_search MATCH ?").get('"月光旅行"').count, 0);
    } finally { db.close(); }
    assert.deepEqual(runDesktopMigrations(options).applied, []);
    const reopened = new DatabaseSync(databaseFile);
    try {
      reopened.exec("PRAGMA foreign_keys=ON");
      assert.equal(reopened.prepare("SELECT id FROM message_text_search WHERE message_text_search MATCH ?").get('"Edited history"').id, "plain");
      assert.equal(reopened.prepare("SELECT pinned FROM chats").get().pinned, 1);
      assert.equal(reopened.prepare("SELECT label FROM chat_tags").get().label, "work");
      reopened.exec("DELETE FROM users WHERE id='owner'");
      for (const table of ["chat_tags", "chat_title_search", "message_text_search"]) assert.equal(reopened.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0);
    } finally { reopened.close(); }
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "private-ai-conversation-upgrade-"))) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
