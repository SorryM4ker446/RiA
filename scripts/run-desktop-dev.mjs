import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronExecutable = require("electron");
const child = spawn(electronExecutable, [join(repositoryRoot, "electron-dist", "main.js")], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    APP_RUNTIME: "desktop",
    AUTH_DISABLED: "1",
    DESKTOP_PROJECT_ROOT: repositoryRoot,
    DESKTOP_NODE_EXECUTABLE: process.execPath,
  },
  stdio: "inherit",
  windowsHide: true,
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
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
