import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// The resolver is untyped JavaScript under scripts/, so it resolves as an implicit any.
import { resolveInstalledElectron } from "../../scripts/resolve-installed-electron.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const compiledStore = join(repositoryRoot, "electron-dist", "settings.js");

/*
 * The settings record is written by two callers: the settings screen, and the
 * debounced window geometry on every move and resize. Both are read-modify-write
 * of the same file, so the two failures this covers were both silent — a card that
 * sends one field wiped the others, and two overlapping writes each wrote back
 * the snapshot they took before the other one landed.
 *
 * The store reaches for `safeStorage`, so it can only be exercised inside a real
 * Electron process; the store itself is plain and has no other Electron coupling.
 */
const runner = `
const { app } = require("electron");
const { join } = require("node:path");
const { writeFileSync, readFileSync } = require("node:fs");
const { DesktopSettingsStore } = require(${JSON.stringify(compiledStore)});
const assert = require("node:assert/strict");

const root = __dirname;
const bounds = { x: 120, y: 80, width: 1180, height: 820 };

function finish(report, code) {
  writeFileSync(join(root, "report.json"), JSON.stringify(report));
  app.exit(code);
}

app.whenReady().then(async () => {
  const report = { encryptionAvailable: false, partialSave: null, concurrentWrites: null, extensionKeyStable: false, extensionKeyEncrypted: false, unreadableExtensionKeyIsolated: false, defaultLocale: null, savedLocale: null, invalidLocaleRejected: false, error: null };
  try {
    // Each case gets its own file: the first must not depend on what the second left.
    const systemFile = join(root, "system.json");
    for (const [languages, expected] of [[["zh-Hans-CN", "en-US"], "zh-CN"], [["zh-TW"], "zh-CN"], [["en-GB", "zh-CN"], "en-US"], [["fr-FR", "zh-CN"], "zh-CN"], [["fr-FR"], "en-US"], [[], "en-US"]]) {
      const system = new DesktopSettingsStore(systemFile, languages);
      assert.equal(system.getLocale(), expected);
      assert.equal((await system.getView()).locale, expected);
    }
    const automatic = new DesktopSettingsStore(systemFile, ["en-GB"]);
    await automatic.save({ closeBehaviour: "tray" });
    assert.equal(JSON.parse(readFileSync(systemFile, "utf8")).locale, undefined);
    assert.equal(new DesktopSettingsStore(systemFile, ["zh-CN"]).getLocale(), "zh-CN");
    await automatic.save({ locale: "en-US" });
    assert.equal(new DesktopSettingsStore(systemFile, ["zh-CN"]).getLocale(), "en-US");
    const preferred = app.getPreferredSystemLanguages().find(language => /^(zh|en)(-|$)/i.test(language));
    assert.equal(new DesktopSettingsStore(join(root, "native-system.json")).getLocale(), /^zh/i.test(preferred || "") ? "zh-CN" : "en-US");
    const card = new DesktopSettingsStore(join(root, "card.json"), ["zh-CN"]);
    await card.save({
      outboundProxyUrl: "http://proxy.internal:8080",
      openrouterSiteName: "Example Corp",
      openrouterHttpReferer: "https://example.invalid/app",
    });
    report.defaultLocale = (await card.getView()).locale;
    await card.save({ locale: "en-US" });
    // What the close-behaviour card and the hotkey picker each send on their own.
    await card.save({ closeBehaviour: "tray" });
    await card.save({ globalHotkey: "Ctrl+Shift+R" });
    report.partialSave = await card.getView();
    const reopenedCard = new DesktopSettingsStore(join(root, "card.json"));
    report.savedLocale = (await reopenedCard.getView()).locale;
    try { await card.save({ locale: "invalid" }); } catch { report.invalidLocaleRejected = (await card.getView()).locale === "en-US"; }

    const concurrent = new DesktopSettingsStore(join(root, "concurrent.json"));
    report.encryptionAvailable = (await concurrent.getView()).encryptionAvailable;
    if (report.encryptionAvailable) {
      // The credential path is the one that awaits mid-write, which is what makes
      // the two writers overlap: the snapshot is taken, then the write pauses on
      // encryption while the geometry write lands, then the stale snapshot returns.
      const savingKey = concurrent.save({ openrouterApiKey: "settings-store-regression-key" });
      await concurrent.saveWindowBounds(bounds);
      await savingKey;
      report.concurrentWrites = await concurrent.getView();
      const firstEnvironment = await concurrent.getServerEnvironment();
      const reopened = new DesktopSettingsStore(join(root, "concurrent.json"));
      const secondEnvironment = await reopened.getServerEnvironment();
      report.extensionKeyStable = Buffer.from(firstEnvironment.RIA_EXTENSION_KEY, "base64").length === 32 && firstEnvironment.RIA_EXTENSION_KEY === secondEnvironment.RIA_EXTENSION_KEY;
      report.extensionKeyEncrypted = !readFileSync(join(root, "concurrent.json"), "utf8").includes(firstEnvironment.RIA_EXTENSION_KEY) && !JSON.stringify(await reopened.getView()).includes(firstEnvironment.RIA_EXTENSION_KEY);
      const damagedFile = join(root, "damaged-extension-key.json");
      writeFileSync(damagedFile, JSON.stringify({ version: 1, encryptedExtensionKey: "not-a-valid-encrypted-key", openrouterSiteName: "Retained workspace" }));
      const damaged = new DesktopSettingsStore(damagedFile);
      report.unreadableExtensionKeyIsolated = (await damaged.getServerEnvironment()).RIA_EXTENSION_KEY === "" && (await damaged.getView()).openrouterSiteName === "Retained workspace" && JSON.parse(readFileSync(damagedFile, "utf8")).encryptedExtensionKey === "not-a-valid-encrypted-key";
    }
    finish(report, 0);
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    finish(report, 1);
  }
});
`;

test("a settings card that sends one field does not wipe the fields beside it", {
  timeout: 60_000,
}, () => {
  assert.ok(existsSync(compiledStore), "electron-dist must be compiled before this test runs");
  const root = mkdtempSync(join(tmpdir(), "private-ai-settings-card-"));
  try {
    const runnerFile = join(root, "runner.js");
    writeRunner(runnerFile);
    const result = spawnSync(resolveInstalledElectron(), [runnerFile], {
      // Electron helpers can briefly retain the working directory after exit.
      // The runner uses __dirname for data, so its disposable directory need not be cwd.
      cwd: repositoryRoot, env: electronEnvironment(), encoding: "utf8", windowsHide: true, timeout: 45_000,
    });
    assert.ifError(result.error);
    const report = readReport(root, result);
    assert.equal(report.error, null, `The settings store runner failed: ${report.error}\n${result.stderr || ""}`);
    assert.ok(report.partialSave, "The settings store produced no report");
    // Every one of these was normalised to an empty string by a save that never
    // mentioned it, so a proxied installation lost its proxy without an error.
    assert.equal(report.partialSave.outboundProxyUrl, "http://proxy.internal:8080/");
    assert.equal(report.partialSave.openrouterSiteName, "Example Corp");
    assert.equal(report.partialSave.openrouterHttpReferer, "https://example.invalid/app");
    // And the fields the cards did send still took.
    assert.equal(report.partialSave.closeBehaviour, "tray");
    assert.equal(report.partialSave.globalHotkey, "Ctrl+Shift+R");
    assert.equal(report.defaultLocale, "zh-CN");
    assert.equal(report.savedLocale, "en-US");
    assert.equal(report.partialSave.locale, "en-US");
    assert.equal(report.invalidLocaleRejected, true);
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir())) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});

test("a key save and a window-geometry save in flight together both survive", {
  timeout: 60_000,
}, () => {
  assert.ok(existsSync(compiledStore), "electron-dist must be compiled before this test runs");
  const root = mkdtempSync(join(tmpdir(), "private-ai-settings-race-"));
  try {
    const runnerFile = join(root, "runner.js");
    writeRunner(runnerFile);
    const result = spawnSync(resolveInstalledElectron(), [runnerFile], {
      cwd: repositoryRoot, env: electronEnvironment(), encoding: "utf8", windowsHide: true, timeout: 45_000,
    });
    assert.ifError(result.error);
    const report = readReport(root, result);
    assert.equal(report.error, null, `The settings store runner failed: ${report.error}\n${result.stderr || ""}`);
    if (!report.encryptionAvailable) return;
    assert.ok(report.concurrentWrites, "The settings store produced no concurrency report");
    assert.equal(report.concurrentWrites.hasOpenrouterApiKey, true);
    // Without serialising the writers, the geometry write lands during the
    // encryption and is then overwritten by the snapshot taken before it.
    assert.deepEqual(report.concurrentWrites.windowBounds, { x: 120, y: 80, width: 1180, height: 820 });
    assert.equal(report.extensionKeyStable, true);
    assert.equal(report.extensionKeyEncrypted, true);
    assert.equal(report.unreadableExtensionKeyIsolated, true);
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir())) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});

type SettingsReport = {
  defaultLocale: string | null;
  savedLocale: string | null;
  invalidLocaleRejected: boolean;
  error: string | null;
  encryptionAvailable: boolean;
  extensionKeyStable: boolean;
  extensionKeyEncrypted: boolean;
  unreadableExtensionKeyIsolated: boolean;
  partialSave: Record<string, never> | null;
  concurrentWrites: Record<string, never> | null;
};

function writeRunner(path: string) {
  writeFileSync(path, runner, "utf8");
}

function electronEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

function readReport(root: string, result: { stdout: string; stderr: string }): SettingsReport {
  const reportFile = join(root, "report.json");
  assert.ok(existsSync(reportFile), `Electron must report a result.\n${result.stdout || ""}\n${result.stderr || ""}`);
  return JSON.parse(readFileSync(reportFile, "utf8")) as SettingsReport;
}
