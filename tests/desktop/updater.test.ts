import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  compareVersions, installationRoot, launchInstaller, reconcileUpdateDirectory, UpdateService, verifyManifest,
  type UpdateManifest, type UpdateState,
} from "../../electron/updater";

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const keys = generateKeyPairSync("ed25519");
const publicKey = String(keys.publicKey.export({ type: "spki", format: "pem" }));
const installerBytes = Buffer.from("fake msi bytes ".repeat(4096));

function signed(fields: Partial<UpdateManifest> = {}, key: KeyObject = keys.privateKey) {
  const version = fields.version ?? "1.2.4";
  const payload = JSON.stringify({
    product: "RiA", version, platform: "win32", arch: "x64", filename: `RiA-${version}-x64.msi`,
    bytes: installerBytes.length, sha256: createHash("sha256").update(installerBytes).digest("hex"), ...fields,
  });
  return { payload, signature: sign(null, Buffer.from(payload), key).toString("base64") };
}

function temporary(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, remove: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

/** A response whose body arrives in pieces, optionally waiting on a gate between them. */
function streamed(bytes: Buffer, gate?: Promise<void>): Response {
  const pieces = [bytes.subarray(0, 1024), bytes.subarray(1024)];
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index === 1 && gate) await gate;
      if (index < pieces.length) controller.enqueue(new Uint8Array(pieces[index++]));
      else controller.close();
    },
  }));
}

function service(directory: string, options: { manifest?: unknown; installer?: () => Response; launch?: () => Promise<void>; status?: number } = {}) {
  const requests: string[] = [];
  const launched: unknown[] = [];
  const states: UpdateState[] = [];
  const updates = new UpdateService({
    supported: true, currentVersion: "1.2.3", directory, publicKey, logger: silent,
    manifestUrl: "https://updates.invalid/manifest.json",
    installerUrl: manifest => `https://updates.invalid/${manifest.filename}`,
    fetch: async (url, init) => {
      requests.push(url);
      if (url.endsWith("manifest.json")) {
        return options.status ? new Response("", { status: options.status }) : Response.json(options.manifest ?? signed());
      }
      init?.signal?.throwIfAborted();
      return options.installer?.() ?? streamed(installerBytes);
    },
    launch: async plan => { launched.push(plan); await options.launch?.(); },
    onChange: state => states.push(state),
  });
  return { updates, requests, launched, states };
}

test("release versions compare numerically and anything else is refused", () => {
  assert.equal(compareVersions("0.1.10", "0.1.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.2.0", "1.0.0"), -1);
  assert.throws(() => compareVersions("1.0.0-beta", "1.0.0"));
});

test("a manifest is accepted only with a valid signature and consistent fields", () => {
  assert.equal(verifyManifest(signed(), publicKey).version, "1.2.4");
  const tampered = signed();
  tampered.payload = tampered.payload.replace("1.2.4", "9.9.9");
  assert.throws(() => verifyManifest(tampered, publicKey), /signature/);
  assert.throws(() => verifyManifest(signed({}, generateKeyPairSync("ed25519").privateKey), publicKey), /signature/);
  // Signed, but the file name would not be the one the version implies.
  assert.throws(() => verifyManifest(signed({ filename: "..\\..\\evil.msi" }), publicKey), /name/);
  assert.throws(() => verifyManifest(signed({ product: "Other" as "RiA" }), publicKey), /product/);
  assert.throws(() => verifyManifest(signed({ sha256: "abc" }), publicKey), /checksum/);
  assert.throws(() => verifyManifest({ payload: 1 }, publicKey), /malformed/);
});

test("a check offers only a newer verified release and shares one request", async () => {
  const folder = temporary("ria-update-check-");
  try {
    const newer = service(folder.root);
    const [first, second] = await Promise.all([newer.updates.check(), newer.updates.check()]);
    assert.equal(newer.requests.length, 1);
    assert.equal(first.phase, "available");
    assert.equal(second.availableVersion, "1.2.4");

    for (const version of ["1.2.3", "1.2.2"]) {
      const same = service(folder.root, { manifest: signed({ version }) });
      assert.equal((await same.updates.check()).phase, "current");
    }
    // Nothing published yet is not a failure.
    const none = service(folder.root, { status: 404 });
    assert.deepEqual([(await none.updates.check()).phase, none.updates.getState().failure], ["current", null]);

    const forged = signed();
    forged.payload = forged.payload.replace("1.2.4", "2.0.0");
    const rejected = service(folder.root, { manifest: forged });
    const state = await rejected.updates.check();
    assert.deepEqual([state.phase, state.failure, state.availableVersion], ["idle", "verification", null]);

    const offline = service(folder.root, { status: 503 });
    assert.equal((await offline.updates.check()).failure, "network");
  } finally {
    folder.remove();
  }
});

test("a download is kept only when its bytes match the manifest", async () => {
  const folder = temporary("ria-update-download-");
  try {
    const good = service(folder.root);
    await good.updates.check();
    const ready = await good.updates.startDownload();
    assert.equal(ready.phase, "ready");
    assert.deepEqual(readdirSync(folder.root), ["RiA-1.2.4-x64.msi"]);
    assert.ok(good.states.some(state => state.phase === "downloading" && state.received > 0 && state.received < state.total));

    for (const body of [Buffer.from("x".repeat(installerBytes.length)), Buffer.concat([installerBytes, Buffer.from("extra")])]) {
      rmSync(folder.root, { recursive: true, force: true });
      const bad = service(folder.root, { installer: () => streamed(body) });
      await bad.updates.check();
      const state = await bad.updates.startDownload();
      assert.deepEqual([state.phase, state.failure], ["available", "verification"]);
      assert.deepEqual(readdirSync(folder.root), [], "a rejected download leaves nothing behind");
    }
  } finally {
    folder.remove();
  }
});

test("a cancelled download is removed and cannot report afterwards", async () => {
  const folder = temporary("ria-update-cancel-");
  try {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const run = service(folder.root, { installer: () => streamed(installerBytes, gate) });
    await run.updates.check();
    const downloading = run.updates.startDownload();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(run.updates.getState().phase, "downloading");
    assert.equal(run.updates.cancelDownload().phase, "available");
    const changes = run.states.length;
    release();
    const settled = await downloading;
    assert.deepEqual([settled.phase, settled.failure], ["available", null]);
    assert.equal(run.states.length, changes, "the cancelled download changed the state after it was cancelled");
    assert.deepEqual(readdirSync(folder.root), []);
  } finally {
    folder.remove();
  }
});

test("installing re-verifies the download, records the attempt and hands over the paths", async () => {
  const folder = temporary("ria-update-install-");
  try {
    const run = service(folder.root);
    await run.updates.check();
    await run.updates.startDownload();
    const state = await run.updates.install();
    assert.equal(state.phase, "installing");
    assert.deepEqual(run.launched, [{
      installer: join(folder.root, "RiA-1.2.4-x64.msi"),
      installLog: join(folder.root, "install.log"),
      resultFile: join(folder.root, "install-result.json"),
    }]);
    assert.equal(JSON.parse(readFileSync(join(folder.root, "pending.json"), "utf8")).version, "1.2.4");

    // The file changed on disk between download and install.
    rmSync(folder.root, { recursive: true, force: true });
    const swapped = service(folder.root);
    await swapped.updates.check();
    await swapped.updates.startDownload();
    writeFileSync(join(folder.root, "RiA-1.2.4-x64.msi"), "replaced");
    const refused = await swapped.updates.install();
    assert.deepEqual([refused.phase, refused.failure, swapped.launched.length], ["available", "verification", 0]);
    assert.deepEqual(readdirSync(folder.root), []);

    // The installer step could not be started: the download is kept for another try.
    rmSync(folder.root, { recursive: true, force: true });
    const blocked = service(folder.root, { launch: async () => { throw new Error("blocked"); } });
    await blocked.updates.check();
    await blocked.updates.startDownload();
    const failed = await blocked.updates.install();
    assert.deepEqual([failed.phase, failed.failure], ["ready", "install"]);
    assert.deepEqual(readdirSync(folder.root), ["RiA-1.2.4-x64.msi"]);
  } finally {
    folder.remove();
  }
});

test("one request downloads and installs, and a cancelled download installs nothing", async () => {
  const folder = temporary("ria-update-apply-");
  try {
    const run = service(folder.root);
    await run.updates.check();
    const state = await run.updates.apply();
    assert.equal(state.phase, "installing");
    assert.equal(run.launched.length, 1);
    assert.deepEqual(run.states.map(item => item.phase).filter((phase, index, all) => phase !== all[index - 1]),
      ["checking", "available", "downloading", "ready", "installing"]);

    rmSync(folder.root, { recursive: true, force: true });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cancelled = service(folder.root, { installer: () => streamed(installerBytes, gate) });
    await cancelled.updates.check();
    const applying = cancelled.updates.apply();
    await new Promise(resolve => setTimeout(resolve, 50));
    cancelled.updates.cancelDownload();
    release();
    assert.equal((await applying).phase, "available");
    assert.equal(cancelled.launched.length, 0);

    // A failed install keeps the verified download, and asking again retries the install alone.
    rmSync(folder.root, { recursive: true, force: true });
    let attempts = 0;
    const retried = service(folder.root, { launch: async () => { if (++attempts === 1) throw new Error("blocked"); } });
    await retried.updates.check();
    assert.deepEqual([(await retried.updates.apply()).phase, retried.updates.getState().failure], ["ready", "install"]);
    assert.equal((await retried.updates.apply()).phase, "installing");
    assert.equal(retried.requests.filter(url => url.endsWith(".msi")).length, 1);
  } finally {
    folder.remove();
  }
});

test("the update folder is emptied at start-up and the outcome of the last install is reported", async () => {
  const folder = temporary("ria-update-reconcile-");
  try {
    const directory = join(folder.root, "updates");
    const logs = join(folder.root, "logs");
    mkdirSync(logs);
    const prepare = (files: Record<string, string>) => {
      mkdirSync(directory, { recursive: true });
      for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
    };
    const reconcile = (currentVersion: string) => reconcileUpdateDirectory({ directory, currentVersion, logsDirectory: logs, logger: silent });

    prepare({ "pending.json": '{"version":"1.2.4"}', "install-result.json": '{"exitCode":0}', "install.log": "ok" });
    assert.deepEqual(await reconcile("1.2.4"), { outcome: "installed", version: "1.2.4" });
    assert.equal(existsSync(directory), false);

    // PowerShell may write a byte-order mark.
    prepare({ "pending.json": '{"version":"1.2.4"}', "install-result.json": '\uFEFF{"exitCode":1602}', "install.log": "cancelled" });
    assert.deepEqual(await reconcile("1.2.3"), { outcome: "cancelled", version: "1.2.4" });
    assert.equal(existsSync(directory), false);

    prepare({ "pending.json": '{"version":"1.2.4"}', "install-result.json": '{"exitCode":1603}', "install.log": "failure details" });
    assert.deepEqual(await reconcile("1.2.3"), { outcome: "failed", version: "1.2.4", exitCode: 1603, logFile: join(logs, "update-install.log") });
    assert.equal(readFileSync(join(logs, "update-install.log"), "utf8"), "failure details");
    assert.equal(existsSync(directory), false);

    // The installer step never ran.
    prepare({ "pending.json": '{"version":"1.2.4"}' });
    assert.deepEqual(await reconcile("1.2.3"), { outcome: "failed", version: "1.2.4", exitCode: null, logFile: null });

    prepare({ "RiA-1.2.4-x64.msi.partial": "half", "RiA-1.2.4-x64.msi": "never installed" });
    assert.equal(await reconcile("1.2.3"), null);
    assert.equal(existsSync(directory), false);
    assert.equal(await reconcile("1.2.3"), null, "a missing folder is the normal case");
  } finally {
    folder.remove();
  }
});

test("the installation root is the folder above the versioned application folder", () => {
  assert.equal(installationRoot(join("D:\\Apps\\RiA", "app-0.1.15", "RiA.exe")), join("D:\\Apps\\RiA"));
  assert.equal(installationRoot(join("D:\\Portable", "RiA.exe")), join("D:\\Portable"));
});

test("the installer step, started as the application starts it, waits for the app, removes the installer, records the result and restarts the app", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  // A quote, spaces and characters outside the ANSI code page in every path the script has to carry.
  const folder = temporary("ria update it's 更新-");
  try {
    const root = join(folder.root, "Install Root");
    mkdirSync(root);
    const installer = join(folder.root, "RiA-1.2.4-x64.msi");
    writeFileSync(installer, "installer");
    // Records the arguments it received as UTF-8, as Windows Installer receives them: as Unicode.
    const fakeInstaller = join(folder.root, "fake installer.cmd");
    writeFileSync(join(folder.root, "record.js"), `require("node:fs").writeFileSync(require("node:path").join(__dirname, "arguments.json"), JSON.stringify(process.argv.slice(2))); process.exit(1603);`);
    writeFileSync(fakeInstaller, `@"${process.execPath}" "%~dp0record.js" %*\r\n@exit /b %ERRORLEVEL%\r\n`);
    const relaunch = join(root, "relaunch.cmd");
    writeFileSync(relaunch, `@echo relaunched> "%~dp0relaunched.txt"\r\n`);
    const application = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], { stdio: "ignore", windowsHide: true });
    const exited = new Promise<number>(resolve => application.once("exit", () => resolve(Date.now())));
    // Detached through Windows Script Host, exactly as the application starts it:
    // a detached PowerShell started this way once exited without running anything.
    await launchInstaller({
      installer, installLog: join(folder.root, "install.log"), resultFile: join(folder.root, "install-result.json"),
      installRoot: root, relaunch, waitForPid: application.pid!,
    }, { directory: folder.root, system: join(process.env.SystemRoot || "C:\\Windows", "System32"), installer: { program: fakeInstaller, window: 0 } });
    const resultFile = join(folder.root, "install-result.json");
    const finished = Date.now() + 30_000;
    while (!existsSync(resultFile) && Date.now() < finished) await new Promise(resolve => setTimeout(resolve, 100));
    const applicationExit = await exited;

    const argumentsFile = join(folder.root, "arguments.json");
    assert.ok(statSync(argumentsFile).mtimeMs >= applicationExit - 50, "the installer ran before the application exited");
    assert.deepEqual(JSON.parse(readFileSync(argumentsFile, "utf8")),
      ["/i", installer, "/passive", "/norestart", "/L*V", join(folder.root, "install.log"), `APPLICATIONROOTDIRECTORY=${root}`]);
    assert.deepEqual(JSON.parse(readFileSync(join(folder.root, "install-result.json"), "utf8")), { exitCode: 1603 });
    assert.equal(existsSync(installer), false, "the installer was not deleted after the installation");
    const deadline = Date.now() + 15_000;
    while (!existsSync(join(root, "relaunched.txt")) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(existsSync(join(root, "relaunched.txt")), "the application was not started again");
  } finally {
    folder.remove();
  }
});
