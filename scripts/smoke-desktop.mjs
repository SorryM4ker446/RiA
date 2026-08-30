import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveInstalledElectron } from "./resolve-installed-electron.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).version;
const development = process.argv.includes("--development");
const installed = process.argv.includes("--installed");
const packaged = installed || process.argv.includes("--packaged");
const forceStandalone = !development && !packaged;
const electronExecutable = installed
  ? join(process.env.LOCALAPPDATA || "", "PrivateAIAssistant", `app-${packageVersion}`, "Private AI Assistant.exe")
  : packaged
    ? join(repositoryRoot, "out", "Private AI Assistant-win32-x64", "Private AI Assistant.exe")
    : resolveInstalledElectron();
const testRoot = join(repositoryRoot, ".desktop-data", "test", `electron-smoke-${process.pid}-${Date.now()}`);
const expectedParent = resolve(repositoryRoot, ".desktop-data", "test");

if (!existsSync(join(repositoryRoot, ".desktop-runtime", "server.js"))) {
  throw new Error("Desktop runtime is missing. Run npm run desktop:build first.");
}
if (!existsSync(electronExecutable)) {
  throw new Error(`Desktop executable is missing: ${electronExecutable}`);
}

const child = spawn(
  electronExecutable,
  packaged ? [] : [join(repositoryRoot, "electron-dist", "main.js")],
  {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    ...(forceStandalone ? { DESKTOP_FORCE_PACKAGED: "1" } : {}),
    DESKTOP_SMOKE_TEST: "1",
    DESKTOP_PROJECT_ROOT: repositoryRoot,
    ...(forceStandalone ? { DESKTOP_RUNTIME_DIR: join(repositoryRoot, ".desktop-runtime") } : {}),
    ...(development ? { DESKTOP_DATA_DIR: testRoot } : { DESKTOP_USER_DATA_DIR: testRoot }),
  },
  stdio: "inherit",
  windowsHide: true,
  },
);

const timeout = setTimeout(() => {
  child.kill("SIGTERM");
  console.error(`Desktop smoke test timed out. Diagnostics: ${testRoot}`);
  process.exitCode = 1;
}, 120_000);

child.on("error", (error) => {
  clearTimeout(timeout);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
child.on("exit", (code) => {
  clearTimeout(timeout);
  if (code === 0) {
    if (resolve(dirname(testRoot)) !== expectedParent) {
      throw new Error(`Refusing to clean unexpected smoke-test directory: ${testRoot}`);
    }
    rmSync(testRoot, { recursive: true, force: true });
    console.log("Electron desktop smoke test passed.");
    process.exitCode = 0;
  } else {
    console.error(`Desktop smoke test failed with code ${code}. Diagnostics: ${testRoot}`);
    process.exitCode = code ?? 1;
  }
});
