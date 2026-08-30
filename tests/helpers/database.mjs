import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export function createTestDatabase() {
  const root = mkdtempSync(join(tmpdir(), "private-ai-server-"));
  const databaseFile = join(root, "app.db");
  const migrations = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/db/migrations");
  const sqlite = new DatabaseSync(databaseFile);
  try {
    for (const entry of readdirSync(migrations, { withFileTypes: true }).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      sqlite.exec(readFileSync(join(migrations, entry.name, "migration.sql"), "utf8"));
    }
  } finally {
    sqlite.close();
  }
  process.env.DATABASE_URL = `file:${databaseFile.replaceAll("\\", "/")}`;
  process.env.AUTH_DISABLED = "0";
  process.env.OPENROUTER_API_KEY = "";
  process.env.TAVILY_API_KEY = "";
  process.env.OUTBOUND_PROXY_URL = "";
  return () => {
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("private-ai-server-")) {
      throw new Error("Refusing to remove an unexpected test database directory");
    }
    rmSync(root, { recursive: true, force: true });
  };
}
