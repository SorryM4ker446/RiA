import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { runDesktopMigrations } = require("../../electron-dist/migrations.js");
const migrationsDirectory = resolve("src/db/migrations");

test("the upgrade removes only unaccepted suggestions left by creating tasks, once, and logs how many", () => {
  const root = mkdtempSync(join(tmpdir(), "ria-task-memory-upgrade-"));
  const databaseFile = join(root, "app.db");
  const migration = "20261025100000_drop_task_memory_candidates";
  const logged: { message: string; details?: { migrationName?: string; rowsChanged?: number } }[] = [];
  const options = {
    databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"),
    logger: { info(message: string, details?: { migrationName?: string; rowsChanged?: number }) { logged.push({ message, details }); }, warn() {}, error() {} },
  };
  const rows = [
    ["inferred-task", "tool:createTask:review-notes", "assistant", 0],
    ["accepted-task", "tool:createTask:buy-milk", "assistant", 1],
    ["typed-task", "tool:createTask:own-words", "manual", 1],
    ["other-tool", "tool:searchKnowledge:generics", "assistant", 0],
    ["other-case", "tool:createtask:lowercase", "assistant", 0],
  ] as const;
  try {
    const before = new DatabaseSync(databaseFile);
    try {
      before.exec("CREATE TABLE desktop_migrations (name TEXT PRIMARY KEY, appliedAt DATETIME DEFAULT CURRENT_TIMESTAMP)");
      for (const directory of readdirSync(migrationsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name < migration).sort((a, b) => a.name.localeCompare(b.name))) {
        before.exec(readFileSync(join(migrationsDirectory, directory.name, "migration.sql"), "utf8"));
        before.prepare("INSERT INTO desktop_migrations (name) VALUES (?)").run(directory.name);
      }
      const insert = before.prepare('INSERT INTO "memories" ("id","key","value","source","confirmed","updatedAt") VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)');
      for (const [id, key, source, confirmed] of rows) insert.run(id, key, `value of ${id}`, source, confirmed);
    } finally { before.close(); }

    const upgrade = runDesktopMigrations(options);
    assert.ok(upgrade.applied.includes(migration));
    assert.deepEqual(logged.find(entry => entry.details?.migrationName === migration)?.details, { migrationName: migration, rowsChanged: 1 });
    // The removed suggestion is still in the backup taken before the upgrade.
    const backup = new DatabaseSync(upgrade.backupFile, { readOnly: true });
    try { assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM "memories"').get().count, rows.length); } finally { backup.close(); }

    const remaining = () => {
      const upgraded = new DatabaseSync(databaseFile, { readOnly: true });
      try { return upgraded.prepare('SELECT "id" FROM "memories" ORDER BY "id"').all().map(row => row.id); } finally { upgraded.close(); }
    };
    assert.deepEqual(remaining(), ["accepted-task", "other-case", "other-tool", "typed-task"]);

    // A later start applies nothing and removes nothing more.
    assert.deepEqual(runDesktopMigrations(options).applied, []);
    assert.deepEqual(remaining(), ["accepted-task", "other-case", "other-tool", "typed-task"]);
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "ria-task-memory-upgrade-"))) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
