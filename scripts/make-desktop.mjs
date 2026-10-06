import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function runCommand(command, args, options) {
  const result = spawnSync(command, args, { ...options, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status ?? "unknown exit"}).`);
}

export function makeDesktop(root, {
  platform = process.platform,
  environment = process.env,
  exists = existsSync,
  run = runCommand,
  skipBuild = false,
} = {}) {
  if (platform !== "win32") throw new Error("The MSI installer must be built on Windows.");
  const tooling = join(root, ".desktop-data", "tooling", "wix-3.14.1");
  const ready = () => ["candle.exe", "light.exe"].every(name => exists(join(tooling, name)));
  if (!ready()) {
    run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "provision-wix.ps1")], { cwd: root, env: environment });
    if (!ready()) throw new Error("WiX preparation did not produce candle.exe and light.exe.");
  }
  const env = { ...environment };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path");
  const inheritedPath = pathKey ? env[pathKey] : "";
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.PATH = `${tooling};${inheritedPath ?? ""}`;
  const options = { cwd: root, env };
  if (!skipBuild) run(process.execPath, [join(root, "scripts", "build-desktop.mjs")], options);
  run(process.execPath, [join(root, "node_modules", "@electron-forge", "cli", "dist", "electron-forge.js"), "make", "--platform", "win32", "--arch", "x64"], options);
  run(process.execPath, [join(root, "scripts", "desktop-release-manifest.mjs")], options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--skip-build")) throw new Error("Only --skip-build is supported (requires a previously built runtime).");
  makeDesktop(resolve(dirname(fileURLToPath(import.meta.url)), ".."), { skipBuild: args.includes("--skip-build") });
}
