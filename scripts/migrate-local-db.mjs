import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Applies pending migrations to the local database.
 *
 * The desktop application and browser development share this migrator so a
 * database never has two different ideas about which migrations it received.
 * It backs the database up before changing it and verifies the result.
 */

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error("DATABASE_URL is not set; run this script through scripts/run-with-local-db.mjs.");
  process.exit(1);
}
const databaseFile = databaseUrl.startsWith("file:") ? databaseUrl.slice("file:".length) : databaseUrl;

let runDesktopMigrations;
try {
  ({ runDesktopMigrations } = require(resolve(repositoryRoot, "electron-dist", "migrations.js")));
} catch (error) {
  console.error(
    `找不到桌面迁移运行时，请先执行 npm run desktop:compile。(${error instanceof Error ? error.message : String(error)})`,
  );
  process.exit(1);
}

try {
  const result = runDesktopMigrations({
    databaseFile,
    migrationsDirectory: resolve(repositoryRoot, "src", "db", "migrations"),
    backupsDirectory: process.env.LOCAL_BACKUPS_DIRECTORY?.trim() || resolve(dirname(databaseFile), "backups"),
    logger: {
      info: (message, details) => console.log(details ? `${message} ${JSON.stringify(details)}` : message),
      warn: (message, details) => console.warn(details ? `${message} ${JSON.stringify(details)}` : message),
      error: (message, details) => console.error(details ? `${message} ${JSON.stringify(details)}` : message),
    },
  });
  if (result.backupFile) console.log(`迁移前备份：${result.backupFile}`);
  console.log(result.applied.length > 0 ? `已应用迁移：${result.applied.join(", ")}` : "数据库已是最新状态。");
} catch (error) {
  console.error(`迁移失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
