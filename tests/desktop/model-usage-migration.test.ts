import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { test } from "node:test";
import { resolveDesktopPaths } from "../../electron/paths";
const require = createRequire(import.meta.url);
const { runDesktopMigrations } = require("../../electron-dist/migrations.js");
test("a new installation directory retains the workspace and upgrades historical usage without guessing its source", () => {
  const root = mkdtempSync(join(tmpdir(), "ria-usage-upgrade-"));
  try {
    const pathInput = { isPackaged: true, resourcesPath: join(root, "app-old", "resources"), userDataPath: join(root, "user"), compiledDirectory: join(root, "app-old", "electron-dist") };
    const old = resolveDesktopPaths(pathInput);
    const next = resolveDesktopPaths({ ...pathInput, resourcesPath: join(root, "app-new", "resources"), compiledDirectory: join(root, "app-new", "electron-dist") });
    assert.equal(next.databaseFile, old.databaseFile); assert.equal(next.mediaDirectory, old.mediaDirectory); assert.equal(next.settingsFile, old.settingsFile);
    writeFileSync(old.settingsFile, '{"version":1,"encryptedOpenrouterApiKey":"opaque-encrypted-fixture"}');
    writeFileSync(join(old.mediaDirectory, "fixture.bin"), "preserved attachment");
    const options = { databaseFile: old.databaseFile, migrationsDirectory: resolve("src/db/migrations"), backupsDirectory: old.backupsDirectory, logger: { info() {}, warn() {}, error() {} } };
    runDesktopMigrations({ ...options, upToMigration: "20261004150000_summary_history_revision" });
    const before = new DatabaseSync(old.databaseFile);
    before.exec("INSERT INTO model_requests (id,requestId,mode,modelId,status,durationMs,costUsd,costSource) VALUES ('usage','request','chat','fixture','success',10,0.02,'provider')"); before.close();
    const upgraded = runDesktopMigrations(options); assert.ok(upgraded.backupFile);
    const current = new DatabaseSync(next.databaseFile);
    try {
      const row = current.prepare("SELECT source, estimatedUsd, costUsd FROM model_requests").get();
      assert.deepEqual({ ...row }, { source: "unattributed", estimatedUsd: null, costUsd: 0.02 });
      assert.equal(current.prepare("SELECT count(*) AS count FROM model_call_days").get().count, 0);
    } finally { current.close(); }
    assert.equal(readFileSync(next.settingsFile, "utf8"), '{"version":1,"encryptedOpenrouterApiKey":"opaque-encrypted-fixture"}');
    assert.equal(readFileSync(join(next.mediaDirectory, "fixture.bin"), "utf8"), "preserved attachment");
    assert.equal(runDesktopMigrations(options).applied.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
