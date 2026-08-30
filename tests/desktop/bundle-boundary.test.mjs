import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fixture(script, check) {
  const root = mkdtempSync(join(tmpdir(), "private-ai-bundle-"));
  try {
    mkdirSync(join(root, "scripts"));
    copyFileSync(join(repositoryRoot, "scripts", script), join(root, "scripts", script));
    mkdirSync(join(root, ".next", "standalone"), { recursive: true });
    writeFileSync(join(root, ".next", "standalone", "server.js"), "");
    mkdirSync(join(root, ".desktop-runtime"));
    writeFileSync(join(root, ".desktop-runtime", "retain.txt"), "Existing runtime");
    check(root, () => spawnSync(process.execPath, [join(root, "scripts", script), "--runtime-only"], { cwd: root, encoding: "utf8", windowsHide: true }));
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir())) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
}

test("runtime preparation rejects traced user data before replacing existing output", () => {
  fixture("prepare-desktop.mjs", (root, run) => {
    mkdirSync(join(root, ".next", "standalone", ".desktop-data"));
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Standalone output contains .desktop-data/);
    assert.equal(readFileSync(join(root, ".desktop-runtime", "retain.txt"), "utf8"), "Existing runtime");
  });
});

test("runtime preparation refuses to discard legacy generated videos", () => {
  fixture("prepare-desktop.mjs", (root, run) => {
    const legacy = join(root, ".desktop-runtime", "public", "generated-videos");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "retained.mp4"), "Legacy data");
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing to discard them/);
    assert.equal(readFileSync(join(legacy, "retained.mp4"), "utf8"), "Legacy data");
  });
});

test("runtime verification rejects private data and public generated media", () => {
  for (const forbidden of [".desktop-data", ".desktop-runtime", ".git", "out", "public/generated-videos"]) {
    fixture("verify-desktop-package.mjs", (root, run) => {
      mkdirSync(join(root, ".desktop-runtime", forbidden), { recursive: true });
      const result = run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /User\/development data must not be packaged/);
    });
  }
});
