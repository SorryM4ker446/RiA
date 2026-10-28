import { spawn } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { DesktopLogger } from "./logger";

export const UPDATE_REPOSITORY = "SorryM4ker446/RiA";
export const UPDATE_MANIFEST_URL = `https://github.com/${UPDATE_REPOSITORY}/releases/latest/download/update-manifest.json`;
export const installerUrl = (manifest: UpdateManifest) =>
  `https://github.com/${UPDATE_REPOSITORY}/releases/download/v${manifest.version}/${manifest.filename}`;

export type UpdateManifest = { product: "RiA"; version: string; platform: "win32"; arch: "x64"; filename: string; bytes: number; sha256: string };

export type UpdatePhase = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "installing";
export type UpdateFailure = "network" | "verification" | "install";
/** What became of the update the previous run handed to Windows Installer. */
export type PreviousInstall =
  | { outcome: "installed"; version: string }
  | { outcome: "cancelled"; version: string }
  | { outcome: "failed"; version: string; exitCode: number | null; logFile: string | null };

export type UpdateState = {
  supported: boolean;
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  checkedAt: string | null;
  received: number;
  total: number;
  /** The last action that failed, cleared when the next one starts. */
  failure: UpdateFailure | null;
  previousInstall: PreviousInstall | null;
};

/** Everything the installer step needs, so the script that runs it can be built and tested on its own. */
export type InstallPlan = {
  installer: string;
  installLog: string;
  resultFile: string;
  /** The installation root, kept on upgrade instead of the installer's default. */
  installRoot: string;
  /** Started again once the installer has finished, whatever its outcome. */
  relaunch: string;
  waitForPid: number;
};

class VerificationError extends Error {}

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024;
const DOWNLOAD_STALL_MS = 60_000;
const USER_CANCELLED = 1602;
const PENDING_FILE = "pending.json";
const RESULT_FILE = "install-result.json";
const INSTALL_LOG = "install.log";
const LAUNCHER_FILE = "install.js";

export function compareVersions(left: string, right: string): number {
  const a = VERSION.exec(left), b = VERSION.exec(right);
  if (!a || !b) throw new VerificationError(`Not a release version: ${a ? right : left}`);
  for (let index = 1; index <= 3; index++) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/**
 * The release a signed manifest describes, or a refusal.
 *
 * The signature covers the payload string exactly as published. The fields are
 * checked after it verifies, and the file name is required to be the one the
 * version implies, because it later becomes a path on disk.
 */
export function verifyManifest(document: unknown, publicKeyPem: string): UpdateManifest {
  const { payload, signature } = (document ?? {}) as { payload?: unknown; signature?: unknown };
  if (typeof payload !== "string" || typeof signature !== "string") throw new VerificationError("The update manifest is malformed.");
  const signed = verify(null, Buffer.from(payload, "utf8"), createPublicKey(publicKeyPem), Buffer.from(signature, "base64"));
  if (!signed) throw new VerificationError("The update manifest signature is invalid.");
  let manifest: Partial<UpdateManifest>;
  try { manifest = JSON.parse(payload) as Partial<UpdateManifest>; }
  catch { throw new VerificationError("The update manifest payload is not JSON."); }
  const { product, version, platform, arch, filename, bytes, sha256 } = manifest;
  if (product !== "RiA" || platform !== "win32" || arch !== "x64") throw new VerificationError("The update is for another product or platform.");
  if (typeof version !== "string" || !VERSION.test(version)) throw new VerificationError("The update version is invalid.");
  if (filename !== `RiA-${version}-x64.msi`) throw new VerificationError("The installer name does not match the version.");
  if (!Number.isSafeInteger(bytes) || bytes! <= 0 || bytes! > MAX_INSTALLER_BYTES) throw new VerificationError("The installer size is invalid.");
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) throw new VerificationError("The installer checksum is invalid.");
  return { product, version, platform, arch, filename, bytes: bytes!, sha256 };
}

async function fileDigest(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk as Buffer); bytes += (chunk as Buffer).length; }
  return { bytes, sha256: hash.digest("hex") };
}

/**
 * The installation root of a packaged copy: the installer places the executable
 * in an `app-<version>` folder beneath it, beside a launcher of the same name.
 */
export function installationRoot(executable: string): string {
  const folder = dirname(executable);
  return /^app-\d+\.\d+\.\d+$/i.test(basename(folder)) ? dirname(folder) : folder;
}

/** How Windows Installer is started and shown; tests pass a stand-in that runs unseen. */
export type InstallerProgram = { program: string; window: 0 | 1 };

/**
 * The script Windows Script Host runs to install the update once this process has gone.
 *
 * It waits for the application to exit, so Windows Installer never finds the running
 * copy's files in use, then runs the installer in its own progress window and waits
 * for it. Whatever the outcome, it records the exit code for the next start, deletes
 * the downloaded installer (Windows Installer keeps its own cached copy) and starts
 * the application again, so a cancelled elevation prompt returns the user to the
 * version they had.
 */
export function installLauncher(plan: InstallPlan, installer: InstallerProgram = { program: "msiexec.exe", window: 1 }): string {
  // JSON string literals are valid JScript string literals. Windows paths cannot
  // contain a double quote, so the command lines need no further escaping.
  const literal = (value: string | number) => JSON.stringify(value);
  const command = `"${installer.program}" /i "${plan.installer}" /passive /norestart /L*V "${plan.installLog}" APPLICATIONROOTDIRECTORY="${plan.installRoot}"`;
  return [
    'var shell = new ActiveXObject("WScript.Shell");',
    'var files = new ActiveXObject("Scripting.FileSystemObject");',
    `var processes = GetObject(${literal(String.raw`winmgmts:{impersonationLevel=impersonate}!\\.\root\cimv2`)});`,
    "var deadline = new Date().getTime() + 120000;",
    `while (new Date().getTime() < deadline && processes.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId = " + ${literal(Math.trunc(plan.waitForPid))}).Count > 0) WScript.Sleep(200);`,
    "var code = -1;",
    `try { code = shell.Run(${literal(command)}, ${installer.window}, true); } catch (error) {}`,
    `try { var result = files.CreateTextFile(${literal(plan.resultFile)}, true); result.Write('{"exitCode":' + code + '}'); result.Close(); } catch (error) {}`,
    `try { files.DeleteFile(${literal(plan.installer)}, true); } catch (error) {}`,
    `try { shell.Run(${literal(`"${plan.relaunch}"`)}, 1, false); } catch (error) {}`,
  ].join("\r\n");
}

/**
 * Starts the installer step so that it outlives this process.
 *
 * Through Windows Script Host rather than a detached PowerShell: started hidden
 * from the application, PowerShell has no console and exits before running
 * anything, so no installation ever began. wscript.exe needs no console, shows no
 * window, and keeps running after the application quits. The script is written
 * as UTF-16 with a byte-order mark, which Windows Script Host reads as Unicode, so
 * paths outside the ANSI code page survive.
 */
export async function launchInstaller(plan: InstallPlan, options: { directory: string; system: string; installer?: InstallerProgram }): Promise<void> {
  const launcher = join(options.directory, LAUNCHER_FILE);
  await writeFile(launcher, `\ufeff${installLauncher(plan, options.installer)}`, "utf16le");
  const child = spawn(join(options.system, "wscript.exe"), ["//B", "//Nologo", "//E:jscript", launcher], { detached: true, stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

/**
 * Settles the update directory at start-up, before anything else uses it.
 *
 * Whatever the previous run left — a finished installer's leftovers, a partial
 * download, an installer that was never run — none of it is needed by the time
 * the application is running again, so the directory is emptied every time. The
 * one thing worth keeping is the installer log of an update that failed, which is
 * moved beside the application logs, replacing the previous one.
 */
export async function reconcileUpdateDirectory(input: { directory: string; currentVersion: string; logsDirectory: string; logger: DesktopLogger }): Promise<PreviousInstall | null> {
  const { directory, currentVersion, logsDirectory, logger } = input;
  let previous: PreviousInstall | null = null;
  try {
    const pending = JSON.parse(await readFile(join(directory, PENDING_FILE), "utf8")) as { version?: unknown };
    const version = typeof pending.version === "string" && VERSION.test(pending.version) ? pending.version : null;
    if (version) {
      const exitCode = await readFile(join(directory, RESULT_FILE), "utf8")
        .then(text => (JSON.parse(text.replace(/^﻿/, "")) as { exitCode?: unknown }).exitCode)
        .then(code => (Number.isInteger(code) ? code as number : null), () => null);
      if (compareVersions(currentVersion, version) >= 0) previous = { outcome: "installed", version };
      else if (exitCode === USER_CANCELLED) previous = { outcome: "cancelled", version };
      else {
        const kept = join(logsDirectory, "update-install.log");
        const logFile = await copyFile(join(directory, INSTALL_LOG), kept).then(() => kept, () => null);
        previous = { outcome: "failed", version, exitCode, logFile };
      }
    }
  } catch {
    // No record of an install: whatever is there is a download that never ran.
  }
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    logger.warn("Could not remove the update download directory", error);
  }
  if (previous) logger.info("Previous update outcome", previous);
  return previous;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Finds, downloads and hands over one update at a time.
 *
 * Each check, download and install is a single flight: a second request joins
 * the one under way rather than starting another, and work that has been
 * cancelled or superseded can no longer change the state. Nothing is installed
 * without a request from the user, and nothing is offered unless its manifest
 * verifies and its version is newer than the running one.
 */
export class UpdateService {
  private state: UpdateState;
  private checking: Promise<UpdateState> | null = null;
  private manifest: UpdateManifest | null = null;
  private installer: string | null = null;
  private download: AbortController | null = null;

  constructor(private readonly options: {
    supported: boolean;
    currentVersion: string;
    directory: string;
    publicKey: string;
    fetch: Fetch;
    logger: DesktopLogger;
    launch: (plan: Omit<InstallPlan, "waitForPid" | "installRoot" | "relaunch">) => Promise<void>;
    onChange: (state: UpdateState) => void;
    previousInstall?: PreviousInstall | null;
    manifestUrl?: string;
    installerUrl?: (manifest: UpdateManifest) => string;
  }) {
    this.state = {
      supported: options.supported, phase: "idle", currentVersion: options.currentVersion, availableVersion: null,
      checkedAt: null, received: 0, total: 0, failure: null, previousInstall: options.previousInstall ?? null,
    };
  }

  getState(): UpdateState { return { ...this.state }; }

  private update(change: Partial<UpdateState>) {
    this.state = { ...this.state, ...change };
    this.options.onChange(this.getState());
  }

  /** Whether a check may replace what is known: never while a found update is being downloaded or installed. */
  private settled() {
    return this.state.phase !== "downloading" && this.state.phase !== "ready" && this.state.phase !== "installing";
  }

  check(): Promise<UpdateState> {
    if (!this.options.supported || !this.settled()) return Promise.resolve(this.getState());
    this.checking ??= this.runCheck().finally(() => { this.checking = null; });
    return this.checking;
  }

  private async runCheck(): Promise<UpdateState> {
    const before = this.state.phase;
    this.update({ phase: "checking", failure: null });
    try {
      const response = await this.options.fetch(this.options.manifestUrl ?? UPDATE_MANIFEST_URL, { signal: AbortSignal.timeout(20_000), cache: "no-store", redirect: "follow" });
      // No published release, or one without a manifest, offers nothing.
      if (response.status === 404) {
        this.manifest = null;
        this.update({ phase: "current", availableVersion: null, checkedAt: new Date().toISOString() });
        return this.getState();
      }
      if (!response.ok) throw new Error(`Update manifest request failed (${response.status})`);
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new VerificationError("The update manifest is too large.");
      let document: unknown;
      try { document = JSON.parse(text); } catch { throw new VerificationError("The update manifest is not JSON."); }
      const manifest = verifyManifest(document, this.options.publicKey);
      const newer = compareVersions(manifest.version, this.options.currentVersion) > 0;
      this.manifest = newer ? manifest : null;
      this.update({ phase: newer ? "available" : "current", availableVersion: newer ? manifest.version : null, checkedAt: new Date().toISOString() });
    } catch (error) {
      const failure = error instanceof VerificationError ? "verification" : "network";
      this.options.logger.warn("Update check failed", error instanceof Error ? error.message : error);
      this.update({ phase: before === "checking" ? "idle" : before, failure });
    }
    return this.getState();
  }

  /** Starts the download of the offered update; the returned promise settles when it ends. */
  async startDownload(): Promise<UpdateState> {
    const manifest = this.manifest;
    if (this.state.phase !== "available" || !manifest) return this.getState();
    const controller = new AbortController();
    this.download = controller;
    const final = join(this.options.directory, manifest.filename);
    const partial = `${final}.partial`;
    this.update({ phase: "downloading", failure: null, received: 0, total: manifest.bytes });
    let stall: ReturnType<typeof setTimeout> | undefined;
    const armStall = () => {
      clearTimeout(stall);
      stall = setTimeout(() => controller.abort(new Error("The download stalled.")), DOWNLOAD_STALL_MS);
      stall.unref?.();
    };
    try {
      await mkdir(this.options.directory, { recursive: true });
      armStall();
      const response = await this.options.fetch((this.options.installerUrl ?? installerUrl)(manifest), { signal: controller.signal, redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(`Installer request failed (${response.status})`);
      const hash = createHash("sha256");
      const file = await open(partial, "w");
      let received = 0, reported = -1;
      try {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          armStall();
          received += value.byteLength;
          if (received > manifest.bytes) throw new VerificationError("The installer is larger than its manifest says.");
          hash.update(value);
          await file.write(value);
          const percent = Math.floor((received / manifest.bytes) * 100);
          if (percent !== reported && this.download === controller) { reported = percent; this.update({ received }); }
        }
      } finally {
        await file.close();
      }
      if (received !== manifest.bytes || hash.digest("hex") !== manifest.sha256) throw new VerificationError("The installer does not match its manifest.");
      if (this.download !== controller) throw new Error("The download was superseded.");
      await rename(partial, final);
      this.installer = final;
      this.update({ phase: "ready", received });
    } catch (error) {
      await rm(partial, { force: true }).catch(() => {});
      // A cancelled download has already put the state back; nothing to report.
      if (this.download === controller) {
        const cancelled = controller.signal.aborted && controller.signal.reason === "cancelled";
        if (!cancelled) this.options.logger.warn("Update download failed", error instanceof Error ? error.message : error);
        this.update({ phase: "available", received: 0, failure: cancelled ? null : error instanceof VerificationError ? "verification" : "network" });
      }
    } finally {
      clearTimeout(stall);
      if (this.download === controller) this.download = null;
    }
    return this.getState();
  }

  /**
   * One request from the user takes the offered update the rest of the way:
   * download and verify it, then hand it to the installer. A cancelled or failed
   * download stops here, so nothing is installed that the user called off.
   */
  async apply(): Promise<UpdateState> {
    if (this.state.phase === "available") await this.startDownload();
    return this.state.phase === "ready" ? this.install() : this.getState();
  }

  cancelDownload(): UpdateState {
    const controller = this.download;
    if (this.state.phase !== "downloading" || !controller) return this.getState();
    this.download = null;
    controller.abort("cancelled");
    this.update({ phase: "available", received: 0, failure: null });
    return this.getState();
  }

  /**
   * Hands the downloaded installer to Windows Installer.
   *
   * The file is checked again immediately before, since it has been sitting in a
   * user-writable folder since the download. Resolves once the installer step is
   * running; the caller then quits so it can proceed.
   */
  async install(): Promise<UpdateState> {
    const manifest = this.manifest, installer = this.installer;
    if (this.state.phase !== "ready" || !manifest || !installer) return this.getState();
    this.update({ phase: "installing", failure: null });
    try {
      const digest = await fileDigest(installer);
      if (digest.bytes !== manifest.bytes || digest.sha256 !== manifest.sha256) throw new VerificationError("The downloaded installer changed after it was verified.");
      await writeFile(join(this.options.directory, PENDING_FILE), JSON.stringify({ version: manifest.version, startedAt: new Date().toISOString() }));
      await this.options.launch({ installer, installLog: join(this.options.directory, INSTALL_LOG), resultFile: join(this.options.directory, RESULT_FILE) });
    } catch (error) {
      this.options.logger.error("Could not start the update installer", error instanceof Error ? error.message : error);
      await rm(join(this.options.directory, PENDING_FILE), { force: true }).catch(() => {});
      const tampered = error instanceof VerificationError;
      if (tampered) {
        await rm(installer, { force: true }).catch(() => {});
        this.installer = null;
      }
      this.update({ phase: tampered ? "available" : "ready", received: 0, failure: tampered ? "verification" : "install" });
    }
    return this.getState();
  }
}
