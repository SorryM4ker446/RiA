import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const { runDesktopMigrations } = require("../../electron-dist/migrations.js");

test("tool call identity upgrade preserves historical summaries and is safe to repeat", () => {
  const root = mkdtempSync(join(tmpdir(), "ria-execution-migration-"));
  try {
    const databaseFile = join(root, "app.db");
    const migrationsDirectory = resolve("src/db/migrations");
    const migration = "20261020200000_agent_step_tool_call_id";
    const old = new DatabaseSync(databaseFile);
    try {
      old.exec("CREATE TABLE desktop_migrations (name TEXT PRIMARY KEY, appliedAt DATETIME DEFAULT CURRENT_TIMESTAMP)");
      for (const name of readdirSync(migrationsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name < migration).map(entry => entry.name).sort()) {
        old.exec(readFileSync(join(migrationsDirectory, name, "migration.sql"), "utf8"));
        old.prepare("INSERT INTO desktop_migrations (name) VALUES (?)").run(name);
      }
      old.exec("INSERT INTO agent_runs(id,goal,status,updatedAt) VALUES ('old-run','Historical request','succeeded',CURRENT_TIMESTAMP)");
      old.exec("INSERT INTO agent_steps(id,runId,position,kind,toolName,state,input) VALUES ('old-step','old-run',1,'tool','readLocalFile','done','\"saved-summary\"')");
    } finally { old.close(); }
    const options = { databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger: { info() {}, warn() {}, error() {} } };
    const result = runDesktopMigrations(options);
    assert.ok(result.backupFile);
    assert.deepEqual(result.applied, readdirSync(migrationsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name >= migration).map(entry => entry.name).sort());
    assert.deepEqual(runDesktopMigrations(options).applied, []);
    const current = new DatabaseSync(databaseFile);
    try {
      assert.deepEqual({ ...current.prepare("SELECT id,input,toolCallId FROM agent_steps WHERE id='old-step'").get() }, { id: "old-step", input: '"saved-summary"', toolCallId: null });
      current.exec("INSERT INTO agent_steps(id,runId,position,kind,toolName,state,toolCallId) VALUES ('new-step','old-run',2,'tool','readLocalFile','done','new-call')");
      assert.equal(current.prepare("SELECT toolCallId FROM agent_steps WHERE id='new-step'").get()!.toolCallId, "new-call");
      assert.deepEqual(current.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { current.close(); }
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !basename(root).startsWith("ria-execution-migration-")) throw new Error("Unexpected execution test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
