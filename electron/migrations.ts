import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DesktopLogger } from "./logger";

type MigrationRecord = { name: string };

function listMigrationNames(migrationsDirectory: string): string[] {
  return readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(migrationsDirectory, entry.name, "migration.sql")))
    .map((entry) => entry.name)
    .sort();
}

function tableExists(database: DatabaseSync, tableName: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name?: string } | undefined;
  return row?.name === tableName;
}

function wasAppliedByPrisma(database: DatabaseSync, migrationName: string): boolean {
  if (!tableExists(database, "_prisma_migrations")) return false;
  const row = database
    .prepare(
      'SELECT migration_name FROM "_prisma_migrations" WHERE migration_name = ? AND finished_at IS NOT NULL AND rolled_back_at IS NULL',
    )
    .get(migrationName) as { migration_name?: string } | undefined;
  return row?.migration_name === migrationName;
}

function createBackup(databaseFile: string, backupsDirectory: string): string | null {
  if (!existsSync(databaseFile) || statSync(databaseFile).size === 0) return null;
  mkdirSync(backupsDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const backupFile = join(backupsDirectory, `${basename(databaseFile)}.${timestamp}.bak`);
  copyFileSync(databaseFile, backupFile);
  return backupFile;
}

export function runDesktopMigrations(input: {
  databaseFile: string;
  migrationsDirectory: string;
  backupsDirectory: string;
  logger: DesktopLogger;
}): { applied: string[]; backupFile: string | null } {
  mkdirSync(dirname(input.databaseFile), { recursive: true });
  const migrationNames = listMigrationNames(input.migrationsDirectory);
  const database = new DatabaseSync(input.databaseFile);
  let backupFile: string | null = null;
  const applied: string[] = [];

  try {
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec("PRAGMA busy_timeout = 5000;");
    database.exec(`
      CREATE TABLE IF NOT EXISTS "desktop_migrations" (
        "name" TEXT NOT NULL PRIMARY KEY,
        "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const known = new Set(
      (database.prepare('SELECT "name" FROM "desktop_migrations"').all() as MigrationRecord[]).map(
        (record) => record.name,
      ),
    );

    for (const migrationName of migrationNames) {
      if (known.has(migrationName)) continue;

      if (wasAppliedByPrisma(database, migrationName)) {
        database.prepare('INSERT INTO "desktop_migrations" ("name") VALUES (?)').run(migrationName);
        known.add(migrationName);
        continue;
      }

      if (!backupFile && tableExists(database, "users")) {
        backupFile = createBackup(input.databaseFile, input.backupsDirectory);
        if (backupFile) input.logger.info("Created database backup before migration", { backupFile });
      }

      const sql = readFileSync(join(input.migrationsDirectory, migrationName, "migration.sql"), "utf8");
      database.exec("BEGIN IMMEDIATE;");
      try {
        database.exec(sql);
        database.prepare('INSERT INTO "desktop_migrations" ("name") VALUES (?)').run(migrationName);
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }

      known.add(migrationName);
      applied.push(migrationName);
      input.logger.info("Applied desktop database migration", { migrationName });
    }

    const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    if (integrity?.integrity_check !== "ok") {
      throw new Error(`SQLite integrity check failed: ${integrity?.integrity_check || "unknown result"}`);
    }

    return { applied, backupFile };
  } finally {
    database.close();
  }
}
