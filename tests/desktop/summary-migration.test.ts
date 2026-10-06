import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const { runDesktopMigrations } = require("../../electron-dist/migrations.js");
test("summary revision upgrade snapshots the database, drops unverifiable compression and preserves message history", () => {
  const root = mkdtempSync(join(tmpdir(), "ria-summary-upgrade-"));
  const databaseFile = join(root, "app.db");
  const options = { databaseFile, migrationsDirectory: resolve("src/db/migrations"), backupsDirectory: join(root, "backups"), logger: { info() {}, warn() {}, error() {} } };
  try {
    runDesktopMigrations({ ...options, upToMigration: "20261004110000_workspace_activity_reviews" });
    const before = new DatabaseSync(databaseFile);
    try {
      before.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
      before.exec("INSERT INTO chats (id,title,summary,summaryUpToMessageId,summaryModelId,updatedAt) VALUES ('chat','Original history','Unverified compression','message','openrouter:fixture',CURRENT_TIMESTAMP); INSERT INTO messages (id,chatId,role,content) VALUES ('message','chat','user','Original decision')");
    } catch (error) { before.close(); throw error; }
    let upgrade;
    try { upgrade = runDesktopMigrations(options); } finally { before.close(); }
    assert.ok(upgrade.backupFile);
    const backup = new DatabaseSync(upgrade.backupFile, { readOnly: true });
    try { assert.equal(backup.prepare("SELECT summary FROM chats").get().summary, "Unverified compression"); } finally { backup.close(); }
    const current = new DatabaseSync(databaseFile);
    try {
      assert.deepEqual({ ...current.prepare("SELECT summary, summaryUpToMessageId, historyRevision, summaryRevision FROM chats").get() }, { summary: null, summaryUpToMessageId: null, historyRevision: 0, summaryRevision: null });
      assert.equal(current.prepare("SELECT content FROM messages").get().content, "Original decision");
    } finally { current.close(); }
    assert.equal(runDesktopMigrations(options).applied.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
