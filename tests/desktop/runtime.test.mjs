import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { resolveDesktopPaths, toSqliteUrl } = require("../../electron-dist/paths.js");
const { runDesktopMigrations } = require("../../electron-dist/migrations.js");
const logger = { info() {}, warn() {}, error() {} };

test("desktop paths keep packaged data under Electron userData", () => {
  const root = join(tmpdir(), `private-ai-paths-${process.pid}-${Date.now()}`);
  try {
    const paths = resolveDesktopPaths({
      isPackaged: true,
      resourcesPath: join(root, "resources"),
      userDataPath: join(root, "user-data"),
      compiledDirectory: join(root, "app", "electron-dist"),
    });
    assert.equal(paths.databaseFile, join(root, "user-data", "data", "app.db"));
    assert.equal(paths.runtimeDirectory, join(root, "resources", ".desktop-runtime"));
    assert.equal(toSqliteUrl(paths.databaseFile), `file:${paths.databaseFile.replaceAll("\\", "/")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop migrations initialize SQLite once and preserve data", () => {
  const root = join(tmpdir(), `private-ai-migrations-${process.pid}-${Date.now()}`);
  const databaseFile = join(root, "data", "app.db");
  const backupsDirectory = join(root, "backups");
  try {
    const first = runDesktopMigrations({
      databaseFile,
      migrationsDirectory: join(repositoryRoot, "src", "db", "migrations"),
      backupsDirectory,
      logger,
    });
    const migrationCount = readdirSync(join(repositoryRoot, "src", "db", "migrations"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).length;
    assert.equal(first.applied.length, migrationCount);

    const database = new DatabaseSync(databaseFile);
    database.prepare('INSERT INTO "users" ("id", "email", "updatedAt") VALUES (?, ?, ?)').run(
      "desktop-test-user",
      "desktop-test@example.invalid",
      new Date().toISOString(),
    );
    database.close();

    const second = runDesktopMigrations({
      databaseFile,
      migrationsDirectory: join(repositoryRoot, "src", "db", "migrations"),
      backupsDirectory,
      logger,
    });
    assert.deepEqual(second.applied, []);

    const reopened = new DatabaseSync(databaseFile);
    const row = reopened.prepare('SELECT "email" FROM "users" WHERE "id" = ?').get("desktop-test-user");
    reopened.close();
    assert.equal(row.email, "desktop-test@example.invalid");
    assert.equal(existsSync(databaseFile), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("memory uniqueness migration preserves duplicates, resolves key collisions and creates a backup", () => {
  const root = mkdtempSync(join(tmpdir(), "private-ai-upgrade-"));
  const databaseFile = join(root, "app.db");
  const migrationsDirectory = join(repositoryRoot, "src", "db", "migrations");
  const initialMigration = "20260822113000_init_local_database";
  try {
    const database = new DatabaseSync(databaseFile);
    database.exec(readFileSync(join(migrationsDirectory, initialMigration, "migration.sql"), "utf8"));
    database.exec('CREATE TABLE "desktop_migrations" ("name" TEXT PRIMARY KEY, "appliedAt" DATETIME DEFAULT CURRENT_TIMESTAMP)');
    database.prepare('INSERT INTO "desktop_migrations" ("name") VALUES (?)').run(initialMigration);
    for (const id of ["one", "two"]) {
      database.prepare('INSERT INTO "users" ("id", "email", "updatedAt") VALUES (?, ?, ?)').run(id, `${id}@example.invalid`, "2026-08-30T00:00:00Z");
    }
    const insert = database.prepare('INSERT INTO "memories" ("id", "userId", "key", "value", "updatedAt") VALUES (?, ?, ?, ?, ?)');
    insert.run("old", "one", "preference", "older value", "2026-08-29T00:00:00Z");
    insert.run("new", "one", "preference", "newer value", "2026-08-30T00:00:00Z");
    insert.run("collision", "one", "preference [duplicate:old]", "existing suffix", "2026-08-30T00:00:00Z");
    insert.run("other", "two", "preference", "other user value", "2026-08-30T00:00:00Z");
    database.close();

    const result = runDesktopMigrations({ databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger });
    assert.equal(result.applied.length, 1);
    assert.ok(result.backupFile && existsSync(result.backupFile));
    const upgraded = new DatabaseSync(databaseFile);
    try {
      const rows = upgraded.prepare('SELECT "id", "key", "value" FROM "memories" ORDER BY "id"').all();
      assert.equal(rows.length, 4);
      assert.equal(rows.find((row) => row.id === "old").key, "preference [duplicate:old]_");
      assert.equal(rows.find((row) => row.id === "old").value, "older value");
      assert.equal(rows.find((row) => row.id === "new").key, "preference");
      assert.equal(rows.find((row) => row.id === "other").key, "preference");
      assert.throws(() => upgraded.prepare('INSERT INTO "memories" ("id", "userId", "key", "value", "updatedAt") VALUES (?, ?, ?, ?, ?)')
        .run("duplicate", "one", "preference", "must fail", "2026-08-30T00:00:00Z"), /UNIQUE constraint/);
    } finally {
      upgraded.close();
    }
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir())) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
