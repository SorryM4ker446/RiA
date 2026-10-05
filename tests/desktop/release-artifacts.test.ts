import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bumpVersion } from "../../scripts/bump-version.mjs";
import { releaseManifest } from "../../scripts/desktop-release-manifest.mjs";
test("explicit version changes synchronize root metadata without changing dependency versions", () => {
  const root = mkdtempSync(join(tmpdir(), "ria-version-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }, null, 2));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ version: "1.2.3", packages: { "": { version: "1.2.3" }, "node_modules/example": { version: "1.2.3" } } }, null, 2));
    assert.equal(bumpVersion(root), "1.2.4");
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    assert.equal(lock.version, "1.2.4"); assert.equal(lock.packages[""].version, "1.2.4"); assert.equal(lock.packages["node_modules/example"].version, "1.2.3");
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.5" }));
    assert.throws(() => bumpVersion(root), /must agree/);
    assert.equal(JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).version, "1.2.4");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("installer evidence hashes artifacts but does not claim unperformed installation checks", async () => {
  const root = mkdtempSync(join(tmpdir(), "ria-release-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ version: "1.2.3", packages: { "": { version: "1.2.3" } } }));
    const directory = join(root, "out", "make", "wix", "x64"); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "RiA.msi"), "fixture");
    writeFileSync(join(directory, "RiA-1.2.30-x64.msi"), "obsolete fixture");
    const record = await releaseManifest(root);
    assert.equal(record.artifacts.length, 1); assert.equal(record.artifacts[0].sha256, createHash("sha256").update("fixture").digest("hex"));
    assert.equal(record.artifacts[0].filename, "RiA-1.2.3-x64.msi");
    assert.deepEqual((await releaseManifest(root)).artifacts, record.artifacts);
    assert.equal(record.acceptance.upgrade, "not verified");
    assert.equal(record.acceptance.nativeNotification, "not verified");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
