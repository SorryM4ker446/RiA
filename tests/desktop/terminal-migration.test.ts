import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const { runDesktopMigrations } = require("../../electron-dist/migrations.js");
// The last migration whose grants still have a terminal switch; the one after it moves approval onto conversations.
const LAST_WITH_SWITCH = "20261113100000_task_model_folder";

for (const enabled of [false, true]) {
  test(enabled ? "terminal mode upgrade preserves enabled grants with approval and retains selected modes on restart" : "terminal upgrade keeps existing file grants without granting execution and is restart-safe", () => {
    const root = mkdtempSync(join(tmpdir(), "ria-terminal-migration-"));
    try {
      const databaseFile = join(root, "app.db"), migrationsDirectory = resolve("src/db/migrations"), migration = enabled ? "20261019180000_terminal_approval_mode" : "20261018180000_terminal_permissions";
      const old = new DatabaseSync(databaseFile);
      try {
        old.exec("CREATE TABLE desktop_migrations (name TEXT PRIMARY KEY, appliedAt DATETIME DEFAULT CURRENT_TIMESTAMP)");
        for (const name of readdirSync(migrationsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name < migration).map(entry => entry.name).sort()) {
          old.exec(readFileSync(join(migrationsDirectory, name, "migration.sql"), "utf8"));
          old.prepare("INSERT INTO desktop_migrations (name) VALUES (?)").run(name);
        }
        old.exec("INSERT INTO directory_grants(id,label,path,realPath,updatedAt) VALUES ('existing','Existing','fixture/path','fixture/path',CURRENT_TIMESTAMP)");
        if (enabled) old.exec("UPDATE directory_grants SET terminalEnabled=1 WHERE id='existing'");
      } finally { old.close(); }
      const options = { databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger: { info() {}, warn() {}, error() {} }, upToMigration: LAST_WITH_SWITCH };
      const result = runDesktopMigrations(options);
      assert.deepEqual(result.applied, readdirSync(migrationsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name >= migration && entry.name <= LAST_WITH_SWITCH).map(entry => entry.name).sort()); assert.ok(result.backupFile);
      assert.deepEqual(runDesktopMigrations(options).applied, []);
      const current = new DatabaseSync(databaseFile);
      try {
        assert.deepEqual({ ...current.prepare("SELECT label,revokedAt,terminalEnabled,terminalApprovalMode FROM directory_grants WHERE id='existing'").get() }, { label: "Existing", revokedAt: null, terminalEnabled: Number(enabled), terminalApprovalMode: "approval" });
        assert.deepEqual(current.prepare("PRAGMA foreign_key_check").all(), []);
        if (enabled) {
          current.exec("UPDATE directory_grants SET terminalApprovalMode='full-access' WHERE id='existing'");
          assert.deepEqual(runDesktopMigrations(options).applied, []);
          assert.deepEqual({ ...current.prepare("SELECT terminalEnabled,terminalApprovalMode FROM directory_grants WHERE id='existing'").get() }, { terminalEnabled: 1, terminalApprovalMode: "full-access" });
        }
      } finally { current.close(); }
    } finally {
      if (resolve(dirname(root)) !== resolve(tmpdir()) || !basename(root).startsWith("ria-terminal-migration-")) throw new Error("Unexpected terminal test directory");
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("approval moves from folders onto conversations and tasks: what ran without asking keeps doing so, and the terminal switch goes", () => {
  const root = mkdtempSync(join(tmpdir(), "ria-terminal-migration-"));
  try {
    const databaseFile = join(root, "app.db"), migrationsDirectory = resolve("src/db/migrations");
    const options = { databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger: { info() {}, warn() {}, error() {} } };
    runDesktopMigrations({ ...options, upToMigration: LAST_WITH_SWITCH });
    const before = new DatabaseSync(databaseFile);
    try {
      const grant = before.prepare("INSERT INTO directory_grants (id,label,path,realPath,updatedAt,terminalEnabled,terminalApprovalMode) VALUES (?,?,?,?,CURRENT_TIMESTAMP,?,?)");
      grant.run("full", "Full", "fixture/full", "fixture/full", 1, "full-access");
      grant.run("asks", "Asks", "fixture/asks", "fixture/asks", 1, "approval");
      grant.run("off", "Off", "fixture/off", "fixture/off", 0, "approval");
      const chat = before.prepare("INSERT INTO chats (id,title,workspaceGrantId,updatedAt) VALUES (?,?,?,CURRENT_TIMESTAMP)");
      chat.run("in-full", "In full", "full"); chat.run("in-asks", "In asks", "asks"); chat.run("in-off", "In off", "off"); chat.run("no-folder", "None", null);
      before.prepare("INSERT INTO scheduled_jobs (id,kind,title,prompt,timeZone,nextRunAt,updatedAt,workspaceGrantId) VALUES ('task-full','prompt','T','p','UTC',0,0,'full')").run();
    } finally { before.close(); }
    assert.deepEqual(runDesktopMigrations({ ...options, upToMigration: "20261114100000_approval_rules" }).applied, ["20261114100000_approval_rules"]);
    const after = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      assert.deepEqual(after.prepare("SELECT id, approvalRule FROM chats ORDER BY id").all().map(row => ({ ...row })), [
        { id: "in-asks", approvalRule: "ask" }, { id: "in-full", approvalRule: "full" }, { id: "in-off", approvalRule: "ask" }, { id: "no-folder", approvalRule: "ask" },
      ]);
      assert.equal(after.prepare("SELECT approvalRule FROM scheduled_jobs WHERE id = 'task-full'").get().approvalRule, "full");
      const columns = after.prepare("PRAGMA table_info(directory_grants)").all().map(column => column.name);
      assert.equal(columns.includes("terminalEnabled") || columns.includes("terminalApprovalMode"), false);
      assert.equal(after.prepare("SELECT count(*) AS count FROM directory_grants").get().count, 3, "every folder stays granted");
      assert.equal(after.prepare("SELECT count(*) AS count FROM approval_preferences").get().count, 0, "the default rule is ask until changed");
      assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { after.close(); }
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !basename(root).startsWith("ria-terminal-migration-")) throw new Error("Unexpected terminal test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
