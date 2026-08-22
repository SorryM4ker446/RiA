import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDatabaseFile = ".desktop-data/dev/app.db";
const schemaPath = resolve(repositoryRoot, "src/db/schema.prisma");

const input = process.argv.slice(2);
const shouldMigrate = input[0] === "--migrate";
if (shouldMigrate) input.shift();

const command = input.shift();
if (!command) {
  console.error("Usage: node scripts/run-with-local-db.mjs [--migrate] <next|prisma|node> [...args]");
  process.exit(1);
}

const configuredDatabaseFile = process.env.LOCAL_DATABASE_FILE?.trim() || defaultDatabaseFile;
const databasePath = isAbsolute(configuredDatabaseFile)
  ? configuredDatabaseFile
  : resolve(repositoryRoot, configuredDatabaseFile);

mkdirSync(dirname(databasePath), { recursive: true });
closeSync(openSync(databasePath, "a"));

const childEnvironment = {
  ...process.env,
  APP_RUNTIME: process.env.APP_RUNTIME?.trim() || "web",
  AUTH_DISABLED: process.env.AUTH_DISABLED?.trim() || "1",
  DATABASE_URL: `file:${databasePath.replaceAll("\\", "/")}`,
};

function resolveNodeCommand(name, args) {
  if (name === "node") return [process.execPath, args];
  if (name === "next") return [process.execPath, [require.resolve("next/dist/bin/next"), ...args]];
  if (name === "prisma") return [process.execPath, [require.resolve("prisma/build/index.js"), ...args]];
  throw new Error(`Unsupported local runtime command: ${name}`);
}

function deployMigrations() {
  const [executable, args] = resolveNodeCommand("prisma", [
    "migrate",
    "deploy",
    "--schema",
    schemaPath,
  ]);
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    env: childEnvironment,
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (shouldMigrate) deployMigrations();

const [executable, args] = resolveNodeCommand(command, input);
const child = spawn(executable, args, {
  cwd: repositoryRoot,
  env: childEnvironment,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
