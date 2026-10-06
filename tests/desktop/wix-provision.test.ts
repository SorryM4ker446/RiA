import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import JSZip from "jszip";

test("WiX provisioning verifies and extracts archives without Get-FileHash, and refuses corrupt bytes", { skip: process.platform !== "win32" }, async () => {
  const parent = resolve(".desktop-data/test");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "wix-provision-"));
  const zip = new JSZip();
  zip.file("candle.exe", "fixture candle");
  zip.file("light.exe", "fixture light");
  const archive = await zip.generateAsync({ type: "nodebuffer" });
  const expected = createHash("sha256").update(archive).digest("hex").toUpperCase();
  const source = readFileSync(resolve("scripts/provision-wix.ps1"), "utf8");
  // The fixture pins its own archive hash; the shipped release pin stays unchanged.
  const fixtureSource = source.replace(/\$expectedHash = '[A-F0-9]{64}'/, `$expectedHash = '${expected}'`);
  assert.notEqual(source, fixtureSource);
  for (const corrupt of [false, true]) {
    const fixture = join(root, corrupt ? "corrupt" : "valid");
    const scripts = join(fixture, "scripts");
    const tooling = join(fixture, ".desktop-data/tooling");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(tooling, { recursive: true });
    writeFileSync(join(scripts, "provision-wix.ps1"), fixtureSource);
    writeFileSync(join(tooling, "wix314-binaries.zip"), corrupt ? Buffer.from("invalid zip") : archive);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      "function Get-FileHash { throw 'Get-FileHash is unavailable' }; & './scripts/provision-wix.ps1'"],
    { cwd: fixture, encoding: "utf8", windowsHide: true, timeout: 30_000 });
    assert.ifError(result.error);
    const executable = join(tooling, "wix-3.14.1/candle.exe");
    if (corrupt) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /checksum mismatch/);
      assert.equal(existsSync(executable), false);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(executable, "utf8"), "fixture candle");
      assert.equal(readFileSync(join(tooling, "wix-3.14.1/light.exe"), "utf8"), "fixture light");
    }
  }
});
