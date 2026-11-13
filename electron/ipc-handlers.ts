/* What the page may ask of the desktop shell, each request checked to come from the app's own page. */
import { openLocalFile } from "./open-local-file";
import { type WindowAction } from "./window-transitions";
import { dirname, isAbsolute } from "node:path";
import { BrowserWindow, dialog, ipcMain, Notification, shell, type IpcMainInvokeEvent } from "electron";
import { type DesktopSettingsInput } from "./settings";
import { installationRoot } from "./updater";
import { runtime, PRODUCT_NAME, packagedRuntime, smokeTest, applicationVersion, windowTransitions, startupPresentations } from "./runtime-state";
import { quitFromTray, registerGlobalHotkey, showMainWindow, updateTrayMenu, applyDesktopPresence } from "./desktop-presence";
import { restartLocalService } from "./local-service";
import { runAutomaticUpdateCheck } from "./desktop-updates";

export function assertTrustedIpcSender(event: IpcMainInvokeEvent | Electron.IpcMainEvent) {
  if (!runtime.nextServer) throw new Error("Desktop service is not ready.");
  // senderFrame is the frame that actually sent this; getURL() is the top
  // frame, so a subframe would be checked against the wrong document.
  const senderUrl = event.senderFrame?.url ?? event.sender.getURL();
  let senderOrigin = "";
  try {
    senderOrigin = new URL(senderUrl).origin;
  } catch {
    throw new Error("Desktop request came from an invalid renderer URL.");
  }
  if (senderOrigin !== runtime.nextServer.origin) {
    throw new Error("Desktop request came from an untrusted renderer.");
  }
}

export function performWindowAction(target: BrowserWindow, action: WindowAction) {
  const transitions = windowTransitions.get(target);
  if (transitions) { transitions.request(action); return; }
  if (action === "minimize") target.minimize();
  else if (action === "close") target.close();
  else if (target.isMaximized()) target.unmaximize(); else target.maximize();
}

export function registerIpcHandlers() {
  // The caption is drawn by the page, so the verbs live here rather than in the
  // window factory: `createMainWindow` runs a second time from `activate`, and
  // registering there duplicated every `on` listener (one click, N actions) and
  // made `ipcMain.handle` throw on the second call.
  //
  // These are `send` rather than `invoke` so the page never waits on a window
  // operation. That also means there is no promise for Electron to turn a throw
  // into a rejection, so the trust check is caught here: an unhandled throw in
  // an `ipcMain.on` callback is an uncaught exception in the main process, and
  // a refused sender would take the whole shell down instead of being ignored.
  const guarded = (event: Electron.IpcMainEvent, action: (target: BrowserWindow) => void) => {
    try {
      assertTrustedIpcSender(event);
    } catch {
      return;
    }
    const target = BrowserWindow.fromWebContents(event.sender);
    if (target && !target.isDestroyed()) action(target);
  };
  ipcMain.on("desktop:window:minimize", (event) => {
    guarded(event, (target) => performWindowAction(target, "minimize"));
  });
  ipcMain.on("desktop:window:toggle-maximize", (event) => {
    guarded(event, (target) => performWindowAction(target, "toggle-maximize"));
  });
  ipcMain.on("desktop:window:close", (event) => {
    guarded(event, (target) => performWindowAction(target, "close"));
  });
  // The page mounts before it can have observed a maximise event, so the initial
  // state has to be pullable. This one is an `invoke`, so a rejected sender
  // becomes a rejected promise instead.
  ipcMain.handle("desktop:window:state", (event) => {
    assertTrustedIpcSender(event);
    return { maximized: BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false };
  });

  const startupFor = (event: IpcMainInvokeEvent) => {
    assertTrustedIpcSender(event);
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("Startup presentation belongs to the main frame.");
    const target = BrowserWindow.fromWebContents(event.sender);
    return target && !target.isDestroyed() ? startupPresentations.get(target) : undefined;
  };
  ipcMain.handle("desktop:startup:claim", event => startupFor(event)?.claim() ?? null);
  ipcMain.handle("desktop:startup:present", (event, token: unknown) => startupFor(event)?.present(token) ?? false);

  ipcMain.handle("desktop:runtime:get", (event) => {
    assertTrustedIpcSender(event);
    if (!runtime.desktopPaths) throw new Error("Desktop paths are not initialized.");
    return {
      appVersion: applicationVersion,
      packaged: packagedRuntime,
      platform: process.platform,
      dataDirectory: dirname(runtime.desktopPaths.databaseFile),
      mediaDirectory: runtime.desktopPaths.mediaDirectory,
      logFile: runtime.desktopPaths.logFile,
      notificationsSupported: Notification.isSupported(),
    };
  });

  ipcMain.handle("desktop:settings:get", async (event) => {
    assertTrustedIpcSender(event);
    if (!runtime.settingsStore) throw new Error("Desktop settings store is not ready.");
    return runtime.settingsStore.getView();
  });

  const updates = (event: IpcMainInvokeEvent) => {
    assertTrustedIpcSender(event);
    if (!runtime.updateService) throw new Error("Desktop updates are not ready.");
    return runtime.updateService;
  };
  ipcMain.handle("desktop:update:state", event => updates(event).getState());
  ipcMain.handle("desktop:update:check", event => updates(event).check());
  /*
   * Download, verify and install in one request. It outlives the call: progress
   * arrives as state changes, and the page learns the app is about to quit from
   * the "installing" state before it does. The installer is waiting for this
   * process to exit, and the quit is the one the tray uses, so the local service
   * is stopped first.
   */
  ipcMain.handle("desktop:update:apply", event => {
    const service = updates(event);
    void service.apply().then(state => {
      if (state.phase !== "installing") return;
      runtime.logger?.info("Quitting so the update can install", { version: state.availableVersion, installRoot: installationRoot(process.execPath) });
      setTimeout(() => quitFromTray(), 1500);
    }, error => runtime.logger?.error("Update failed", error));
    return service.getState();
  });
  ipcMain.handle("desktop:update:cancel", event => updates(event).cancelDownload());

  ipcMain.handle("desktop:folder:reveal", async (event, target: unknown) => {
    assertTrustedIpcSender(event);
    if (typeof target !== "string" || !target) return { revealed: false };
    // Containment is not decided here. It was decided by the service, which
    // resolved the path inside a granted folder using the same check every read
    // goes through; this handler only selects what it is handed, so it is not a
    // second boundary and nothing above it should be read as one.
    if (!isAbsolute(target)) return { revealed: false };
    shell.showItemInFolder(target);
    return { revealed: true };
  });

  ipcMain.handle("desktop:file:open", async (event, target: unknown) => {
    assertTrustedIpcSender(event);
    return openLocalFile(target, path => shell.openPath(path));
  });

  ipcMain.handle("desktop:folder:choose", async (event) => {
    assertTrustedIpcSender(event);
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (!parent) return { canceled: true, path: "" };
    const result = await dialog.showOpenDialog(parent, {
      title: PRODUCT_NAME,
      properties: ["openDirectory", "dontAddToRecent"],
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true, path: "" };
    return { canceled: false, path: result.filePaths[0] };
  });

  ipcMain.handle("desktop:settings:save", async (event, input: DesktopSettingsInput) => {
    assertTrustedIpcSender(event);
    if (!runtime.settingsStore) throw new Error("Desktop settings store is not ready.");
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Invalid desktop settings payload.");
    }
    const settings = await runtime.settingsStore.save(input);
    if (input.locale !== undefined && runtime.tray) updateTrayMenu(runtime.tray);
    /*
     * The close behaviour and the tray follow the setting immediately, rather
     * than at some restart the user did not know they needed. The service restart
     * is only for what the server reads at start-up — the keys, the proxy and the
     * OpenRouter identity — so switching the close behaviour no longer parks the
     * window on `about:blank` and reloads it for a change that needed neither.
     */
    if (input.autoCheckUpdates === true) void runAutomaticUpdateCheck().catch(error => runtime.logger?.warn("Update check failed", error));
    if (input.closeBehaviour !== undefined) {
      /*
       * Deliberately not swallowed. `settings.json` saying "tray"
       * while no tray was ever created is a state the user cannot see and cannot
       * get out of, so the failure is allowed to reach the screen that asked for
       * the change.
       */
      await applyDesktopPresence();
    }
    const needsRestart = Boolean(
      input.openrouterApiKey
      || input.deepseekApiKey
      || input.clearOpenrouterApiKey
      || input.clearDeepseekApiKey
      || input.outboundProxyUrl !== undefined
      || input.openrouterSiteName !== undefined
      || input.openrouterHttpReferer !== undefined,
    );
    if (!needsRestart) return { settings, restarting: false };
    setTimeout(() => {
      void restartLocalService().catch((error) => {
        runtime.logger?.error("Unable to restart local service after settings update", error);
        if (!smokeTest) dialog.showErrorBox("Unable to restart", "See the desktop log for details.");
      });
    }, 150);
    return { settings, restarting: true };
  });

  ipcMain.handle("desktop:tray:quit", async (event) => {
    assertTrustedIpcSender(event);
    quitFromTray();
    return { quitting: true };
  });

  ipcMain.handle("desktop:tray:show", async (event) => {
    assertTrustedIpcSender(event);
    showMainWindow();
    return { shown: true };
  });

  ipcMain.handle("desktop:hotkey:set", async (event, accelerator: unknown) => {
    assertTrustedIpcSender(event);
    if (typeof accelerator !== "string") return { ok: false, hotkey: "", reason: "invalid" as const };
    const outcome = registerGlobalHotkey(accelerator);
    if (!outcome.ok || !runtime.settingsStore) return outcome;
    try {
      await runtime.settingsStore.save({ globalHotkey: accelerator });
    } catch (error) {
      /*
       * A write that failed leaves the combination live in the operating system
       * until the next launch and the stored record holding the previous one, so
       * the two disagree about what the user's shortcut is. Put the stored one
       * back rather than telling them it saved, and say so instead of reporting
       * success for a shortcut that will not survive a restart.
       */
      runtime.logger?.warn("Could not store the global shortcut", error);
      const previous = await runtime.settingsStore.getGlobalHotkey().catch(() => "");
      registerGlobalHotkey(previous);
      return { ok: false, hotkey: previous, reason: "not-stored" as const };
    }
    return outcome;
  });
}
