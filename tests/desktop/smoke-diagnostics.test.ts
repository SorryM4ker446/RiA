import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { printDesktopSmokeDiagnostics } from "../../scripts/smoke-desktop-diagnostics.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("a failed desktop child prints its application error and retains failure evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "ria-smoke-diagnostics-"));
  try {
    for (const folder of ["scripts", "tests/helpers", "electron-dist", ".desktop-runtime"]) {
      mkdirSync(join(root, folder), { recursive: true });
    }
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", version: "0.1.2" }));
    for (const script of ["smoke-desktop.mjs", "smoke-desktop-diagnostics.mjs"]) {
      copyFileSync(join(repositoryRoot, "scripts", script), join(root, "scripts", script));
    }
    writeFileSync(join(root, "scripts", "resolve-installed-electron.mjs"), "export const resolveInstalledElectron = () => process.execPath;");
    writeFileSync(join(root, "tests", "helpers", "document-fixtures.ts"), "export const textPdf = () => Buffer.from('fixture'); export const wordTableDocument = async () => Buffer.from('fixture');");
    writeFileSync(join(root, ".desktop-runtime", "server.js"), "");
    writeFileSync(join(root, "electron-dist", "main.js"), `
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const logs = join(process.env.DESKTOP_USER_DATA_DIR, 'data', 'logs');
      mkdirSync(logs, { recursive: true });
      writeFileSync(join(logs, 'desktop.log'), '[ERROR] Renderer bridge regression fixture');
      process.exit(1);
    `);
    const result = spawnSync(process.execPath, [join(root, "scripts", "smoke-desktop.mjs")], {
      cwd: repositoryRoot, encoding: "utf8", windowsHide: true, timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Renderer bridge regression fixture/);
    const runs = readdirSync(join(root, ".desktop-data", "test"));
    assert.equal(runs.length, 1);
    assert.match(readFileSync(join(root, ".desktop-data", "test", runs[0], "data", "logs", "desktop.log"), "utf8"), /Renderer bridge/);
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir())) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop failure output is bounded and excludes private profile files", () => {
  const root = mkdtempSync(join(tmpdir(), "ria-smoke-log-tail-"));
  try {
    mkdirSync(join(root, "data", "logs"), { recursive: true });
    writeFileSync(join(root, "data", "logs", "desktop.log"), "old line\n".repeat(10_000) + "[ERROR] final failure");
    writeFileSync(join(root, "data", "settings.json"), "private-profile-fixture");
    const output: string[] = [];
    printDesktopSmokeDiagnostics(root, line => output.push(line));
    assert.match(output.join("\n"), /final failure/);
    assert.ok(Buffer.byteLength(output.join("\n")) < 33 * 1024);
    assert.ok(!output.join("\n").includes("private-profile-fixture"));
    printDesktopSmokeDiagnostics(join(root, "missing"), line => output.push(line));
    assert.match(output.at(-1)!, /log unavailable/);
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir())) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
