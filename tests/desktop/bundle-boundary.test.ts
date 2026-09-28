import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { dropRuntimeImageCache } from "../../scripts/desktop-package-hooks.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fixture(script, check) {
  const root = mkdtempSync(join(tmpdir(), "private-ai-bundle-"));
  try {
    mkdirSync(join(root, "scripts"));
    copyFileSync(join(repositoryRoot, "scripts", script), join(root, "scripts", script));
    // The script may import neighbouring helpers, so the fixture carries every
    // local module from the scripts directory.
    for (const entry of readdirSync(join(repositoryRoot, "scripts"), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".mjs") || entry.name === script) continue;
      copyFileSync(join(repositoryRoot, "scripts", entry.name), join(root, "scripts", entry.name));
    }
    mkdirSync(join(root, ".next", "standalone"), { recursive: true });
    writeFileSync(join(root, ".next", "standalone", "server.js"), "");
    mkdirSync(join(root, ".desktop-runtime"));
    writeFileSync(join(root, ".desktop-runtime", "retain.txt"), "Existing runtime");
    // The verifier treats its second argument as the package directory. Passing
    // it switches the run from runtime-only to full package verification.
    check(root, (packageDirectory) =>
      spawnSync(
        process.execPath,
        [join(root, "scripts", script), ...(packageDirectory ? [packageDirectory] : ["--runtime-only"])],
        { cwd: root, encoding: "utf8", windowsHide: true },
      ),
    );
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

// The path-length guard only applies to the packaged copy, so the fixture builds
// one under a package directory. verifyRuntime checks the required runtime
// contents first, so the fixture needs a valid runtime to reach the guard.
function seedValidRuntime(root, runtime) {
  const write = (relativePath, contents = "") => {
    const target = join(runtime, ...relativePath.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  write("server.js");
  write("package.json", "{}");
  write("desktop-runtime.json", "{}");
  write("prisma/schema.prisma");
  write("prisma/migrations/0001_init/migration.sql");
  for (const entry of ["pdfjs-dist/legacy/build/pdf.mjs", "pdfjs-dist/legacy/build/pdf.worker.mjs", "mammoth/lib/index.js", "jszip/lib/index.js"]) {
    write(`node_modules/${entry}`);
  }
  write("node_modules/.prisma/client/query_engine.dll.node");
  return runtime;
}

// A genuine overflow that the packaging hook does not remove: a deeply nested
// file whose path alone exceeds the budget. The runtime image cache is excluded
// from this check because the hook strips it before nuget ever reads it.
function seedOverflowingPath(runtime) {
  const offender = join(runtime, "node_modules", "a".repeat(60), "b".repeat(60), `${"c".repeat(60)}.js`);
  mkdirSync(dirname(offender), { recursive: true });
  writeFileSync(offender, "");
}

// A package fixture: the verifier checks the source runtime and then the
// packaged copy, so both need to be valid. The package runtime is nested under
// resources/ exactly as Forge stages it.
function packageFixture(root, build) {
  seedValidRuntime(root, join(root, ".desktop-runtime"));
  const packageDirectory = join(root, "out", "RiA-win32-x64");
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(join(packageDirectory, "RiA.exe"), "");
  const runtime = seedValidRuntime(root, join(packageDirectory, "resources", ".desktop-runtime"));
  build(runtime);
  return packageDirectory;
}

test("packaged verification rejects paths that overflow the Squirrel temp directory", () => {
  fixture("verify-desktop-package.mjs", (root, run) => {
    const packageDirectory = packageFixture(root, seedOverflowingPath);
    const result = run(packageDirectory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reaches the Windows limit/);
  });
});

test("packaged verification accepts a package whose longest path still fits", () => {
  fixture("verify-desktop-package.mjs", (root, run) => {
    const packageDirectory = packageFixture(root, () => {});
    const result = run(packageDirectory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Desktop runtime and package verified/);
  });
});

test("packaged verification ignores the runtime image cache the packaging hook strips", () => {
  fixture("verify-desktop-package.mjs", (root, run) => {
    // Running the packaged app regenerates this cache in place, so verification
    // must not fail on a directory the installer never ships.
    const packageDirectory = packageFixture(root, (runtime) => {
      const cached = join(runtime, ".next", "cache", "images", "a".repeat(40), `${"b".repeat(150)}.png`);
      mkdirSync(dirname(cached), { recursive: true });
      writeFileSync(cached, "");
    });
    const result = run(packageDirectory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Desktop runtime and package verified/);
  });
});

test("the packaged bundle drops the runtime image cache before Squirrel reads it", async () => {
  // Reproduce what the packager does: copy the extra resource into the staging
  // resources directory, then run the afterCopyExtraResources hook the way
  // promisifyHooks does, with the completion callback appended last.
  const staging = mkdtempSync(join(tmpdir(), "private-ai-staging-"));
  try {
    const runtime = join(repositoryRoot, ".desktop-runtime");
    if (!existsSync(join(runtime, "server.js"))) return; // Runtime not built in this checkout.
    cpSync(runtime, join(staging, "resources", ".desktop-runtime"), { recursive: true });
    assert.equal(existsSync(join(staging, "resources", ".desktop-runtime", ".next", "cache", "images")), true);

    await new Promise<void>((resolvePromise, reject) => {
      const returned: unknown = dropRuntimeImageCache(staging, "1.0.0", "win32", "x64", (error) =>
        error ? reject(error) : resolvePromise(),
      );
      // A hook that never calls back hangs the packaging step, so surface it.
      // The declaration types the hook as returning void; a packaged build may promisify it.
      const pending = returned as Promise<void> | undefined;
      if (pending && typeof pending.then === "function") pending.then(resolvePromise, reject);
    });

    assert.equal(existsSync(join(staging, "resources", ".desktop-runtime", ".next", "cache")), false);
    assert.equal(existsSync(join(staging, "resources", ".desktop-runtime", "server.js")), true);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});
