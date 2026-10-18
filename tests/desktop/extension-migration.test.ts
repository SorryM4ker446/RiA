import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { runDesktopMigrations } = require("../../electron-dist/migrations.js");

test("extension migration preserves existing chats, makes a safety copy and survives repeated startup", () => {
  const root = mkdtempSync(join(tmpdir(), "ria-extension-upgrade-"));
  try {
    const databaseFile = join(root, "app.db"), migrationsDirectory = resolve("src/db/migrations"), migration = "20261017120000_extensions";
    const before = new DatabaseSync(databaseFile);
    try {
      before.exec("CREATE TABLE desktop_migrations (name TEXT PRIMARY KEY, appliedAt DATETIME DEFAULT CURRENT_TIMESTAMP)");
      for (const name of readdirSync(migrationsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name < migration).map(entry => entry.name).sort()) {
        before.exec(readFileSync(join(migrationsDirectory, name, "migration.sql"), "utf8"));
        before.prepare("INSERT INTO desktop_migrations (name) VALUES (?)").run(name);
      }
      before.exec("INSERT INTO chats (id,title,updatedAt) VALUES ('old','Existing conversation',CURRENT_TIMESTAMP)");
    } finally { before.close(); }
    const options = { databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger: { info() {}, warn() {}, error() {} } };
    const result = runDesktopMigrations(options);
    assert.deepEqual(result.applied, readdirSync(migrationsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name >= migration).map(entry => entry.name).sort());
    assert.ok(result.backupFile);
    const backup = new DatabaseSync(result.backupFile, { readOnly: true });
    try {
      assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='extensions'").get().count, 0);
      assert.equal(backup.prepare("SELECT title FROM chats WHERE id='old'").get().title, "Existing conversation");
    } finally { backup.close(); }
    assert.deepEqual(runDesktopMigrations(options).applied, []);
    const reopened = new DatabaseSync(databaseFile);
    try {
      assert.equal(reopened.prepare("SELECT title FROM chats WHERE id='old'").get().title, "Existing conversation");
      assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM extensions").get().count, 0);
      assert.deepEqual(reopened.prepare("PRAGMA table_info(extensions)").all().filter(row => ["enabled", "revision"].includes(String(row.name))).map(row => [row.name, row.dflt_value]), [["enabled", "false"], ["revision", "1"]]);
    } finally { reopened.close(); }
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "ria-extension-upgrade-"))) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
