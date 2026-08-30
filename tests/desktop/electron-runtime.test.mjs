import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { resolveInstalledElectron } from "../../scripts/resolve-installed-electron.mjs";

test("desktop runtime resolution never installs missing binaries", () => {
  const root = mkdtempSync(join(tmpdir(), "private-ai-electron-resolution-"));
  try {
    const options = { packageDirectory: root, overrideDirectory: "" };
    assert.throws(() => resolveInstalledElectron(options), /never download/);
    assert.deepEqual(readdirSync(root), []);
    writeFileSync(join(root, "path.txt"), "electron.exe");
    assert.throws(() => resolveInstalledElectron(options), /never download/);
    assert.deepEqual(readdirSync(root), ["path.txt"]);
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "electron.exe"), "test fixture, not an executable");
    assert.equal(resolveInstalledElectron(options), join(root, "dist", "electron.exe"));
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir())) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
