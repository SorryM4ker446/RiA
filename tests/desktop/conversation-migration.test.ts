import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { test } from "node:test";

import { accountScopedMigrationsFrom, applyMigrations } from "../helpers/legacy-workspace";

const { runDesktopMigrations } = createRequire(import.meta.url)("../../electron-dist/migrations.js");
const migrationsDirectory = resolve("src/db/migrations");

test("upgrading restores naming eligibility for legacy unused chats with stock titles", () => {
  const root = mkdtempSync(join(tmpdir(), "ria-chat-title-upgrade-"));
  const databaseFile = join(root, "app.db");
  const options = { databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger: { info() {}, warn() {}, error() {} } };
  const sourceMigration = "20261126100000_chat_title_source";
  const cutoff = Date.parse("2026-10-21T12:00:00Z");
  try {
    runDesktopMigrations({ ...options, upToMigration: "20261125100100_media_content_hash" });
    const database = new DatabaseSync(databaseFile);
    try {
      const chat = database.prepare('INSERT INTO chats (id,title,createdAt,updatedAt) VALUES (?,?,?,?)');
      chat.run("empty", "新会话", "2026-10-21 11:59:00", cutoff - 60_000);
      chat.run("used-after", "New Chat", cutoff - 60_000, cutoff - 60_000);
      chat.run("used-before", "New Chat", cutoff - 60_000, cutoff - 60_000);
      chat.run("custom", "My title", cutoff - 60_000, cutoff - 60_000);
      chat.run("manual", "New Chat", cutoff - 60_000, cutoff - 60_000);
      chat.run("task", "Untitled", cutoff - 60_000, cutoff - 60_000);
      const message = database.prepare("INSERT INTO messages (id,chatId,role,content,createdAt) VALUES (?,?,'user','Hello',?)");
      message.run("before", "used-before", cutoff - 30_000);
      database.exec("INSERT INTO scheduled_jobs (id,kind,timeZone,chatId,updatedAt) VALUES ('job','prompt','UTC','task',CURRENT_TIMESTAMP)");
    } finally { database.close(); }

    runDesktopMigrations({ ...options, upToMigration: "20261127100000_chat_model_preferences" });
    const previous = new DatabaseSync(databaseFile);
    try {
      previous.prepare("UPDATE desktop_migrations SET appliedAt = '2026-10-21 12:00:00' WHERE name = ?").run(sourceMigration);
      previous.exec("UPDATE chats SET titleSource = 'manual' WHERE id = 'manual'");
      previous.prepare('INSERT INTO chats (id,title,createdAt,updatedAt) VALUES (?,?,?,?)').run("newer", "New Chat", cutoff + 60_000, cutoff + 60_000);
      const message = previous.prepare("INSERT INTO messages (id,chatId,role,content,createdAt) VALUES (?,'used-after','user','Hello',?)");
      for (let turn = 1; turn <= 3; turn++) message.run(`after-${turn}`, cutoff + turn * 6000);
    } finally { previous.close(); }

    assert.deepEqual(runDesktopMigrations(options).applied, ["20261128100000_chat_title_attempts"]);
    assert.deepEqual(runDesktopMigrations(options).applied, []);
    const upgraded = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      const titles = upgraded.prepare('SELECT id,titleSource,titleAttempts FROM chats ORDER BY id').all();
      assert.deepEqual(titles.map(row => [row.id, row.titleSource, row.titleAttempts]), [
        ["custom", "named", 0], ["empty", "auto", 0], ["manual", "manual", 0], ["newer", "named", 0],
        ["task", "named", 0], ["used-after", "auto", 0], ["used-before", "named", 0],
      ]);
    } finally { upgraded.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upgrading recovers the last recorded chat model without changing model-less conversations", () => {
  const root = mkdtempSync(join(tmpdir(), "ria-chat-model-upgrade-"));
  const databaseFile = join(root, "app.db");
  try {
    applyMigrations(databaseFile, { upTo: "20261126100000_chat_title_source", includeWorkspaceMigration: true });
    const database = new DatabaseSync(databaseFile);
    try {
      database.exec("INSERT INTO chats (id,title,updatedAt) VALUES ('used','Used',CURRENT_TIMESTAMP),('blank','Blank',CURRENT_TIMESTAMP),('damaged','Damaged',CURRENT_TIMESTAMP)");
      const answer = database.prepare("INSERT INTO messages (id,chatId,role,content,createdAt) VALUES (?,?,'assistant',?,?)");
      const recorded = (modelLabel: string) => `__ASSISTANT_TOOL_MESSAGE__:${JSON.stringify({ modelLabel })}`;
      answer.run("a", "used", recorded("openrouter/vendor/older"), "2026-10-20");
      answer.run("b", "used", recorded("deepseek/deepseek-chat"), "2026-10-21");
      answer.run("c", "damaged", "__ASSISTANT_TOOL_MESSAGE__:{broken", "2026-10-21");
      database.exec(readFileSync(join(migrationsDirectory, "20261127100000_chat_model_preferences", "migration.sql"), "utf8"));
      const read = (id: string) => database.prepare("SELECT modelPreferences FROM chats WHERE id=?").get(id)?.modelPreferences;
      assert.deepEqual(JSON.parse(String(read("used"))), { selectedChatModel: { providerId: "deepseek", modelId: "deepseek-chat" } });
      assert.equal(read("blank"), null);
      assert.equal(read("damaged"), null);
    } finally { database.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("conversation migration backfills safe text, survives vacuum and restart, and cascades indexes", () => {
  const root = mkdtempSync(join(tmpdir(), "ria-conversation-upgrade-"));
  const databaseFile = join(root, "app.db");
  const migration = "20260831100000_conversation_management";
  // The account-to-workspace conversion is exercised separately; this test stays
  // on the account-scoped schema it was written for and applies one range.
  const lastAccountScopedMigration = "20260831150000_account_preferences_and_model_usage";
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
    const applied = runDesktopMigrations({ ...options, upToMigration: lastAccountScopedMigration });
    assert.deepEqual(applied.applied, accountScopedMigrationsFrom(migration));    assert.ok(applied.backupFile);
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
    assert.deepEqual(runDesktopMigrations({ ...options, upToMigration: lastAccountScopedMigration }).applied, []);
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
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "ria-conversation-upgrade-"))) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
