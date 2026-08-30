import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDirectory = join(repositoryRoot, ".desktop-runtime");
const explicitPackageDirectory = process.argv[2] ? resolve(repositoryRoot, process.argv[2]) : null;
const defaultPackageDirectory = join(repositoryRoot, "out", "Private AI Assistant-win32-x64");
const packageDirectory = explicitPackageDirectory || (existsSync(defaultPackageDirectory) ? defaultPackageDirectory : null);

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} is missing: ${path}`);
}

function verifyRuntime(directory) {
  requireFile(join(directory, "server.js"), "Standalone server");
  requireFile(join(directory, "package.json"), "Standalone package metadata");
  requireFile(join(directory, "desktop-runtime.json"), "Desktop runtime manifest");
  requireFile(join(directory, "prisma", "schema.prisma"), "Prisma schema");

  const files = walk(directory);
  if (!files.some((path) => path.endsWith("migration.sql"))) {
    throw new Error("No SQLite migration was copied into the desktop runtime.");
  }
  if (!files.some((path) => path.endsWith(".node") && path.toLowerCase().includes("query_engine"))) {
    throw new Error("Prisma's native query engine is missing from the desktop runtime.");
  }
  const forbiddenEnvironmentFile = files.find((path) => /^\.env(?:\.|$)/i.test(relative(directory, path).split(/[\\/]/).pop() || ""));
  if (forbiddenEnvironmentFile) {
    throw new Error(`Environment file must not be packaged: ${forbiddenEnvironmentFile}`);
  }

  const textExtensions = new Set([".js", ".json", ".txt", ".md", ".prisma"]);
  const secretPattern = /(?:sk-or-v1-|tvly-)[A-Za-z0-9_-]{16,}/;
  for (const file of files) {
    if (!textExtensions.has(extname(file).toLowerCase()) || statSync(file).size > 10 * 1024 * 1024) continue;
    if (secretPattern.test(readFileSync(file, "utf8"))) {
      throw new Error(`A value resembling a real API key was found in ${file}`);
    }
  }
}

verifyRuntime(runtimeDirectory);

if (packageDirectory) {
  requireFile(join(packageDirectory, "Private AI Assistant.exe"), "Packaged application executable");
  verifyRuntime(join(packageDirectory, "resources", ".desktop-runtime"));
  const packagedFiles = walk(packageDirectory);
  if (packagedFiles.some((path) => /^\.env(?:\.|$)/i.test(path.split(/[\\/]/).pop() || ""))) {
    throw new Error("Packaged application contains an environment file.");
  }
}

console.log(
  packageDirectory
    ? `Desktop runtime and package verified: ${relative(repositoryRoot, packageDirectory)}`
    : "Desktop standalone runtime verified.",
);
