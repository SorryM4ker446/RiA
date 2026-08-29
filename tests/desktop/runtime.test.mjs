import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
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
    assert.equal(first.applied.length, 1);

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
