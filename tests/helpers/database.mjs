import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { migrationNames } from "./legacy-workspace.mjs";

/**
 * Isolated local workspace for route tests.
 *
 * Every migration is applied, including the one that removes account scoping,
 * so the schema under test is exactly what a converted installation has.
 */
export function createTestDatabase() {
  const root = mkdtempSync(join(tmpdir(), "private-ai-server-"));
  const databaseFile = join(root, "app.db");
  const migrations = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/db/migrations");
  const sqlite = new DatabaseSync(databaseFile);
  try {
    for (const name of migrationNames()) {
      sqlite.exec(readFileSync(join(migrations, name, "migration.sql"), "utf8"));
    }
  } finally {
    sqlite.close();
  }
  process.env.DATABASE_URL = `file:${databaseFile.replaceAll("\\", "/")}`;
  process.env.MEDIA_DIRECTORY = join(root, "media");
  process.env.LEGACY_VIDEO_DIRECTORY = join(root, "legacy-videos");
  process.env.APP_RUNTIME = "test";
  process.env.APP_ORIGIN = "";
  process.env.OPENROUTER_API_KEY = "";
  process.env.TAVILY_API_KEY = "";
  process.env.OUTBOUND_PROXY_URL = "";
  return () => {
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("private-ai-server-")) {
      throw new Error("Refusing to remove an unexpected test database directory");
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
}
