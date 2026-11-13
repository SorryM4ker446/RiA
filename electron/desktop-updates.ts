/* Looking for, announcing and installing updates of an installed copy. */
import { basename, dirname, join } from "node:path";
import { app, Notification, powerMonitor } from "electron";
import { installationRoot, launchInstaller, type InstallPlan, type UpdateState } from "./updater";
import { runtime, PRODUCT_NAME, smokeTest } from "./runtime-state";
import { notificationIcon, showMainWindow } from "./desktop-presence";

/*
 * Updates replace an installed copy, so only an installed copy looks for them: a
 * development build has nothing for an installer to replace, and a smoke run must
 * not reach the network or touch the download folder an installed copy uses.
 */
export const updatesSupported = app.isPackaged && process.platform === "win32" && !smokeTest;
const UPDATE_FIRST_CHECK_MS = 30_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function broadcastUpdateState(state: UpdateState) {
  if (runtime.mainWindow && !runtime.mainWindow.isDestroyed()) runtime.mainWindow.webContents.send("desktop:update:changed", state);
}

/**
 * Runs the installer once this process has gone, from a helper that outlives it
 * (see launchInstaller). Both programs are named by their full system path.
 */
export async function launchUpdateInstaller(plan: Pick<InstallPlan, "installer" | "installLog" | "resultFile">): Promise<void> {
  const system = join(process.env.SystemRoot || "C:\\Windows", "System32");
  const installRoot = installationRoot(process.execPath);
  await launchInstaller({
    ...plan,
    installRoot,
    relaunch: join(installRoot, basename(process.execPath)),
    waitForPid: process.pid,
  }, { directory: dirname(plan.installer), system, installer: { program: join(system, "msiexec.exe"), window: 1 } });
}

export function notifyUpdateAvailable(version: string) {
  if (!Notification.isSupported()) return;
  const english = runtime.settingsStore?.getLocale() === "en-US";
  runtime.updateNotification?.close();
  runtime.updateNotification = new Notification({
    ...notificationIcon(),
    title: english ? `${PRODUCT_NAME} ${version} is available` : `${PRODUCT_NAME} ${version} 已发布`,
    body: english ? "Open Settings › Application to download and install it." : "在 设置 › 应用 中下载并安装。",
  });
  runtime.updateNotification.once("click", () => {
    showMainWindow();
    if (runtime.mainWindow && !runtime.mainWindow.isDestroyed()) runtime.mainWindow.webContents.send("desktop:update:open");
  });
  runtime.updateNotification.show();
}

/** A check nobody asked for: skipped when the user turned it off, silent when it fails. */
export async function runAutomaticUpdateCheck() {
  if (!runtime.updateService || runtime.isQuitting) return;
  let enabled = true;
  try { enabled = runtime.settingsStore?.getAutoCheckUpdates() ?? true; } catch { enabled = false; }
  if (!enabled) return;
  const state = await runtime.updateService.check();
  if (state.phase === "available" && state.availableVersion && state.availableVersion !== runtime.notifiedUpdateVersion) {
    runtime.notifiedUpdateVersion = state.availableVersion;
    notifyUpdateAvailable(state.availableVersion);
  }
}

export function scheduleUpdateChecks() {
  if (!updatesSupported) return;
  const run = () => { void runAutomaticUpdateCheck().catch(error => runtime.logger?.warn("Automatic update check failed", error)); };
  setTimeout(run, UPDATE_FIRST_CHECK_MS).unref();
  setInterval(run, UPDATE_CHECK_INTERVAL_MS).unref();
  // A machine that slept through the interval checks when it wakes, not hours later.
  powerMonitor.on("resume", () => {
    const checkedAt = runtime.updateService?.getState().checkedAt;
    if (!checkedAt || Date.now() - Date.parse(checkedAt) >= UPDATE_CHECK_INTERVAL_MS) run();
  });
}
