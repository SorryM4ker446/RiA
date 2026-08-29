import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runNode(args, extraEnvironment = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...extraEnvironment },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

runNode(
  ["scripts/run-with-local-db.mjs", "--migrate", "next", "build"],
  {
    APP_RUNTIME: "desktop",
    AUTH_DISABLED: "1",
    DESKTOP_BUILD: "1",
    LOCAL_DATABASE_FILE: ".desktop-data/build/app.db",
  },
);
runNode(["node_modules/typescript/bin/tsc", "-p", "electron/tsconfig.json"]);
runNode(["scripts/prepare-desktop.mjs"]);
runNode(["scripts/verify-desktop-package.mjs"]);
