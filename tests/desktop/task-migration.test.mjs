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

test("task reminder migration retains legacy dates and defaults to no notifications or recurrence", () => {
  const root = mkdtempSync(join(tmpdir(), "private-ai-task-upgrade-"));
  const databaseFile = join(root, "app.db");
  const migration = "20260831090000_task_reminders";
  const options = { databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger: { info() {}, warn() {}, error() {} } };
  try {
    const before = new DatabaseSync(databaseFile);
    try {
      before.exec("CREATE TABLE desktop_migrations (name TEXT PRIMARY KEY, appliedAt DATETIME DEFAULT CURRENT_TIMESTAMP)");
      for (const directory of readdirSync(migrationsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name < migration).sort((a, b) => a.name.localeCompare(b.name))) {
        before.exec(readFileSync(join(migrationsDirectory, directory.name, "migration.sql"), "utf8"));
        before.prepare("INSERT INTO desktop_migrations (name) VALUES (?)").run(directory.name);
      }
      before.exec("INSERT INTO users (id,email,updatedAt) VALUES ('owner','task-migration@example.invalid',CURRENT_TIMESTAMP)");
      before.prepare("INSERT INTO tasks (id,userId,title,dueDate,updatedAt) VALUES ('task','owner','Legacy task',?,CURRENT_TIMESTAMP)").run(1788048000000);
    } finally { before.close(); }
    const applied = runDesktopMigrations(options);
    assert.deepEqual(applied.applied, [migration]);
    assert.ok(applied.backupFile);
    const backup = new DatabaseSync(applied.backupFile, { readOnly: true });
    try {
      assert.equal(backup.prepare("SELECT title FROM tasks").get().title, "Legacy task");
      assert.equal(backup.prepare("PRAGMA table_info(tasks)").all().some(column => column.name === "timeZone"), false);
    } finally { backup.close(); }
    const upgraded = new DatabaseSync(databaseFile);
    try {
      assert.deepEqual({ ...upgraded.prepare("SELECT dueDate,timeZone,reminderEnabled,remindedAt,repeatRule,repeatGenerated FROM tasks").get() }, {
        dueDate: 1788048000000, timeZone: "UTC", reminderEnabled: 0, remindedAt: null, repeatRule: "none", repeatGenerated: 0,
      });
      upgraded.exec("UPDATE tasks SET reminderEnabled=1, remindedAt=1788134400000, repeatGenerated=1");
    } finally { upgraded.close(); }
    assert.deepEqual(runDesktopMigrations(options).applied, []);
    const reopened = new DatabaseSync(databaseFile);
    try {
      assert.deepEqual({ ...reopened.prepare("SELECT reminderEnabled,remindedAt,repeatGenerated FROM tasks").get() }, { reminderEnabled: 1, remindedAt: 1788134400000, repeatGenerated: 1 });
    } finally { reopened.close(); }
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "private-ai-task-upgrade-"))) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
