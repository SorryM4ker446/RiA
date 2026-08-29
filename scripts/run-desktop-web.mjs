import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, [
  "scripts/run-with-local-db.mjs",
  "--migrate",
  "next",
  "dev",
  "--webpack",
  "--hostname",
  "127.0.0.1",
  "--port",
  "3110",
], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    APP_RUNTIME: "web",
    AUTH_DISABLED: "1",
    LOCAL_DATABASE_FILE: ".desktop-data/dev/app.db",
  },
  stdio: "inherit",
  windowsHide: true,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
