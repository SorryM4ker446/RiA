import { generateKeyPairSync } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicKeySource } from "./update-manifest.mjs";

/*
 * Creates the key pair that signs update manifests.
 *
 * The private key goes to a file outside the repository and is never printed:
 * it belongs in the release secret and a password manager, not in a log. The
 * public key replaces the one in the application source. Installed copies only
 * accept manifests signed by the key they were built with, so replacing it means
 * existing installations have to be updated by hand once.
 */
export async function generateUpdateSigningKey(root, privateKeyPath) {
  if (!privateKeyPath) throw new Error("Usage: node scripts/update-signing-key.mjs <private-key-output-file>");
  const target = resolve(privateKeyPath);
  const inside = relative(root, target);
  if (!inside.startsWith("..") && !isAbsolute(inside)) throw new Error("Write the private key outside the repository.");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // `wx` refuses to replace an existing key file.
  await writeFile(target, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
  const sourcePath = join(root, publicKeySource);
  const source = await readFile(sourcePath, "utf8");
  const pattern = /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----\n?/;
  if (!pattern.test(source)) throw new Error(`No public key block in ${publicKeySource}`);
  await writeFile(sourcePath, source.replace(pattern, String(publicKey.export({ type: "spki", format: "pem" }))));
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const written = await generateUpdateSigningKey(resolve(dirname(fileURLToPath(import.meta.url)), ".."), process.argv[2]);
  console.log(`Private key written to ${written}. Public key updated in ${publicKeySource}.`);
}
