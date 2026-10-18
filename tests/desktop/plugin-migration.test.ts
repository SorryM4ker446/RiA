import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const { runDesktopMigrations } = require("../../electron-dist/migrations.js");

test("plugin migration preserves standalone connections, backs up the prior schema and is restart-safe", () => {
  const root = mkdtempSync(join(tmpdir(), "ria-plugin-upgrade-"));
  try {
    const databaseFile = join(root, "app.db"), migrationsDirectory = resolve("src/db/migrations"), migration = "20261018120000_plugin_packages";
    const old = new DatabaseSync(databaseFile);
    try {
      old.exec("CREATE TABLE desktop_migrations (name TEXT PRIMARY KEY, appliedAt DATETIME DEFAULT CURRENT_TIMESTAMP)");
      for (const name of readdirSync(migrationsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name < migration).map(entry => entry.name).sort()) {
        old.exec(readFileSync(join(migrationsDirectory, name, "migration.sql"), "utf8"));
        old.prepare("INSERT INTO desktop_migrations (name) VALUES (?)").run(name);
      }
      old.exec(`INSERT INTO extensions(id,name,kind,config,tools,enabled,revision,testedRevision,updatedAt) VALUES ('standalone','Existing','mcp-http','{"type":"mcp-http","url":"http://localhost/mcp"}','[]',1,3,3,CURRENT_TIMESTAMP)`);
    } finally { old.close(); }
    const options = { databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger: { info() {}, warn() {}, error() {} } };
    const result = runDesktopMigrations(options); assert.deepEqual(result.applied, readdirSync(migrationsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name >= migration).map(entry => entry.name).sort()); assert.ok(result.backupFile);
    const backup = new DatabaseSync(result.backupFile, { readOnly: true });
    try { assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='plugin_packages'").get().count, 0); } finally { backup.close(); }
    assert.deepEqual(runDesktopMigrations(options).applied, []);
    const current = new DatabaseSync(databaseFile);
    try {
      current.exec("PRAGMA foreign_keys=ON");
      const row = current.prepare("SELECT name,enabled,revision,testedRevision,pluginId,pluginKey FROM extensions WHERE id='standalone'").get();
      assert.deepEqual({ ...row }, { name: "Existing", enabled: 1, revision: 3, testedRevision: 3, pluginId: null, pluginKey: null });
      current.exec(`INSERT INTO plugin_packages(id,packageId,manifest,digest,updatedAt) VALUES ('package','test.package','{}','digest',CURRENT_TIMESTAMP)`);
      current.exec(`INSERT INTO extensions(id,name,kind,config,tools,pluginId,pluginKey,updatedAt) VALUES ('owned','Owned','http','{}','[]','package','service',CURRENT_TIMESTAMP)`);
      current.exec("DELETE FROM plugin_packages WHERE id='package'");
      assert.equal(current.prepare("SELECT COUNT(*) AS count FROM extensions WHERE id='owned'").get().count, 0);
      assert.equal(current.prepare("SELECT COUNT(*) AS count FROM extensions WHERE id='standalone'").get().count, 1);
      assert.deepEqual(current.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { current.close(); }
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "ria-plugin-upgrade-"))) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
