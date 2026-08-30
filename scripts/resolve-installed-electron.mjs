import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

// Requiring Electron's main entry can install its binary. Tests must only inspect it.
export function resolveInstalledElectron({
  packageDirectory = dirname(require.resolve("electron/package.json")),
  overrideDirectory = process.env.ELECTRON_OVERRIDE_DIST_PATH,
} = {}) {
  const pathFile = join(packageDirectory, "path.txt");
  const relativeExecutable = existsSync(pathFile) ? readFileSync(pathFile, "utf8").trim() : "";
  if (!relativeExecutable) {
    throw new Error("Electron runtime is not installed. Desktop tests never download it automatically.");
  }
  const executable = join(overrideDirectory || join(packageDirectory, "dist"), relativeExecutable);
  if (!existsSync(executable)) {
    throw new Error(`Electron runtime is missing: ${executable}. Desktop tests never download it automatically.`);
  }
  return executable;
}
