import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const { runDesktopMigrations } = require("../../electron-dist/migrations.js");

test("unlimited run budgets preserve historical limits and steps and survive restart", () => {
  const root = mkdtempSync(join(tmpdir(), "ria-agent-budget-migration-"));
  try {
    const databaseFile = join(root, "app.db"), migrationsDirectory = resolve("src/db/migrations"), migration = "20261020140000_unbounded_agent_runs";
    const old = new DatabaseSync(databaseFile);
    try {
      old.exec("CREATE TABLE desktop_migrations (name TEXT PRIMARY KEY, appliedAt DATETIME DEFAULT CURRENT_TIMESTAMP)");
      for (const name of readdirSync(migrationsDirectory).filter(name => /^\d/.test(name) && name < migration).sort()) {
        old.exec(readFileSync(join(migrationsDirectory, name, "migration.sql"), "utf8"));
        old.prepare("INSERT INTO desktop_migrations (name) VALUES (?)").run(name);
      }
      old.exec("INSERT INTO agent_runs(id,goal,status,updatedAt) VALUES ('old','Historical','succeeded',CURRENT_TIMESTAMP)");
      old.exec("INSERT INTO agent_steps(id,runId,position,kind,state) VALUES ('old-step','old',1,'tool','done')");
    } finally { old.close(); }
    const options = { databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger: { info() {}, warn() {}, error() {} } };
    const result = runDesktopMigrations(options);
    assert.ok(result.backupFile);
    assert.deepEqual(result.applied, [migration]);
    assert.deepEqual(runDesktopMigrations(options).applied, []);
    const current = new DatabaseSync(databaseFile);
    try {
      current.exec("PRAGMA foreign_keys=ON");
      assert.deepEqual({ ...current.prepare("SELECT maxSteps,maxFailures,deadlineMs FROM agent_runs WHERE id='old'").get() }, { maxSteps: 8, maxFailures: 2, deadlineMs: 120000 });
      assert.equal(current.prepare("SELECT count(*) AS n FROM agent_steps WHERE runId='old'").get().n, 1);
      current.exec("INSERT INTO agent_runs(id,goal,updatedAt) VALUES ('new','Unbounded',CURRENT_TIMESTAMP)");
      assert.deepEqual({ ...current.prepare("SELECT maxSteps,maxFailures,deadlineMs FROM agent_runs WHERE id='new'").get() }, { maxSteps: null, maxFailures: null, deadlineMs: null });
      assert.deepEqual(current.prepare("PRAGMA foreign_key_check").all(), []);
      current.exec("DELETE FROM agent_runs WHERE id='old'");
      assert.equal(current.prepare("SELECT count(*) AS n FROM agent_steps").get().n, 0);
    } finally { current.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
