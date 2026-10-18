import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

test("installer diagnostics inspect an upgrade failure without installing, changing permissions or exposing unrelated properties", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "ria-installer-diagnostics-"));
  const log = join(root, "upgrade.log");
  const source = [
    "Property(S): UNRELATED_TEST_PROPERTY = REDACTED_TEST_VALUE",
    "Property(S): UNRELATED_TEST_PROPERTY = E:\\Config.Msi\\private-test-value.rbf",
    "Property(S): MSIINSTALLPERUSER = 1",
    "Error 1926. Could not set file security for file 'E:\\Config.Msi\\test.rbf'. Error: 5.",
    "Action ended: InstallFinalize. Return value 3.",
  ].join("\r\n");
  writeFileSync(log, source);
  try {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve("scripts/diagnose-windows-installer.ps1"), "-InstallDirectory", root, "-LogPath", log], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(typeof report.elevated, "boolean");
    assert.equal(report.installDirectory.path, root);
    assert.equal(report.installDirectory.exists, true);
    assert.equal(report.logFindings.length, 3);
    assert.match(JSON.stringify(report.logFindings), /1926/);
    assert.doesNotMatch(result.stdout, /REDACTED_TEST_VALUE|UNRELATED_TEST_PROPERTY|private-test-value/);
    assert.equal(readFileSync(log, "utf8"), source);
    assert.deepEqual(readdirSync(root), ["upgrade.log"]);
  } finally {
    assert.equal(dirname(root), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
});
