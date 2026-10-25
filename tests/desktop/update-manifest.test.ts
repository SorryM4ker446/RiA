import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyManifest } from "../../electron/updater";
// The release scripts are untyped JavaScript under scripts/, so they resolve as implicit any.
import { writeUpdateManifest } from "../../scripts/update-manifest.mjs";
import { generateUpdateSigningKey } from "../../scripts/update-signing-key.mjs";

const sha256 = "a".repeat(64);

function release(version = "1.4.0") {
  const root = mkdtempSync(join(tmpdir(), "ria-update-manifest-"));
  const keys = generateKeyPairSync("ed25519");
  const publicKey = String(keys.publicKey.export({ type: "spki", format: "pem" }));
  mkdirSync(join(root, "electron"));
  writeFileSync(join(root, "electron", "update-signing-key.ts"), `export const UPDATE_SIGNING_PUBLIC_KEY = \`${publicKey}\`;\n`);
  writeFileSync(join(root, "package.json"), JSON.stringify({ productName: "RiA", version: "1.4.0" }));
  const directory = join(root, "out", "make", "wix", "x64");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "verification.json"), JSON.stringify({
    version, platform: "win32", arch: "x64", artifacts: [{ filename: `RiA-${version}-x64.msi`, bytes: 1234, sha256 }],
  }));
  return { root, directory, publicKey, privateKey: String(keys.privateKey.export({ type: "pkcs8", format: "pem" })), remove: () => rmSync(root, { recursive: true, force: true }) };
}

test("the release manifest is signed with the key the application ships with", async () => {
  const fixture = release();
  try {
    const written = await writeUpdateManifest(fixture.root, fixture.privateKey);
    const manifest = verifyManifest(JSON.parse(readFileSync(written.path, "utf8")), fixture.publicKey);
    assert.deepEqual(manifest, { product: "RiA", version: "1.4.0", platform: "win32", arch: "x64", filename: "RiA-1.4.0-x64.msi", bytes: 1234, sha256 });

    // A different key would publish a release no installed copy can accept.
    const other = String(generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
    await assert.rejects(writeUpdateManifest(fixture.root, other), /does not match/);
    await assert.rejects(writeUpdateManifest(fixture.root, ""), /RIA_UPDATE_SIGNING_KEY/);
  } finally {
    fixture.remove();
  }
});

test("the release manifest refuses an installer record for another version", async () => {
  const fixture = release("1.3.9");
  try {
    await assert.rejects(writeUpdateManifest(fixture.root, fixture.privateKey), /package version/);
  } finally {
    fixture.remove();
  }
});

test("a new signing key is written outside the repository and replaces the shipped public key", async () => {
  const fixture = release();
  const outside = mkdtempSync(join(tmpdir(), "ria-signing-key-"));
  try {
    await assert.rejects(generateUpdateSigningKey(fixture.root, join(fixture.root, "key.pem")), /outside the repository/);
    const keyFile = join(outside, "key.pem");
    await generateUpdateSigningKey(fixture.root, keyFile);
    assert.notEqual(readFileSync(join(fixture.root, "electron", "update-signing-key.ts"), "utf8").includes(fixture.publicKey), true);
    // The new pair signs a manifest the new public key accepts.
    await writeUpdateManifest(fixture.root, readFileSync(keyFile, "utf8"));
    await assert.rejects(generateUpdateSigningKey(fixture.root, keyFile), /EEXIST/);
  } finally {
    fixture.remove();
    rmSync(outside, { recursive: true, force: true });
  }
});
