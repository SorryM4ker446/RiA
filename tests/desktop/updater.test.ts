import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  compareVersions, diskFullVolume, installationRoot, launchInstaller, reconcileUpdateDirectory, removeEmptyVersionFolders, updateSpaceNeeds, UpdateService, verifyManifest, volumeOf,
  type UpdateManifest, type UpdateState,
} from "../../electron/updater";
import type { DesktopLogger } from "../../electron/logger";

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

function service(directory: string, options: { manifest?: unknown; installer?: () => Response; launch?: () => Promise<void>; status?: number; freeSpace?: (path: string) => Promise<number>; logger?: DesktopLogger } = {}) {
  const requests: string[] = [];
  const launched: unknown[] = [];
  const states: UpdateState[] = [];
  const updates = new UpdateService({
    supported: true, currentVersion: "1.2.3", directory, publicKey, logger: options.logger ?? silent,
    installerCacheDirectory: join(directory, "..", "installer-cache"),
    freeSpace: options.freeSpace ?? (async () => Number.MAX_SAFE_INTEGER),
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

test("an update needs its download's size where it is saved and two package copies plus headroom on the system volume", () => {
  const megabytes = (count: number) => count * 1024 * 1024;
  const bytes = megabytes(223), headroom = megabytes(128);
  // The default case: the download in %TEMP% and Windows Installer's copies both on C:.
  assert.deepEqual([...updateSpaceNeeds({ downloadDirectory: "C:\\Users\\u\\AppData\\Local\\Temp\\RiA-updates", installerCacheDirectory: "C:\\Windows\\Installer", bytes, downloaded: false })],
    [["C:", bytes * 3 + headroom]]);
  assert.deepEqual([...updateSpaceNeeds({ downloadDirectory: "D:\\temp\\RiA-updates", installerCacheDirectory: "c:\\windows\\Installer", bytes, downloaded: false })],
    [["D:", bytes], ["C:", bytes * 2 + headroom]]);
  // A finished download already occupies its space.
  assert.deepEqual([...updateSpaceNeeds({ downloadDirectory: "C:\\temp", installerCacheDirectory: "C:\\Windows\\Installer", bytes, downloaded: true })],
    [["C:", bytes * 2 + headroom]]);
  assert.equal(volumeOf("e:\\RiA\\app-0.1.18"), "E:");
});

test("an update the disk cannot take is refused before the download and again before the installer runs", async () => {
  const folder = temporary("ria-update-space-");
  try {
    let free = 0;
    const run = service(folder.root, { freeSpace: async () => free });
    await run.updates.check();
    const refused = await run.updates.apply();
    assert.deepEqual([refused.phase, refused.failure, refused.shortfall?.volume, refused.shortfall?.available], ["available", "space", volumeOf(folder.root), 0]);
    assert.ok(refused.shortfall!.required > installerBytes.length * 3);
    assert.equal(run.requests.filter(url => url.endsWith(".msi")).length, 0, "nothing is downloaded");

    // Space freed: the download goes ahead; space used up again before installing: the verified download is kept.
    free = Number.MAX_SAFE_INTEGER;
    assert.deepEqual([(await run.updates.startDownload()).phase, run.updates.getState().shortfall], ["ready", null]);
    free = 1024;
    const held = await run.updates.install();
    assert.deepEqual([held.phase, held.failure, held.shortfall?.available, run.launched.length], ["ready", "space", 1024, 0]);
    assert.deepEqual(readdirSync(folder.root), ["RiA-1.2.4-x64.msi"], "no install attempt is recorded");

    free = Number.MAX_SAFE_INTEGER;
    const installed = await run.updates.apply();
    assert.deepEqual([installed.phase, installed.failure, installed.shortfall, run.launched.length], ["installing", null, null, 1]);
    assert.equal(run.requests.filter(url => url.endsWith(".msi")).length, 1, "the retry reuses the download");

    // Free space that cannot be read does not stand in the way.
    rmSync(folder.root, { recursive: true, force: true });
    const unknown = service(folder.root, { freeSpace: async () => { throw new Error("unavailable"); } });
    await unknown.updates.check();
    assert.equal((await unknown.updates.apply()).phase, "installing");
  } finally {
    folder.remove();
  }
});

test("a Windows Installer log is read for the drive that ran out of space, in either of its encodings", () => {
  const utf16 = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  assert.equal(diskFullVolume(utf16("MSI (s) (24:00) [07:55:07:913]: Note: 1: 1601 2: C: 3: 218,345 4: 208,524 \r\n")), "C:");
  assert.equal(diskFullVolume(utf16("MSI (s) (88:30) [08:10:45:426]: Note: 1: 1307 2: e:\\RiA\\app-0.1.18\\RiA.exe \r\n")), "E:");
  assert.equal(diskFullVolume(Buffer.from("Note: 1: 1307 2: D:\\x.msi")), "D:");
  // Other notes, and messages in the installer's language, are not read as a full disk.
  assert.equal(diskFullVolume(utf16("Note: 1: 2205 2:  3: Error \r\nNote: 1: 1402 2: HKEY_LOCAL_MACHINE\\Software 3: 2 \r\n磁盘空间不足")), null);
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
    assert.deepEqual(await reconcile("1.2.3"), { outcome: "failed", version: "1.2.4", exitCode: 1603, logFile: join(logs, "update-install.log"), diskFull: null });
    assert.equal(readFileSync(join(logs, "update-install.log"), "utf8"), "failure details");
    assert.equal(existsSync(directory), false);

    // Windows Installer's own UTF-16 log says which drive ran out of space while it cached the package.
    const msiLog = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "pending.json"), '{"version":"1.2.4"}');
    writeFileSync(join(directory, "install-result.json"), '{"exitCode":1603}');
    writeFileSync(join(directory, "install.log"), msiLog("MSI (s) (88:30) [08:10:45:426]: Note: 1: 1307 2: C:\\WINDOWS\\Installer\\215fe321.msi \r\n"));
    assert.deepEqual(await reconcile("1.2.3"), { outcome: "failed", version: "1.2.4", exitCode: 1603, logFile: join(logs, "update-install.log"), diskFull: "C:" });

    // The installer step never ran.
    prepare({ "pending.json": '{"version":"1.2.4"}' });
    assert.deepEqual(await reconcile("1.2.3"), { outcome: "failed", version: "1.2.4", exitCode: null, logFile: null, diskFull: null });

    prepare({ "RiA-1.2.4-x64.msi.partial": "half", "RiA-1.2.4-x64.msi": "never installed" });
    assert.equal(await reconcile("1.2.3"), null);
    assert.equal(existsSync(directory), false);
    assert.equal(await reconcile("1.2.3"), null, "a missing folder is the normal case");
  } finally {
    folder.remove();
  }
});

test("empty folders of replaced versions are removed beside the running one, and nothing else", async () => {
  const folder = temporary("ria-version-folders-");
  try {
    const root = folder.root;
    const make = (path: string, file?: string) => { mkdirSync(join(root, path), { recursive: true }); if (file) writeFileSync(join(root, path, file), "kept"); };
    make("app-1.2.3", "RiA.exe");        // the running version
    make("app-1.2.2");                   // left empty by an upgrade
    make("APP-1.2.1");                   // the same, in another case
    make("app-1.2.0", "notes.txt");      // still holds something
    make("app-1.1.9/resources");         // not empty either
    make("backup");                      // not a version folder
    const logged: unknown[][] = [];
    const logger = { ...silent, info: (...args: unknown[]) => { logged.push(args); } };
    const removed = await removeEmptyVersionFolders(join(root, "app-1.2.3", "RiA.exe"), logger);
    assert.deepEqual(removed.map(path => path.slice(root.length + 1)).sort(), ["APP-1.2.1", "app-1.2.2"]);
    assert.deepEqual(readdirSync(root).sort(), ["app-1.1.9", "app-1.2.0", "app-1.2.3", "backup"]);
    assert.equal(logged.length, 1);
    // Outside a versioned folder (a development run) nothing is looked at.
    make("app-0.0.1");
    assert.deepEqual(await removeEmptyVersionFolders(join(root, "RiA.exe"), logger), []);
    assert.ok(existsSync(join(root, "app-0.0.1")));
  } finally {
    folder.remove();
  }
});

test("every step of an update is written to the desktop log", async () => {
  const folder = temporary("ria-update-log-");
  try {
    const messages: string[] = [];
    const record = (level: string) => (message: string) => { messages.push(`${level} ${message}`); };
    const logger = { info: record("info"), warn: record("warn"), error: record("error") };
    const run = service(folder.root, { logger });
    await run.updates.check();
    await run.updates.apply();
    assert.deepEqual(messages, [
      "info Update available", "info Downloading update", "info Update downloaded and verified", "info Update handed to Windows Installer",
    ]);

    messages.length = 0;
    rmSync(folder.root, { recursive: true, force: true });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cancelled = service(folder.root, { logger, installer: () => streamed(installerBytes, gate) });
    await cancelled.updates.check();
    const applying = cancelled.updates.apply();
    await new Promise(resolve => setTimeout(resolve, 50));
    cancelled.updates.cancelDownload();
    release();
    await applying;
    assert.deepEqual(messages, ["info Update available", "info Downloading update", "info Update download cancelled"]);

    messages.length = 0;
    const current = service(folder.root, { logger, manifest: signed({ version: "1.2.3" }) });
    await current.updates.check();
    assert.deepEqual(messages, ["info Update check: up to date"]);
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
    writeFileSync(join(folder.root, "record.js"), `const { writeFileSync } = require("node:fs"), { join } = require("node:path"); writeFileSync(join(__dirname, "arguments.json"), JSON.stringify(process.argv.slice(2))); writeFileSync(join(__dirname, "cwd.txt"), process.cwd()); process.exit(1603);`);
    writeFileSync(fakeInstaller, `@"${process.execPath}" "%~dp0record.js" %*\r\n@exit /b %ERRORLEVEL%\r\n`);
    const relaunch = join(root, "relaunch.cmd");
    writeFileSync(relaunch, `@echo relaunched> "%~dp0relaunched.txt"\r\n`);
    const system = join(process.env.SystemRoot || "C:\\Windows", "System32");
    const application = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], { stdio: "ignore", windowsHide: true });
    const exited = new Promise<number>(resolve => application.once("exit", () => resolve(Date.now())));
    // Detached through Windows Script Host, exactly as the application starts it:
    // a detached PowerShell started this way once exited without running anything.
    await launchInstaller({
      installer, installLog: join(folder.root, "install.log"), resultFile: join(folder.root, "install-result.json"),
      installRoot: root, relaunch, waitForPid: application.pid!,
    }, { directory: folder.root, system, installer: { program: fakeInstaller, window: 0 } });
    // Starting the application again is the step's last action, so its effect is the signal
    // that everything before it has happened. The result file is not: the installer is
    // deleted after that file appears.
    const relaunched = join(root, "relaunched.txt");
    const finished = Date.now() + 45_000;
    while (!existsSync(relaunched) && Date.now() < finished) await new Promise(resolve => setTimeout(resolve, 100));
    const applicationExit = await exited;
    assert.ok(existsSync(relaunched), "the application was not started again");

    const argumentsFile = join(folder.root, "arguments.json");
    assert.ok(statSync(argumentsFile).mtimeMs >= applicationExit - 50, "the installer ran before the application exited");
    assert.deepEqual(JSON.parse(readFileSync(argumentsFile, "utf8")),
      ["/i", installer, "/passive", "/norestart", "/L*V", join(folder.root, "install.log"), `APPLICATIONROOTDIRECTORY=${root}`]);
    assert.deepEqual(JSON.parse(readFileSync(join(folder.root, "install-result.json"), "utf8")), { exitCode: 1603 });
    // Not the application's folder: a process's current directory cannot be removed, so an inherited one survived the upgrade.
    assert.equal(readFileSync(join(folder.root, "cwd.txt"), "utf8").toLowerCase(), system.toLowerCase());
    assert.equal(existsSync(installer), false, "the installer was not deleted after the installation");
  } finally {
    folder.remove();
  }
});
