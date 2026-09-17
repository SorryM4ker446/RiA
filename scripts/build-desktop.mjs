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

// The migrator loads its runtime from electron-dist, so the Electron compile
// must exist before the first migration runs on a clean checkout.
runNode(["node_modules/typescript/bin/tsc", "-p", "electron/tsconfig.json"]);
runNode(
  ["scripts/run-with-local-db.mjs", "--migrate", "next", "build"],
  {
    APP_RUNTIME: "desktop",
    DESKTOP_BUILD: "1",
    LOCAL_DATABASE_FILE: ".desktop-data/build/app.db",
  },
);
runNode(["scripts/prepare-desktop.mjs"]);
runNode(["scripts/verify-desktop-package.mjs", "--runtime-only"]);
