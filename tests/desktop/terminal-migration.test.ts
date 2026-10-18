import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const { runDesktopMigrations } = require("../../electron-dist/migrations.js");

test("terminal upgrade keeps existing file grants without granting execution and is restart-safe", () => {
  const root = mkdtempSync(join(tmpdir(), "ria-terminal-migration-"));
  try {
    const databaseFile = join(root, "app.db"), migrationsDirectory = resolve("src/db/migrations"), migration = "20261018180000_terminal_permissions";
    const old = new DatabaseSync(databaseFile);
    try {
      old.exec("CREATE TABLE desktop_migrations (name TEXT PRIMARY KEY, appliedAt DATETIME DEFAULT CURRENT_TIMESTAMP)");
      for (const name of readdirSync(migrationsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name < migration).map(entry => entry.name).sort()) {
        old.exec(readFileSync(join(migrationsDirectory, name, "migration.sql"), "utf8"));
        old.prepare("INSERT INTO desktop_migrations (name) VALUES (?)").run(name);
      }
      old.exec("INSERT INTO directory_grants(id,label,path,realPath,updatedAt) VALUES ('existing','Existing','fixture/path','fixture/path',CURRENT_TIMESTAMP)");
    } finally { old.close(); }
    const options = { databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger: { info() {}, warn() {}, error() {} } };
    const result = runDesktopMigrations(options);
    assert.deepEqual(result.applied, readdirSync(migrationsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name >= migration).map(entry => entry.name).sort()); assert.ok(result.backupFile);
    assert.deepEqual(runDesktopMigrations(options).applied, []);
    const current = new DatabaseSync(databaseFile);
    try {
      assert.deepEqual({ ...current.prepare("SELECT label,revokedAt,terminalEnabled FROM directory_grants WHERE id='existing'").get() }, { label: "Existing", revokedAt: null, terminalEnabled: 0 });
      assert.deepEqual(current.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { current.close(); }
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !basename(root).startsWith("ria-terminal-migration-")) throw new Error("Unexpected terminal test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
