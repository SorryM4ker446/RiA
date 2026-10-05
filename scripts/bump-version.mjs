import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function bumpVersion(root) {
  const paths = [join(root, "package.json"), join(root, "package-lock.json")];
  const originals = paths.map(path => readFileSync(path, "utf8"));
  const manifest = JSON.parse(originals[0]), lock = JSON.parse(originals[1]);
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(manifest.version);
  if (!parts || lock.version !== manifest.version || lock.packages?.[""]?.version !== manifest.version) throw new Error("Package and lockfile versions must agree before changing the version.");
  const next = `${parts[1]}.${parts[2]}.${Number(parts[3]) + 1}`;
  const changed = [originals[0].replace(/^(\s*"version"\s*:\s*")[^"]+(".*)$/m, `$1${next}$2`)];
  lock.version = next;
  lock.packages[""].version = next;
  const newline = originals[1].includes("\r\n") ? "\r\n" : "\n";
  changed[1] = JSON.stringify(lock, null, 2).replaceAll("\n", newline) + newline;
  try { paths.forEach((path, index) => writeFileSync(path, changed[index])); }
  catch (error) { paths.forEach((path, index) => writeFileSync(path, originals[index])); throw error; }
  return next;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Version: ${bumpVersion(resolve(dirname(fileURLToPath(import.meta.url)), ".."))}`);
}
