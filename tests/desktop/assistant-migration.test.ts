import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { runDesktopMigrations } = require("../../electron-dist/migrations.js");
test("assistant migration retains conversations, snapshots the old database and is idempotent after restart", () => {
  const root = mkdtempSync(join(tmpdir(), "private-ai-assistant-upgrade-"));
  try {
    const databaseFile = join(root, "app.db"), migrationsDirectory = resolve("src/db/migrations"), migration = "20261008120000_assistant_templates";
    const before = new DatabaseSync(databaseFile);
    try {
      before.exec("CREATE TABLE desktop_migrations (name TEXT PRIMARY KEY, appliedAt DATETIME DEFAULT CURRENT_TIMESTAMP)");
      for (const name of readdirSync(migrationsDirectory).filter(name => name < migration).sort()) {
        before.exec(readFileSync(join(migrationsDirectory, name, "migration.sql"), "utf8")); before.prepare("INSERT INTO desktop_migrations (name) VALUES (?)").run(name);
      }
      before.exec("INSERT INTO chats (id,title,documentScope,ephemeral,updatedAt) VALUES ('old','Existing conversation','财务',1,CURRENT_TIMESTAMP)");
    } finally { before.close(); }
    const options = { databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger: { info() {}, warn() {}, error() {} } };
    const result = runDesktopMigrations(options); assert.deepEqual(result.applied, [migration]); assert.ok(result.backupFile);
    const backup = new DatabaseSync(result.backupFile, { readOnly: true });
    try { assert.equal(backup.prepare("PRAGMA table_info(chats)").all().some(row => row.name === "assistantConfig"), false); } finally { backup.close(); }
    assert.deepEqual(runDesktopMigrations(options).applied, []);
    const reopened = new DatabaseSync(databaseFile);
    try { const chat = reopened.prepare("SELECT * FROM chats WHERE id='old'").get(); assert.equal(chat.title, "Existing conversation"); assert.equal(chat.documentScope, "财务"); assert.equal(chat.ephemeral, 1); assert.equal(chat.assistantConfig, null); assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM assistant_templates").get().count, 0); } finally { reopened.close(); }
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "private-ai-assistant-upgrade-"))) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
