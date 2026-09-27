import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDirectory = join(repositoryRoot, ".desktop-runtime");
const runtimeOnly = process.argv.includes("--runtime-only");
const explicitPackageDirectory = process.argv[2] && !runtimeOnly ? resolve(repositoryRoot, process.argv[2]) : null;
const defaultPackageDirectory = join(repositoryRoot, "out", "RiA-win32-x64");
const packageDirectory = runtimeOnly ? null : explicitPackageDirectory || (existsSync(defaultPackageDirectory) ? defaultPackageDirectory : null);

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

// Windows rejects a fully qualified path of 260 characters or more. Before nuget
// runs, Squirrel copies the packaged app to a temp directory, so a file that is
// safe inside the bundle can still overflow once staged. The reserve below
// covers that re-rooting: %TEMP%\squirrel-maker-XXXXXX\ plus the
// resources/.desktop-runtime/ prefix it is copied under.
const windowsPathLimit = 260;
const squirrelStagingReserve = 102;
const windowsPathBudget = windowsPathLimit - squirrelStagingReserve;

// The packaging hook strips the runtime image cache from the staged copy, so it
// never reaches nuget. Running the packaged app regenerates it in place, and this
// check runs against that same directory, so the cache is skipped here for the
// same reason: it is not part of what the installer ships.
const runtimeImageCache = join(".next", "cache");

function assertPackagedPathsFitWindows(directory) {
  let longest = { length: 0, path: "" };
  for (const file of walk(directory)) {
    const relativePath = relative(directory, file);
    if (relativePath.split(sep).join("/").startsWith(`${runtimeImageCache.split(sep).join("/")}/`)) continue;
    if (relativePath.length > longest.length) longest = { length: relativePath.length, path: relativePath };
  }
  if (longest.length >= windowsPathBudget) {
    throw new Error(
      `Packaged path is ${longest.length} characters, which reaches the Windows limit of ${windowsPathLimit} once the Squirrel temp directory is prepended: ${longest.path}`,
    );
  }
}

function verifyRuntime(directory, { enforceWindowsPathBudget = false } = {}) {
  for (const forbidden of [".desktop-data", ".desktop-runtime", ".git", "out", "public/generated-videos"]) {
    if (existsSync(join(directory, forbidden))) throw new Error(`User/development data must not be packaged: ${forbidden}`);
  }
  requireFile(join(directory, "server.js"), "Standalone server");
  requireFile(join(directory, "package.json"), "Standalone package metadata");
  requireFile(join(directory, "desktop-runtime.json"), "Desktop runtime manifest");
  requireFile(join(directory, "prisma", "schema.prisma"), "Prisma schema");
  for (const entry of ["pdfjs-dist/legacy/build/pdf.mjs", "pdfjs-dist/legacy/build/pdf.worker.mjs", "mammoth/lib/index.js", "jszip/lib/index.js"]) {
    requireFile(join(directory, "node_modules", entry), "Document parser dependency");
  }

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

  const textExtensions = new Set([".js", ".mjs", ".cjs", ".json", ".txt", ".md", ".prisma"]);
  const secretPattern = /(?:sk-or-v1-|tvly-)[A-Za-z0-9_-]{16,}/;
  for (const file of files) {
    if (!textExtensions.has(extname(file).toLowerCase()) || statSync(file).size > 10 * 1024 * 1024) continue;
    if (secretPattern.test(readFileSync(file, "utf8"))) {
      throw new Error(`A value resembling a real API key was found in ${file}`);
    }
  }

  // Only the packaged copy is subject to the Squirrel staging limit. The source
  // runtime legitimately grows a Next.js image cache while the app runs, and the
  // packaging hook drops that cache from the staged copy.
  if (enforceWindowsPathBudget) {
    // Squirrel re-copies the packaged app under %TEMP%\squirrel-maker-XXXXXX
    // before running nuget, which cannot handle a fully qualified path of 260
    // characters or more. Fail here with the offending path instead of letting
    // the installer step die on an opaque nuget "path too long" error.
    assertPackagedPathsFitWindows(directory);
  }
}

verifyRuntime(runtimeDirectory);

if (packageDirectory) {
  requireFile(join(packageDirectory, "RiA.exe"), "Packaged application executable");
  verifyRuntime(join(packageDirectory, "resources", ".desktop-runtime"), { enforceWindowsPathBudget: true });
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
