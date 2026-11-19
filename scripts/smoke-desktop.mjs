import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveInstalledElectron } from "./resolve-installed-electron.mjs";
import { printDesktopSmokeDiagnostics } from "./smoke-desktop-diagnostics.mjs";
import { scannedPdf, textPdf, wordTableDocument } from "../tests/helpers/document-fixtures.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).version;
const development = process.argv.includes("--development");
const installed = process.argv.includes("--installed");
const packaged = installed || process.argv.includes("--packaged");
const forceStandalone = !development && !packaged;
/*
 * Records a data folder move before the launch, so the application has to run it
 * at start-up, before its workspace upgrade and migrations, and then pass the
 * whole smoke run on the moved data through the junction left at the fixed path.
 */
const dataMove = process.argv.includes("--data-move");
// The same for a cache folder move, which start-up runs after the data is settled.
const cacheMove = process.argv.includes("--cache-move");
if (dataMove && cacheMove) throw new Error("Only one move can wait for a start; choose --data-move or --cache-move");
if (installed && !process.env.DESKTOP_INSTALL_DIR) {
  throw new Error("Set DESKTOP_INSTALL_DIR to the directory chosen in the MSI installer");
}
const electronExecutable = installed
  ? join(process.env.DESKTOP_INSTALL_DIR, `app-${packageVersion}`, "RiA.exe")
  : packaged
    ? join(repositoryRoot, "out", "RiA-win32-x64", "RiA.exe")
    : resolveInstalledElectron();
const testRoot = join(repositoryRoot, ".desktop-data", "test", `electron-smoke-${process.pid}-${Date.now()}`);
const expectedParent = resolve(repositoryRoot, ".desktop-data", "test");
const documentFixtures = JSON.stringify([
  { filename: "support.pdf", data: textPdf().toString("base64"), expected: "Aurora support hours", pageNumber: 1 },
  { filename: "release.docx", data: (await wordTableDocument()).toString("base64"), expected: "| 住宿 | 500 元 | 主管审批 |", pageNumber: null },
  // A scan: its page is read by OCR in the background, in the packaged runtime's own files.
  { filename: "scan.pdf", data: (await scannedPdf([["Aurora warehouse opens on Thursdays."]])).toString("base64"), expected: "Thursdays", pageNumber: 1 },
]);

if (!existsSync(join(repositoryRoot, ".desktop-runtime", "server.js"))) {
  throw new Error("Desktop runtime is missing. Run npm run desktop:build first.");
}
if (!existsSync(electronExecutable)) {
  throw new Error(`Desktop executable is missing: ${electronExecutable}`);
}

// The installed runtime directory is read-only for standard users and must be
// left empty by uninstall, so the service may not write caches beside its code.
const runtimeDirectory = packaged ? join(dirname(electronExecutable), "resources", ".desktop-runtime") : join(repositoryRoot, ".desktop-runtime");
const startedAt = Date.now();
function runtimeCacheWrites() {
  const written = [];
  const visit = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (statSync(path).mtimeMs >= startedAt) written.push(path);
    }
  };
  if (!development) for (const cache of [join(".next", "server", "route-cache"), join(".next", "cache")]) visit(join(runtimeDirectory, cache));
  return written;
}

// Every mode opens its data at <user data>/data, which is testRoot/data here.
const dataRoot = join(testRoot, "data");
const movedData = join(testRoot, "moved-data");
const movedCache = join(testRoot, "moved-cache");
if (dataMove || cacheMove) {
  const compiled = createRequire(import.meta.url);
  const { runDesktopMigrations } = compiled(join(repositoryRoot, "electron-dist", "migrations.js"));
  const { requestDataMove, requestCacheMove } = compiled(join(repositoryRoot, "electron-dist", "data-location.js"));
  mkdirSync(join(dataRoot, "backups"), { recursive: true });
  const silent = { info() {}, warn() {}, error() {} };
  runDesktopMigrations({ databaseFile: join(dataRoot, "app.db"), migrationsDirectory: join(repositoryRoot, "src", "db", "migrations"), backupsDirectory: join(dataRoot, "backups"), logger: silent });
  if (dataMove) await requestDataMove({ dataRoot, target: movedData, databaseFileName: "app.db" });
  else await requestCacheMove({ dataRoot, target: movedCache });
}

function verifyCacheMove() {
  const state = JSON.parse(readFileSync(`${dataRoot}.location.json`, "utf8"));
  if (state.pendingCache !== null || state.lastResult?.kind !== "cache" || state.lastResult.outcome !== "moved") throw new Error(`The cache folder move did not finish: ${JSON.stringify(state.lastResult)}`);
  if (resolve(state.cache?.path ?? "") !== resolve(movedCache)) throw new Error(`The cache folder was not switched: ${JSON.stringify(state.cache)}`);
}

/*
 * A clean exit is not a passed run: the application also exits 0 when it quits
 * on its own partway through start-up. Only the smoke run's own last line says
 * every check ran.
 */
function verifySmokeCompleted() {
  const log = join(dataRoot, "logs", "desktop.log");
  if (!existsSync(log) || !readFileSync(log, "utf8").includes("Desktop Electron smoke test passed")) {
    throw new Error("The application exited before the smoke checks finished");
  }
}


function verifyDataMove() {
  if (!lstatSync(dataRoot).isSymbolicLink()) throw new Error("The data folder was not replaced by a junction");
  const state = JSON.parse(readFileSync(`${dataRoot}.location.json`, "utf8"));
  if (state.pending !== null || state.lastResult?.outcome !== "moved") throw new Error(`The data folder move did not finish: ${JSON.stringify(state.lastResult)}`);
  for (const path of [join(movedData, "app.db"), join(movedData, "logs", "desktop.log"), join(movedData, ".ria-data.json")]) {
    if (!existsSync(path)) throw new Error(`The moved data folder is missing ${path}`);
  }
  if (!state.previousCopies.some(copy => existsSync(join(copy.path, "app.db")))) throw new Error("The folder the data moved from was not kept");
}

const child = spawn(
  electronExecutable,
  packaged ? [] : [join(repositoryRoot, "electron-dist", "main.js")],
  {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    DESKTOP_FORCE_PACKAGED: forceStandalone ? "1" : "0",
    DESKTOP_SMOKE_TEST: "1",
    DESKTOP_SMOKE_START_MAXIMIZED: process.argv.includes("--maximized") ? "1" : "0",
    DESKTOP_PROJECT_ROOT: repositoryRoot,
    DESKTOP_RUNTIME_DIR: forceStandalone ? join(repositoryRoot, ".desktop-runtime") : "",
    DESKTOP_USER_DATA_DIR: testRoot,
    DESKTOP_DATA_DIR: development ? join(testRoot, "data") : "",
    DESKTOP_NODE_EXECUTABLE: process.execPath,
    DESKTOP_SMOKE_DOCUMENTS: documentFixtures,
  },
  stdio: "inherit",
  windowsHide: true,
  },
);

let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  child.kill("SIGTERM");
  console.error(`Desktop smoke test timed out. Diagnostics: ${testRoot}`);
  process.exitCode = 1;
}, 120_000);

child.on("error", (error) => {
  clearTimeout(timeout);
  console.error(error instanceof Error ? error.message : String(error));
  printDesktopSmokeDiagnostics(testRoot);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  clearTimeout(timeout);
  const cacheWrites = code === 0 && !timedOut ? runtimeCacheWrites() : [];
  if (cacheWrites.length) {
    console.error(`The service wrote ${cacheWrites.length} cache file(s) into its runtime directory, e.g. ${cacheWrites[0]}`);
    process.exitCode = 1;
  } else if (code === 0 && !timedOut) {
    try {
      verifySmokeCompleted();
      if (dataMove) verifyDataMove();
      if (cacheMove) verifyCacheMove();
    } catch (error) {
      console.error(`${error instanceof Error ? error.message : String(error)}. Diagnostics: ${testRoot}`);
      printDesktopSmokeDiagnostics(testRoot);
      process.exitCode = 1;
      return;
    }
    if (resolve(dirname(testRoot)) !== expectedParent) {
      throw new Error(`Refusing to clean unexpected smoke-test directory: ${testRoot}`);
    }
    // The junction goes on its own first, so removing the folder never walks through it.
    if (dataMove && existsSync(dataRoot) && lstatSync(dataRoot).isSymbolicLink()) rmdirSync(dataRoot);
    rmSync(testRoot, { recursive: true, force: true });
    console.log("Electron desktop smoke test passed.");
    process.exitCode = 0;
  } else {
    console.error(`Desktop smoke test failed with code ${code}${signal ? ` (signal ${signal})` : ""}. Diagnostics: ${testRoot}`);
    printDesktopSmokeDiagnostics(testRoot);
    process.exitCode = code && code > 0 ? code : 1;
  }
});
