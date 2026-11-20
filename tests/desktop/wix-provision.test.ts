import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import JSZip from "jszip";

test("WiX provisioning extracts verified tools without PowerShell archive helpers", { skip: process.platform !== "win32" }, async (t) => {
  const parent = resolve(".desktop-data/test");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "wix-provision-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const zip = new JSZip();
  zip.file("candle.exe", "fixture candle");
  zip.file("light.exe", "fixture light");
  const archive = await zip.generateAsync({ type: "nodebuffer" });
  zip.remove("light.exe");
  const incompleteArchive = await zip.generateAsync({ type: "nodebuffer" });
  const source = readFileSync(resolve("scripts/provision-wix.ps1"), "utf8");
  for (const scenario of [
    { name: "valid", archive, pinned: archive },
    { name: "corrupt", archive: Buffer.from("invalid zip"), pinned: archive, error: /checksum mismatch/ },
    { name: "missing-light", archive: incompleteArchive, pinned: incompleteArchive, error: /did not produce light\.exe/ },
  ]) {
    const fixture = join(root, scenario.name);
    const scripts = join(fixture, "scripts");
    const tooling = join(fixture, ".desktop-data/tooling");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(tooling, { recursive: true });
    const expected = createHash("sha256").update(scenario.pinned).digest("hex").toUpperCase();
    const fixtureSource = source.replace(/\$expectedHash = '[A-F0-9]{64}'/, `$expectedHash = '${expected}'`);
    assert.notEqual(source, fixtureSource);
    writeFileSync(join(scripts, "provision-wix.ps1"), fixtureSource);
    writeFileSync(join(tooling, "wix314-binaries.zip"), scenario.archive);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      "function Get-FileHash { throw 'Get-FileHash is unavailable' }; " +
      "function Expand-Archive { throw 'Expand-Archive is unavailable' }; & './scripts/provision-wix.ps1'"],
    { cwd: fixture, encoding: "utf8", windowsHide: true, timeout: 30_000 });
    assert.ifError(result.error);
    const candle = join(tooling, "wix-3.14.1/candle.exe");
    const light = join(tooling, "wix-3.14.1/light.exe");
    if (scenario.error) {
      assert.notEqual(result.status, 0, scenario.name);
      assert.match(result.stderr, scenario.error);
      assert.doesNotMatch(result.stdout, /is ready/);
      assert.equal(existsSync(light), false);
      if (scenario.name === "corrupt") assert.equal(existsSync(candle), false);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(readFileSync(candle, "utf8"), "fixture candle");
      assert.equal(readFileSync(light, "utf8"), "fixture light");
    }
  }
});
