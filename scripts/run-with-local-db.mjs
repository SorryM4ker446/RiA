import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDatabaseFile = ".desktop-data/dev/app.db";
const migrateScript = resolve(repositoryRoot, "scripts", "migrate-local-db.mjs");

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

/**
 * The access credential is handed to the service through a file beside the
 * database. An environment variable cannot be used: the server bundle is built
 * before the service starts, so a value provided at start-up never reaches it.
 * Only a launcher that asks for a fixed credential writes this file.
 */
const accessTokenFile = join(dirname(databasePath), ".local-access-token");
const requestedToken = process.env.LOCAL_ACCESS_TOKEN?.trim();
if (requestedToken && /^[a-f0-9]{32,128}$/.test(requestedToken)) {
  writeFileSync(accessTokenFile, `${requestedToken}\n`, { encoding: "utf8", mode: 0o600 });
} else {
  rmSync(accessTokenFile, { force: true });
}

const childEnvironment = {
  ...process.env,
  APP_RUNTIME: process.env.APP_RUNTIME?.trim() || "web",
  DATABASE_URL: `file:${databasePath.replaceAll("\\", "/")}`,
};

function resolveNodeCommand(name, args) {
  if (name === "node") return [process.execPath, args];
  if (name === "next") return [process.execPath, [require.resolve("next/dist/bin/next"), ...args]];
  if (name === "prisma") return [process.execPath, [require.resolve("prisma/build/index.js"), ...args]];
  if (name === "migrate") return [process.execPath, [migrateScript, ...args]];
  throw new Error(`Unsupported local runtime command: ${name}`);
}

/**
 * Records the account the workspace adopts and snapshots the database before
 * the account schema is removed. Every runtime converts now, so browser
 * development, tests and the desktop application all take this path and a real
 * database is never rewritten without a snapshot first.
 */
function prepareWorkspaceUpgrade() {
  const result = spawnSync(
    process.execPath,
    ["--import", "./tests/helpers/register-typescript.mjs", "scripts/upgrade-local-workspace.mjs", "--prepare"],
    { cwd: repositoryRoot, env: childEnvironment, stdio: "inherit" },
  );

  if (result.error) throw result.error;
  if (result.status === 0) return;
  // Exit code 2 means the data needs a human decision; the module already
  // explained what to do, so pass that through instead of starting anyway.
  process.exit(result.status ?? 1);
}

function deployMigrations() {
  // Browser development and the desktop application share one migrator, so the
  // two never disagree about which migrations a database has received.
  const [executable, args] = resolveNodeCommand("migrate", []);
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    env: childEnvironment,
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (shouldMigrate) {
  prepareWorkspaceUpgrade();
  deployMigrations();
}

/**
 * Browser development has no login, so the application is opened through a
 * one-time link. The code is generated here and handed to the server process,
 * because only that process can consume it.
 */
let localAccessCode = null;
if (command === "next" && (input[0] === "dev" || input[0] === "start")) {
  localAccessCode = randomBytes(24).toString("hex");
  childEnvironment.LOCAL_HANDSHAKE_CODE = localAccessCode;
}

const [executable, args] = resolveNodeCommand(command, input);
const child = spawn(executable, args, {
  cwd: repositoryRoot,
  env: childEnvironment,
  stdio: "inherit",
});

if (localAccessCode) {
  const port = childEnvironment.PORT?.trim() || process.env.PORT?.trim() || "3000";
  const entryOrigin = childEnvironment.APP_ORIGIN?.trim() || `http://127.0.0.1:${port}`;
  console.log(
      `\n本地工作区入口（无需账户）：${entryOrigin}/api/local-access?handshake=${localAccessCode}\n` +
      "该链接只能使用一次，服务重新启动后需要重新打开。\n",
  );
}

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
