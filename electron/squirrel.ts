import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { app } from "electron";

export function handleSquirrelStartupEvent(): boolean {
  if (process.platform !== "win32") return false;

  const command = process.argv[1];
  const executableName = basename(process.execPath);
  const updater = resolve(dirname(process.execPath), "..", "Update.exe");
  let updaterArguments: string[] | null = null;

  if (command === "--squirrel-install" || command === "--squirrel-updated") {
    updaterArguments = [`--createShortcut=${executableName}`];
  } else if (command === "--squirrel-uninstall") {
    updaterArguments = [`--removeShortcut=${executableName}`];
  } else if (command === "--squirrel-obsolete") {
    app.quit();
    return true;
  } else {
    return false;
  }

  const child = spawn(updater, updaterArguments, {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.once("error", () => app.quit());
  child.once("close", () => app.quit());
  child.unref();
  return true;
}
