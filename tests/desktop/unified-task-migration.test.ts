import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { runDesktopMigrations } = require("../../electron-dist/migrations.js");
const migrationsDirectory = resolve("src/db/migrations");
const BEFORE = "20261105160000_memory_resumed";

test("to-dos and the four schedule kinds become tasks without anything starting on its own", () => {
  const root = mkdtempSync(join(tmpdir(), "ria-unified-tasks-"));
  const databaseFile = join(root, "app.db");
  const options = { databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger: { info() {}, warn() {}, error() {} } };
  try {
    runDesktopMigrations({ ...options, upToMigration: BEFORE });
    const before = new DatabaseSync(databaseFile);
    try {
      const now = Date.now();
      const job = before.prepare(`INSERT INTO scheduled_jobs (id,kind,enabled,useModel,localTime,timeZone,interval,dayOfWeek,nextRunAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)`);
      job.run("backup", "scheduledBackup", 1, 0, "08:05", "Asia/Shanghai", "daily", null, now, now);
      job.run("brief", "dailyBrief", 1, 1, "09:00", "UTC", "daily", null, now, now);
      job.run("summary", "weeklySummary", 0, 0, "18:30", "UTC", "weekly", 5, now, now);
      job.run("reminder", "backupReminder", 1, 0, "07:00", "UTC", "weekly", null, now, now);
      before.prepare("INSERT INTO app_notices (id,kind,title,fingerprint,updatedAt) VALUES ('old','backupReminder','backup-due','backup-reminder',?)").run(now);
      const todo = before.prepare("INSERT INTO tasks (id,title,details,dueDate,timeZone,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)");
      todo.run("open", "Write report", "Two pages", 1893456000000, "Asia/Shanghai", "todo", now, now);
      todo.run("plain", "No deadline", null, null, "UTC", "in_progress", now, now);
      todo.run("finished", "Already done", null, null, "UTC", "done", now, now);
    } finally { before.close(); }

    const upgrade = runDesktopMigrations({ ...options, upToMigration: "20261110100000_unified_tasks" });
    assert.deepEqual(upgrade.applied, ["20261110100000_unified_tasks"]);
    assert.ok(upgrade.backupFile, "the database is backed up before the to-dos are dropped");
    const backup = new DatabaseSync(upgrade.backupFile, { readOnly: true });
    try { assert.equal(backup.prepare("SELECT count(*) AS count FROM tasks").get().count, 3, "the backup still holds every to-do"); } finally { backup.close(); }

    const after = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      assert.equal(after.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get(), undefined);
      const rows = Object.fromEntries(after.prepare("SELECT id,kind,title,prompt,enabled,cron,timeZone,chatId,nextRunAt FROM scheduled_jobs").all().map(row => [row.id, { ...row }]));
      assert.deepEqual([rows.backup.kind, rows.backup.cron, rows.backup.enabled, rows.backup.prompt], ["scheduledBackup", "5 8 * * *", 1, null]);
      assert.deepEqual([rows.reminder.kind, rows.reminder.cron], ["backupReminder", "0 7 * * *"], "a weekly row without a weekday runs daily, as it did");
      assert.deepEqual([rows.brief.kind, rows.brief.cron, rows.brief.enabled], ["prompt", "0 9 * * *", 0], "the brief now calls a model, so it waits for the user to switch it on");
      assert.match(rows.brief.prompt, /readWorkspaceActivity/);
      assert.deepEqual([rows.summary.kind, rows.summary.cron, rows.summary.enabled], ["prompt", "30 18 * * 5", 0]);
      assert.deepEqual([rows.open.kind, rows.open.enabled, rows.open.cron, rows.open.timeZone, rows.open.nextRunAt], ["prompt", 0, null, "Asia/Shanghai", 1893456000000]);
      assert.equal(rows.open.prompt, "Write report\n\nTwo pages");
      assert.deepEqual([rows.plain.enabled, rows.plain.prompt], [0, "No deadline"]);
      assert.equal(rows.finished, undefined, "finished to-dos are not carried over");
      assert.equal(Object.values(rows).every((row: Record<string, unknown>) => row.chatId === null && Boolean(row.title)), true);
      const columns = after.prepare("PRAGMA table_info(scheduled_jobs)").all().map(column => column.name);
      for (const gone of ["localTime", "interval", "dayOfWeek", "useModel"]) assert.equal(columns.includes(gone), false);
      assert.ok(after.prepare("SELECT notifiedAt FROM app_notices WHERE id='old'").get().notifiedAt, "an existing notice is not announced as new");
    } finally { after.close(); }
    assert.deepEqual(runDesktopMigrations({ ...options, upToMigration: "20261110100000_unified_tasks" }).applied, []);
    // The next migration keeps every converted task catching up, as it did before it had the choice.
    assert.deepEqual(runDesktopMigrations({ ...options, upToMigration: "20261112100000_task_templates" }).applied, ["20261111100000_task_missed_runs", "20261112100000_task_templates"]);
    const later = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      assert.deepEqual(later.prepare("SELECT DISTINCT catchUp FROM scheduled_jobs").all().map(row => ({ ...row })), [{ catchUp: 1 }]);
      // The carried-over brief and summary follow their templates from now on, in whatever language the interface is in.
      assert.deepEqual(later.prepare("SELECT id, template, title, prompt FROM scheduled_jobs WHERE template IS NOT NULL ORDER BY id").all().map(row => ({ ...row })), [
        { id: "brief", template: "dailyBrief", title: "", prompt: null },
        { id: "summary", template: "weeklySummary", title: "", prompt: null },
      ]);
      assert.equal(later.prepare("SELECT prompt FROM scheduled_jobs WHERE id = 'open'").get().prompt, "Write report\n\nTwo pages", "a task the user wrote keeps its words");
    } finally { later.close(); }

    // A task's conversation as an earlier build could leave it: a folder chosen in it and a template applied to it.
    const linked = new DatabaseSync(databaseFile);
    try {
      const now = Date.now();
      linked.prepare("INSERT INTO directory_grants (id,label,path,realPath,updatedAt) VALUES ('grant','Notes','fixture/notes','fixture/notes',?)").run(now);
      const chat = linked.prepare("INSERT INTO chats (id,title,workspaceGrantId,assistantConfig,updatedAt) VALUES (?,?,?,?,?)");
      chat.run("task-chat", "Brief", "grant", JSON.stringify({ templateId: "builtin_writing" }), now);
      chat.run("plain-chat", "Mine", "grant", JSON.stringify({ templateId: "builtin_writing" }), now);
      linked.prepare("UPDATE scheduled_jobs SET chatId = 'task-chat' WHERE id = 'brief'").run();
    } finally { linked.close(); }
    assert.deepEqual(runDesktopMigrations({ ...options, upToMigration: "20261113100000_task_model_folder" }).applied, ["20261113100000_task_model_folder"]);
    const owned = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      // The folder moves onto the task, which now owns it; the template comes off the task's conversation only.
      assert.deepEqual({ ...owned.prepare("SELECT workspaceGrantId, modelProvider, modelId FROM scheduled_jobs WHERE id = 'brief'").get() }, { workspaceGrantId: "grant", modelProvider: null, modelId: null });
      assert.equal(owned.prepare("SELECT count(*) AS count FROM scheduled_jobs WHERE workspaceGrantId IS NOT NULL").get().count, 1);
      assert.deepEqual(owned.prepare("SELECT id, workspaceGrantId, assistantConfig IS NULL AS cleared FROM chats ORDER BY id").all().map(row => ({ ...row })), [
        { id: "plain-chat", workspaceGrantId: "grant", cleared: 0 },
        { id: "task-chat", workspaceGrantId: null, cleared: 1 },
      ]);
    } finally { owned.close(); }

    // The task table is rebuilt so a task may have no next time; nothing is lost on the way.
    const prepared = new DatabaseSync(databaseFile);
    try {
      prepared.prepare("UPDATE chats SET ephemeral = 0 WHERE id = 'task-chat'").run();
      prepared.prepare("INSERT INTO scheduled_runs (id,jobId,kind,trigger,requestId,status,startedAt) VALUES ('run','brief','prompt','manual','request','succeeded',?)").run(Date.now());
    } finally { prepared.close(); }
    const jobsBefore = (() => { const view = new DatabaseSync(databaseFile, { readOnly: true }); try { return view.prepare("SELECT id, kind, title, cron, nextRunAt, chatId, workspaceGrantId FROM scheduled_jobs ORDER BY id").all().map(row => ({ ...row })); } finally { view.close(); } })();
    assert.deepEqual(runDesktopMigrations(options).applied, ["20261114100000_approval_rules", "20261115100000_task_settings"]);
    const rebuilt = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      assert.deepEqual(rebuilt.prepare("SELECT id, kind, title, cron, nextRunAt, chatId, workspaceGrantId FROM scheduled_jobs ORDER BY id").all().map(row => ({ ...row })), jobsBefore);
      // A conversation that already had memory on keeps it on through its task; every other task starts with it off.
      assert.deepEqual(rebuilt.prepare("SELECT id, usesMemory, notify, reasoningEffort FROM scheduled_jobs WHERE usesMemory = 1 OR notify != 'all' OR reasoningEffort IS NOT NULL").all().map(row => ({ ...row })), [
        { id: "brief", usesMemory: 1, notify: "all", reasoningEffort: null },
      ]);
      assert.equal(rebuilt.prepare("SELECT jobId FROM scheduled_runs WHERE id = 'run'").get().jobId, "brief", "a run still points at its task");
      const nextRunAt = rebuilt.prepare("PRAGMA table_info(scheduled_jobs)").all().find(column => column.name === "nextRunAt");
      assert.equal(nextRunAt.notnull, 0);
      assert.deepEqual(rebuilt.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { rebuilt.close(); }
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "ria-unified-tasks-"))) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
