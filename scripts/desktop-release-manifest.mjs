import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function installerArtifact(directory, filename) {
  const path = join(directory, filename);
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size === 0) throw new Error(`Missing installer bytes: ${filename}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { filename, bytes: metadata.size, sha256: hash.digest("hex") };
}

export async function releaseManifest(root) {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  if (lock.version !== manifest.version || lock.packages?.[""]?.version !== manifest.version) throw new Error("Package version mismatch");
  const directory = join(root, "out", "make", "wix", "x64");
  const product = manifest.productName ?? "RiA";
  const installer = `${product}-${manifest.version}-x64.msi`;
  const built = `${product}.msi`;
  if ((await readdir(directory)).includes(built)) {
    await rename(join(directory, built), join(directory, installer));
  }
  const names = (await readdir(directory)).filter(name => name === installer);
  if (!names.length) throw new Error("Installer artifacts for the current version are missing");
  const artifacts = [await installerArtifact(directory, installer)];
  const record = { version: manifest.version, platform: "win32", arch: "x64", generatedAt: new Date().toISOString(), node: process.version, artifacts,
    acceptance: { packagedSmoke: "run separately", cleanInstall: "not verified", upgrade: "not verified", nativeNotification: "not verified", physicalSleepResume: "not verified" } };
  await writeFile(join(directory, "verification.json"), JSON.stringify(record, null, 2) + "\n");
  return record;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const record = await releaseManifest(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  console.log(`Recorded ${record.artifacts.length} installer checksums for ${record.version}.`);
}
