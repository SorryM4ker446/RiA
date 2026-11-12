import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const { runDesktopMigrations } = require("../../electron-dist/migrations.js");

const settingsWith = (maxConcurrent: number, backgroundDailyCalls: number) => JSON.stringify({
  version: 3, defaultMode: "chat",
  callLimits: { maxConcurrent, backgroundDailyCalls, compactionCallsPerTurn: 20, backgroundMaxEstimatedUsd: null, backgroundDailyEstimatedUsd: null, timeZone: "UTC" },
});

for (const [label, stored, expected] of [
  ["still at the earlier defaults move to the new ones", [4, 20], [8, 1000]],
  ["chosen by the user are kept", [3, 50], [3, 50]],
] as const) {
  test(`call limits ${label}`, () => {
    const root = mkdtempSync(join(tmpdir(), "ria-call-limit-migration-"));
    try {
      const databaseFile = join(root, "app.db"), migrationsDirectory = resolve("src/db/migrations"), migration = "20261118100000_call_limit_defaults";
      const old = new DatabaseSync(databaseFile);
      try {
        old.exec("CREATE TABLE desktop_migrations (name TEXT PRIMARY KEY, appliedAt DATETIME DEFAULT CURRENT_TIMESTAMP)");
        for (const name of readdirSync(migrationsDirectory).filter(name => /^\d/.test(name) && name < migration).sort()) {
          old.exec(readFileSync(join(migrationsDirectory, name, "migration.sql"), "utf8"));
          old.prepare("INSERT INTO desktop_migrations (name) VALUES (?)").run(name);
        }
        old.prepare("INSERT OR REPLACE INTO account_preferences (id, settings, updatedAt) VALUES ('local', ?, CURRENT_TIMESTAMP)").run(settingsWith(stored[0], stored[1]));
      } finally { old.close(); }
      const options = { databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger: { info() {}, warn() {}, error() {} } };
      assert.ok(runDesktopMigrations(options).applied.includes(migration));
      const current = new DatabaseSync(databaseFile);
      try {
        const settings = JSON.parse(String((current.prepare("SELECT settings FROM account_preferences WHERE id = 'local'").get() as { settings: string }).settings));
        assert.deepEqual([settings.callLimits.maxConcurrent, settings.callLimits.backgroundDailyCalls], expected);
        // Nothing else in the settings changes.
        assert.equal(settings.callLimits.timeZone, "UTC");
        assert.equal(settings.defaultMode, "chat");
      } finally { current.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
