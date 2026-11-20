import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installerArtifact } from "./desktop-release-manifest.mjs";

export const updateManifestName = "update-manifest.json";
export const publicKeySource = join("electron", "update-signing-key.ts");

/** The public key the application ships with, read from the same source it is compiled from. */
export async function shippedPublicKey(root) {
  const source = await readFile(join(root, publicKeySource), "utf8");
  const pem = source.match(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/)?.[0];
  if (!pem) throw new Error(`No public key in ${publicKeySource}`);
  return createPublicKey(pem);
}

/*
 * The signed description of one release, published beside its installer.
 *
 * The payload is kept as the exact string that was signed, so the application
 * verifies those bytes rather than a re-serialisation of them. It is signed only
 * after checking that the key in hand matches the key the application ships with:
 * a manifest the installed copies cannot verify would publish a release that no
 * existing installation is able to accept.
 */
export async function writeUpdateManifest(root, privateKeyPem, { requireSetup = false } = {}) {
  if (!privateKeyPem?.trim()) throw new Error("RIA_UPDATE_SIGNING_KEY is not set");
  const directory = join(root, "out", "make", "wix", "x64");
  const record = JSON.parse(await readFile(join(directory, "verification.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (record.version !== manifest.version) throw new Error("The installer record does not match the package version");
  if (record.platform !== "win32" || record.arch !== "x64" || !Array.isArray(record.artifacts)) throw new Error("Expected Windows x64 installers");
  const product = manifest.productName ?? "RiA";
  const msiName = `${product}-${record.version}-x64.msi`;
  const setupName = `${product}-Setup-${record.version}-x64.exe`;
  const names = new Set(record.artifacts.map(item => item.filename));
  if (!names.has(msiName) || names.size !== record.artifacts.length || [...names].some(name => name !== msiName && name !== setupName))
    throw new Error("Unexpected or duplicate installer names");
  if (requireSetup && !names.has(setupName)) throw new Error("The release is missing its Setup EXE");

  const [artifact, setup] = await Promise.all([msiName, setupName].map(async filename => {
    const expected = record.artifacts.find(item => item.filename === filename);
    if (!expected) return null;
    const actual = await installerArtifact(directory, filename);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error(`Installer bytes do not match verification.json: ${filename}`);
    return actual;
  }));
  const payload = JSON.stringify({
    product, version: record.version, platform: "win32", arch: "x64",
    filename: artifact.filename, bytes: artifact.bytes, sha256: artifact.sha256,
    ...(setup ? { setup } : {}),
  });
  const privateKey = createPrivateKey(privateKeyPem);
  const signature = sign(null, Buffer.from(payload, "utf8"), privateKey);
  if (!verify(null, Buffer.from(payload, "utf8"), await shippedPublicKey(root), signature)) {
    throw new Error(`The signing key does not match the public key in ${publicKeySource}`);
  }
  const path = join(directory, updateManifestName);
  await writeFile(path, JSON.stringify({ payload, signature: signature.toString("base64") }, null, 2) + "\n");
  return { path, version: record.version, filename: artifact.filename, ...(setup ? { setupFilename: setup.filename } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--with-setup")) throw new Error("Only --with-setup is supported");
  const result = await writeUpdateManifest(resolve(dirname(fileURLToPath(import.meta.url)), ".."), process.env.RIA_UPDATE_SIGNING_KEY, { requireSetup: args.includes("--with-setup") });
  console.log(`Signed the update manifest for ${[result.filename, result.setupFilename].filter(Boolean).join(" and ")}.`);
}
