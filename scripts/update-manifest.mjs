import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
export async function writeUpdateManifest(root, privateKeyPem) {
  if (!privateKeyPem?.trim()) throw new Error("RIA_UPDATE_SIGNING_KEY is not set");
  const directory = join(root, "out", "make", "wix", "x64");
  const record = JSON.parse(await readFile(join(directory, "verification.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (record.version !== manifest.version) throw new Error("The installer record does not match the package version");
  if (record.platform !== "win32" || record.arch !== "x64" || record.artifacts?.length !== 1) throw new Error("Expected exactly one Windows x64 installer");
  const [artifact] = record.artifacts;
  const product = manifest.productName ?? "RiA";
  if (artifact.filename !== `${product}-${record.version}-x64.msi`) throw new Error(`Unexpected installer name: ${artifact.filename}`);
  const payload = JSON.stringify({
    product, version: record.version, platform: "win32", arch: "x64",
    filename: artifact.filename, bytes: artifact.bytes, sha256: artifact.sha256,
  });
  const privateKey = createPrivateKey(privateKeyPem);
  const signature = sign(null, Buffer.from(payload, "utf8"), privateKey);
  if (!verify(null, Buffer.from(payload, "utf8"), await shippedPublicKey(root), signature)) {
    throw new Error(`The signing key does not match the public key in ${publicKeySource}`);
  }
  const path = join(directory, updateManifestName);
  await writeFile(path, JSON.stringify({ payload, signature: signature.toString("base64") }, null, 2) + "\n");
  return { path, version: record.version, filename: artifact.filename };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await writeUpdateManifest(resolve(dirname(fileURLToPath(import.meta.url)), ".."), process.env.RIA_UPDATE_SIGNING_KEY);
  console.log(`Signed the update manifest for ${result.filename}.`);
}
