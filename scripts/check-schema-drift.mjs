/**
 * Fails when `src/db/schema.prisma` and the migration chain disagree.
 *
 * The Prisma client is generated from the schema, not from the database, so a
 * column added to one and not the other still type-checks: the client believes
 * it exists, and the error only appears where a query reads it. Nothing else in
 * this repository compares the two, and the migration tests only reach the
 * tables they were written for.
 *
 * The check builds a database by applying every migration, then asks Prisma for
 * the statements that would bring that database back in line with the schema.
 * The database is built rather than the schema trusted, because the question is
 * what an installation actually ends up with.
 *
 * Full-text search is the deliberate exception. `chat_title_search` and
 * `message_text_search` are FTS5 virtual tables, and the shadow tables SQLite
 * builds for them, and no Prisma model describes any of them — they are created
 * and maintained by hand. They are found by reading the migrations for
 * `CREATE VIRTUAL TABLE` rather than by listing them here, so a new one needs no
 * change to this file. Everything else in the diff is drift.
 */
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = join(repositoryRoot, "src", "db", "migrations");
const schemaFile = join(repositoryRoot, "src", "db", "schema.prisma");

const migrationNames = readdirSync(migrationsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(migrationsDirectory, entry.name, "migration.sql")))
  .map((entry) => entry.name)
  .sort();

const virtualTables = new Set();
for (const name of migrationNames) {
  const sql = readFileSync(join(migrationsDirectory, name, "migration.sql"), "utf8");
  for (const match of sql.matchAll(/CREATE\s+VIRTUAL\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi)) {
    virtualTables.add(match[1]);
  }
}

/** True for an object no Prisma model describes, and so never a drift signal. */
function isHandMaintained(name) {
  return [...virtualTables].some((virtual) => name === virtual || name.startsWith(`${virtual}_`));
}

// A scratch database, never the workspace in .desktop-data/. Each process owns
// its directory outside ESLint's repository traversal.
const scratchDirectory = mkdtempSync(join(tmpdir(), "ria-schema-check-"));
const databaseFile = join(scratchDirectory, "drift.db");

/**
 * `process.exit()` inside the try would skip the cleanup below, and the run that
 * reports drift is exactly the run a developer is most likely to trigger — so
 * the failure would leave the scratch database behind every time. The exit code
 * is set instead, and the process ends normally.
 */
let exitCode = 0;

try {
  const database = new DatabaseSync(databaseFile);
  try {
    for (const name of migrationNames) {
      database.exec(readFileSync(join(migrationsDirectory, name, "migration.sql"), "utf8"));
    }
  } finally {
    database.close();
  }

  // `--from-url` rather than `--from-schema-datasource`: the latter takes the
  // url from schema.prisma, which is env("DATABASE_URL"), and Prisma loads
  // .env — so it can quietly diff the workspace's real database instead of the
  // scratch one. Passing the url as an argument cannot be redirected.
  const diff = spawnSync(
    process.execPath,
    [
      join(repositoryRoot, "node_modules", "prisma", "build", "index.js"),
      "migrate", "diff",
      "--from-url", `file:${databaseFile.replaceAll("\\", "/")}`,
      "--to-schema-datamodel", schemaFile,
      "--script",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  if (diff.status !== 0) {
    process.stderr.write(diff.stderr || diff.stdout || "");
    console.error("schema: could not compare the schema with the migrated database");
    exitCode = 1;
  } else {
    // The script is a list of statements, each preceded by a comment naming the
    // operation. Only the object name matters here; the operation itself is
    // reported as-is so a real difference is readable.
    const drift = [];
    for (const block of diff.stdout.split(/^-- /m).slice(1)) {
      const name = block.match(/(?:CREATE|DROP|ALTER)\s+(?:TABLE|INDEX)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i)?.[1];
      if (name && !isHandMaintained(name)) drift.push(`-- ${block.trim()}\n`);
    }

    if (drift.length > 0) {
      console.error("schema: the migration chain and src/db/schema.prisma disagree.");
      console.error("Every statement below would change a database the migrations built.");
      console.error("Add the migration that makes the change, or fix the schema. Do not edit this script.\n");
      process.stderr.write(drift.join("\n"));
      exitCode = 1;
    } else {
      const ignored = virtualTables.size > 0
        ? ` (ignoring ${virtualTables.size} full-text virtual table${virtualTables.size === 1 ? "" : "s"} and their shadow tables)`
        : "";
      console.log(`schema: the ${migrationNames.length} migrations and src/db/schema.prisma agree${ignored}.`);
    }
  }
} finally {
  if (dirname(scratchDirectory) !== resolve(tmpdir()) || !basename(scratchDirectory).startsWith("ria-schema-check-")) {
    throw new Error("Refusing to remove an unexpected schema-check directory");
  }
  rmSync(scratchDirectory, { recursive: true, force: true });
}

process.exitCode = exitCode;
