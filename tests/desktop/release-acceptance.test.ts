import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { acceptanceScenarios, checkAcceptance, initializeAcceptance } from "../../scripts/desktop-release-acceptance.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "ria-acceptance-"));
  const manifest = join(root, "verification.json");
  const record = join(root, "acceptance.json");
  const installer = join(root, "RiA-1.2.3-x64.msi");
  const artifact = { filename: "RiA-1.2.3-x64.msi", bytes: 7, sha256: createHash("sha256").update("fixture").digest("hex") };
  const release = { version: "1.2.3", platform: "win32", arch: "x64", artifacts: [artifact] };
  const save = data => writeFile(record, JSON.stringify(data));
  try {
    await writeFile(installer, "fixture");
    await writeFile(manifest, JSON.stringify({ ...release, generatedAt: new Date().toISOString(), acceptance: { upgrade: "not verified" } }));
    await run({ root, manifest, record, installer, release, save });
  } finally {
    assert.equal(resolve(dirname(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
}
async function completed(context) {
  const record = await initializeAcceptance(context.manifest, context.record);
  record.environment = { windowsBuild: "Windows 11 fixture", vm: "disposable VM fixture", installationType: "per-user MSI", tester: "fixture tester", previousVersion: "1.2.2" };
  for (const scenario of record.scenarios) {
    const filename = `evidence-${scenario.id}.txt`;
    await writeFile(join(context.root, filename), `Synthetic evidence for ${scenario.id}; not a real installation result.`);
    scenario.result = "pass";
    scenario.testedAt = new Date().toISOString();
    scenario.evidence = [filename];
  }
  await context.save(record);
  return record;
}

test("acceptance initializes every manual scenario unverified and refuses to overwrite existing evidence", async () => {
  await fixture(async context => {
    const record = await initializeAcceptance(context.manifest, context.record);
    assert.deepEqual(record.release, context.release);
    assert.deepEqual(record.scenarios.map(item => item.id), acceptanceScenarios);
    assert.ok(record.scenarios.every(item => item.result === "not-run" && item.testedAt === null && !item.evidence.length));
    await assert.rejects(checkAcceptance(context.manifest, context.record), /incomplete/);
    await context.save({ retained: "tester evidence" });
    await assert.rejects(initializeAcceptance(context.manifest, context.record), { code: "EEXIST" });
    assert.deepEqual(JSON.parse(await readFile(context.record, "utf8")), { retained: "tester evidence" });
  });
});

test("acceptance binds the exact artifact and emits evidence digests without copying evidence contents", async () => {
  await fixture(async context => {
    await completed(context);
    const result = await checkAcceptance(context.manifest, context.record);
    assert.equal(result.manualAcceptance, "pass");
    assert.deepEqual(result.release, context.release);
    assert.equal(result.scenarios.length, 10);
    const evidence = result.scenarios[0].evidence[0];
    const content = await readFile(join(context.root, evidence.path));
    assert.equal(evidence.sha256, createHash("sha256").update(content).digest("hex"));
    assert.equal(evidence.bytes, content.length);
    assert.equal(JSON.stringify(result).includes("Synthetic evidence"), false);
    assert.equal(result.record.sha256, createHash("sha256").update(await readFile(context.record)).digest("hex"));
  });
});

test("acceptance rejects changed installer bytes and an old record after a same-version rebuild", async () => {
  await fixture(async context => {
    await completed(context);
    await writeFile(context.installer, "changed");
    await assert.rejects(checkAcceptance(context.manifest, context.record), /Installer bytes/);
    await writeFile(context.manifest, JSON.stringify({ ...context.release, artifacts: [{ ...context.release.artifacts[0], sha256: createHash("sha256").update("changed").digest("hex") }] }));
    await assert.rejects(checkAcceptance(context.manifest, context.record), /different installer/);
  });
});

test("acceptance rejects changed release versions and installer path traversal", async () => {
  await fixture(async context => {
    const record = await completed(context);
    record.release.version = "1.2.2";
    await context.save(record);
    await assert.rejects(checkAcceptance(context.manifest, context.record), /different installer/);
    await writeFile(context.manifest, JSON.stringify({ ...context.release, artifacts: [{ ...context.release.artifacts[0], filename: "../RiA-1.2.3-x64.msi" }] }));
    await assert.rejects(checkAcceptance(context.manifest, context.record), /Invalid release manifest/);
  });
});

test("acceptance requires all scenario identities, successful results and environment details", async () => {
  await fixture(async context => {
    const original = await completed(context);
    for (const modify of [
      record => { record.scenarios[0].result = "fail"; },
      record => { record.scenarios[0].result = "not-run"; },
      record => { record.scenarios.pop(); },
      record => { record.scenarios[0].id = record.scenarios[1].id; },
      record => { record.scenarios[0].id = "unknown-scenario"; },
      record => { record.environment.tester = " "; },
      record => { record.environment.vm = ""; },
      record => { record.environment.windowsBuild = ""; },
      record => { record.environment.installationType = ""; },
      record => { record.environment.previousVersion = ""; },
      record => { record.environment.previousVersion = original.release.version; },
      record => { record.environment.previousVersion = "1.2.4"; },
    ]) {
      const record = structuredClone(original);
      modify(record);
      await context.save(record);
      await assert.rejects(checkAcceptance(context.manifest, context.record));
    }
  });
});

test("acceptance rejects missing, empty, future-dated or metadata-only scenario evidence", async () => {
  await fixture(async context => {
    const original = await completed(context);
    await writeFile(join(context.root, "empty.txt"), "");
    for (const modify of [
      record => { record.scenarios[0].testedAt = null; },
      record => { record.scenarios[0].testedAt = "not-a-date"; },
      record => { record.scenarios[0].testedAt = new Date(Date.now() + 86_400_000).toISOString(); },
      record => { record.scenarios[0].evidence = []; },
      record => { record.scenarios[0].evidence = ["missing.png"]; },
      record => { record.scenarios[0].evidence = ["empty.txt"]; },
      record => { record.scenarios[0].evidence = ["."]; },
      record => { record.scenarios[0].evidence = ["verification.json"]; },
      record => { record.scenarios[0].evidence = ["acceptance.json"]; },
      record => { record.scenarios[0].evidence = ["RiA-1.2.3-x64.msi"]; },
    ]) {
      const record = structuredClone(original);
      modify(record);
      await context.save(record);
      await assert.rejects(checkAcceptance(context.manifest, context.record));
    }
  });
});

test("acceptance CLI exits unsuccessfully for incomplete checks and writes receipts without replacing evidence", async () => {
  await fixture(async context => {
    const run = args => spawnSync(process.execPath, [resolve("scripts/desktop-release-acceptance.mjs"), ...args, "--manifest", context.manifest, "--record", context.record], { encoding: "utf8", windowsHide: true });
    assert.equal(run(["--init"]).status, 0);
    assert.equal(run(["--check"]).status, 1);
    assert.equal(run(["--init", "--check"]).status, 1);
    assert.equal(run(["--check", "--unknown"]).status, 1);
    await rm(context.record);
    await completed(context);
    const output = join(context.root, "receipt.json");
    assert.equal(run(["--check", "--output", output]).status, 0);
    const saved = await readFile(output, "utf8");
    assert.equal(JSON.parse(saved).manualAcceptance, "pass");
    assert.equal(run(["--check", "--output", output]).status, 1);
    assert.equal(await readFile(output, "utf8"), saved);
    assert.equal(run(["--check", "--output", context.record]).status, 1);
  });
});
