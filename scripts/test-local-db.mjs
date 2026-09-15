import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inheritedDatabaseFile = process.env.LOCAL_DATABASE_FILE?.trim();
let temporaryDirectory = null;

// Keep local database verification away from the development workspace by
// default. CI can still provide its own isolated path through the environment.
const databaseFile = inheritedDatabaseFile || (() => {
  mkdirSync(join(repositoryRoot, ".desktop-data"), { recursive: true });
  temporaryDirectory = mkdtempSync(join(repositoryRoot, ".desktop-data", "test-db-"));
  return join(temporaryDirectory, "app.db");
})();

const child = spawn(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "run-with-local-db.mjs"),
    "--migrate",
    "node",
    "scripts/verify-local-database.mjs",
  ],
  {
    cwd: repositoryRoot,
    env: { ...process.env, LOCAL_DATABASE_FILE: databaseFile },
    stdio: "inherit",
  },
);

function cleanup() {
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("error", (error) => {
  cleanup();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  cleanup();
  process.exitCode = signal ? 1 : code ?? 1;
});
