/* The desktop app's main process: start-up, and the application's own events. Its parts live beside it. */
import { createResumeRecovery } from "./resume-recovery";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app, dialog, net, Notification, powerMonitor, globalShortcut } from "electron";
import { createDesktopLogger } from "./logger";
import { runDesktopMigrations } from "./migrations";
import { runWorkspaceUpgrade } from "./desktop-workspace-upgrade";
import { findAvailablePort } from "./next-server";
import { resolveDesktopPaths } from "./paths";
import { DesktopSettingsStore } from "./settings";
import { reconcileUpdateDirectory, removeEmptyVersionFolders, UpdateService } from "./updater";
import { DEVELOPMENT_APP_USER_MODEL_ID, INSTALLED_APP_USER_MODEL_ID } from "./app-identity";
import { UPDATE_SIGNING_PUBLIC_KEY } from "./update-signing-key";
import { createTaskNotificationDelivery, TaskReminderPoller, type TaskNotice } from "./task-reminders";
import { ConversationAlerts, createConversationNotificationDelivery } from "./conversation-alerts";
import { runtime, PRODUCT_NAME, DESKTOP_COOKIE_NAME, packagedRuntime, smokeTest, applicationVersion, smokeReminders } from "./runtime-state";
import { focusMainWindow, notificationIcon, openFromNotice, applyDesktopPresence, registerGlobalHotkey } from "./desktop-presence";
import { launchNextServer, restartLocalService, setDesktopCookie } from "./local-service";
import { broadcastUpdateState, launchUpdateInstaller, scheduleUpdateChecks, updatesSupported } from "./desktop-updates";
import { registerIpcHandlers } from "./ipc-handlers";
import { createMainWindow } from "./main-window";
import { runSmokeAssertion } from "./smoke-run";

if (process.env.DESKTOP_USER_DATA_DIR) {
  app.setPath("userData", process.env.DESKTOP_USER_DATA_DIR);
}

app.setName(PRODUCT_NAME);

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

async function bootstrap() {
  await app.whenReady();
  /*
    Windows groups a taskbar entry and routes a notification by this id, and
    takes the notification's name and icon from the Start menu shortcut the
    installer registers under it. Only an installed copy may use that id: a
    development or test run is electron.exe, and Windows remembers the name and
    icon of the first program that posts under an id, so sharing it left the
    installed application's notifications labelled "Electron".
  */
  app.setAppUserModelId(packagedRuntime ? INSTALLED_APP_USER_MODEL_ID : DEVELOPMENT_APP_USER_MODEL_ID);

  runtime.desktopPaths = resolveDesktopPaths({
    isPackaged: packagedRuntime,
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath("userData"),
    compiledDirectory: __dirname,
    projectRootOverride: process.env.DESKTOP_PROJECT_ROOT,
    runtimeDirectoryOverride: process.env.DESKTOP_RUNTIME_DIR,
    dataDirectoryOverride: process.env.DESKTOP_DATA_DIR,
  });
  runtime.logger = createDesktopLogger(runtime.desktopPaths.logFile);
  runtime.logger.info("Starting desktop application", {
    version: applicationVersion,
    packagedRuntime,
    platform: process.platform,
    osVersion: process.getSystemVersion(),
    gpu: app.getGPUFeatureStatus(),
  });

  runWorkspaceUpgrade({ desktopPaths: runtime.desktopPaths, logger: runtime.logger });

  runDesktopMigrations({
    databaseFile: runtime.desktopPaths.databaseFile,
    migrationsDirectory: runtime.desktopPaths.migrationsDirectory,
    backupsDirectory: runtime.desktopPaths.backupsDirectory,
    logger: runtime.logger,
  });
  runtime.settingsStore = new DesktopSettingsStore(runtime.desktopPaths.settingsFile);
  if (smokeTest) {
    const smokeSecret = `desktop-smoke-key-${process.pid}`;
    // Both providers are seeded so the smoke proves a second key is stored and
    // cleared on its own, not just that one key happens to work.
    const deepseekSecret = `desktop-smoke-deepseek-${process.pid}`;
    // These UI fixtures assert Chinese copy. Make their preference explicit
    // so the smoke checks do not depend on the host's system language.
    await runtime.settingsStore.save({ locale: "zh-CN", openrouterApiKey: smokeSecret, deepseekApiKey: deepseekSecret });
    const storedSettings = readFileSync(runtime.desktopPaths.settingsFile, "utf8");
    if (storedSettings.includes(smokeSecret) || storedSettings.includes(deepseekSecret)) {
      throw new Error("Desktop settings stored an API key without encryption.");
    }
    const smokeView = await runtime.settingsStore.getView();
    if (!smokeView.hasOpenrouterApiKey || !smokeView.hasDeepseekApiKey) {
      throw new Error("Desktop settings did not report both provider keys as configured.");
    }
    await runtime.settingsStore.save({ clearDeepseekApiKey: true });
    const clearedView = await runtime.settingsStore.getView();
    if (clearedView.hasDeepseekApiKey || !clearedView.hasOpenrouterApiKey) {
      throw new Error("Clearing one provider key disturbed another.");
    }
    await runtime.settingsStore.save({ deepseekApiKey: deepseekSecret });
  }
  runtime.desktopSessionToken = randomBytes(32).toString("hex");
  runtime.serverPort = await findAvailablePort();
  runtime.nextServer = await launchNextServer();
  const updateDirectory = join(app.getPath("temp"), `${PRODUCT_NAME}-updates`);
  /*
   * Release acceptance has to update a test machine to a build that is not
   * published yet, so a folder served over HTTP can stand in for the release.
   * It is no shortcut past the checks: the manifest must still verify against the
   * shipped key and the installer against the manifest.
   */
  const updateFeed = process.env.RIA_UPDATE_FEED_URL?.replace(/\/+$/, "");
  runtime.updateService = new UpdateService({
    ...(updateFeed ? { manifestUrl: `${updateFeed}/update-manifest.json`, installerUrl: manifest => `${updateFeed}/${manifest.filename}` } : {}),
    supported: updatesSupported,
    currentVersion: applicationVersion,
    directory: updateDirectory,
    // Windows Installer copies each package it runs into %WINDIR%\Installer.
    installerCacheDirectory: join(process.env.SystemRoot || "C:\\Windows", "Installer"),
    publicKey: UPDATE_SIGNING_PUBLIC_KEY,
    // Chromium's network stack, so the system proxy configuration applies.
    fetch: (url, init) => net.fetch(url, init),
    logger: runtime.logger,
    launch: launchUpdateInstaller,
    onChange: broadcastUpdateState,
    previousInstall: updatesSupported
      ? await reconcileUpdateDirectory({ directory: updateDirectory, currentVersion: applicationVersion, logsDirectory: runtime.desktopPaths.logsDirectory, logger: runtime.logger })
      : null,
  });
  // Upgrades by earlier versions left their replaced versioned folders behind, empty.
  if (updatesSupported) void removeEmptyVersionFolders(process.execPath, runtime.logger);
  registerIpcHandlers();

  const settings = await runtime.settingsStore.getView();
  // The welcome page is for an installation that cannot call any model at all.
  // Keying it on one provider sent a workspace configured only for DeepSeek to
  // the settings screen on every launch, asking for a key it does not need.
  const hasAnyProviderKey = settings.hasOpenrouterApiKey || settings.hasDeepseekApiKey;
  const initialPath = packagedRuntime && !hasAnyProviderKey ? "/chat?settings=services&welcome=1" : "/chat";
  runtime.mainWindow = await createMainWindow(initialPath, true);
  const showTaskNotice = createTaskNotificationDelivery(Notification, openFromNotice, runtime.logger, () => runtime.settingsStore?.getLocale() ?? "zh-CN", notificationIcon);
  // The notice stays in the app either way; the user chose which ones also appear on screen.
  const announceTaskNotice = (notice: TaskNotice) => { if (runtime.settingsStore?.showsTaskNotice(notice.title) !== false) showTaskNotice(notice); };
  runtime.reminderPoller = new TaskReminderPoller({
    connection: () => runtime.nextServer ? { origin: runtime.nextServer.origin, cookie: `${DESKTOP_COOKIE_NAME}=${runtime.desktopSessionToken}` } : null,
    supported: () => smokeTest || Notification.isSupported(),
    deliver: smokeTest ? task => { smokeReminders.push(task); } : announceTaskNotice,
    logger: runtime.logger,
  });
  runtime.reminderPoller.start();
  runtime.conversationAlerts = new ConversationAlerts({
    connection: () => runtime.nextServer ? { origin: runtime.nextServer.origin, cookie: `${DESKTOP_COOKIE_NAME}=${runtime.desktopSessionToken}` } : null,
    supported: () => !smokeTest && Notification.isSupported(),
    inFront: () => Boolean(runtime.mainWindow && !runtime.mainWindow.isDestroyed() && runtime.mainWindow.isVisible() && !runtime.mainWindow.isMinimized() && runtime.mainWindow.isFocused()),
    deliver: createConversationNotificationDelivery(Notification, openFromNotice, runtime.logger, () => runtime.settingsStore?.getLocale() ?? "zh-CN", notificationIcon),
    logger: runtime.logger,
  });
  runtime.conversationAlerts.start();
  /*
   * The tray and the global shortcut have to be set up on a cold start, not only
   * after a settings change. They were once wired into the service-restart path
   * alone, which meant a normally launched application had neither: closing the
   * window would quit even with "keep running in the tray" chosen, and the
   * shortcut the user had set was never taken.
   */
  if (!smokeTest) {
    await applyDesktopPresence().catch((error) => {
      runtime.logger?.warn("Could not apply the desktop presence setting", error);
    });
    const hotkey = await runtime.settingsStore?.getGlobalHotkey().catch(() => "");
    if (hotkey) registerGlobalHotkey(hotkey);
  }
  const recoverAfterResume = createResumeRecovery({
    current: () => runtime.nextServer,
    quitting: () => runtime.isQuitting || runtime.restartInProgress !== null,
    healthy: async service => {
      try { return (await fetch(`${service.origin}/api/health`, { signal: AbortSignal.timeout(5000), redirect: "error" })).ok; }
      catch { return false; }
    },
    refreshSession: service => setDesktopCookie(service.origin),
    restart: () => {
      let destination = "/chat";
      try {
        const url = new URL(runtime.mainWindow?.webContents.getURL() ?? "");
        if (url.origin === runtime.nextServer?.origin) destination = `${url.pathname}${url.search}${url.hash}`;
      } catch { /* A stopped page has no local route to preserve. */ }
      return restartLocalService(destination);
    },
    poll: () => runtime.reminderPoller?.poll() ?? Promise.resolve(),
    failed: () => runtime.logger?.error("Unable to recover the local service after resume"),
  });
  powerMonitor.on("resume", () => { void recoverAfterResume(); });
  if (smokeTest) await Promise.all([recoverAfterResume(), recoverAfterResume()]);
  scheduleUpdateChecks();


  if (smokeTest) {
    await runSmokeAssertion();
    runtime.isQuitting = true;
    await runtime.reminderPoller.stop();
    await runtime.conversationAlerts?.stop();
    await runtime.nextServer.stop();
    app.exit(0);
  }
}

app.on("second-instance", () => {
  focusMainWindow();
});

// A crashed GPU process can leave the window unpainted without any error in the page.
app.on("child-process-gone", (_event, details) => runtime.logger?.error("Child process gone", details));

app.on("activate", () => {
  if (runtime.mainWindow) {
    runtime.mainWindow.show();
    return;
  }
  if (runtime.nextServer) {
    void createMainWindow("/chat").then((window) => {
      runtime.mainWindow = window;
    });
  }
});

/*
 * Closing the window with a tray present does not mean quitting. Without one
 * it does, which is the default and what happens until the user chooses
 * otherwise in settings.
 */
app.on("window-all-closed", () => {
  if (runtime.tray && !runtime.isQuitting) return;
  app.quit();
});

app.on("before-quit", (event) => {
  // A global shortcut outlives the windows that own it. Releasing it here is
  // what stops the combination staying dead in the system while the app runs on
  // with no window.
  globalShortcut.unregisterAll();
  if (runtime.isQuitting) return;
  /*
   * A restart in flight owns a service `nextServer` does not point at yet: the
   * stopped one is cleared before the new one is launched, and the new one is
   * only assigned once it has answered. Returning here — which is what a plain
   * `!nextServer` test did — let the quit run to completion with that launch
   * still going, so the restart carried on inside a process the user had just
   * closed: it reassigned `nextServer`, re-armed the reminder poller, could
   * build a tray icon, and could raise the "unable to restart" dialog behind a
   * quit. The launch is abandoned and awaited instead.
   */
  if (!runtime.nextServer && !runtime.restartInProgress) {
    /*
     * There is nothing left to stop, but the quit still has to finish, and a
     * bare return says nothing about that. `isQuitting` stays false, which
     * leaves the window's own close handler as the only thing deciding whether
     * the application exits — and in tray mode that handler hides the window
     * instead of closing it, so a quit is swallowed by a window the user meant
     * to close. A service that died, or a restart that failed, leaves the
     * application here, so this is a state ordinary use reaches rather than one
     * only start-up passes through.
     *
     * It ends the way the branch below ends, because it is the same guarantee:
     * the quit belongs to this handler, not to a close the user can cancel.
     */
    event.preventDefault();
    runtime.isQuitting = true;
    void (async () => { await runtime.reminderPoller?.stop(); await runtime.conversationAlerts?.stop(); })().finally(() => app.exit(0));
    return;
  }
  event.preventDefault();
  runtime.isQuitting = true;
  runtime.restartAbort?.abort(new Error("The application is quitting."));
  void (async () => {
    await runtime.reminderPoller?.stop(); await runtime.conversationAlerts?.stop();
    await runtime.restartInProgress?.catch(() => {});
    await runtime.nextServer?.stop();
  })().finally(() => app.exit(0));
});

if (singleInstanceLock) {
  void bootstrap().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    runtime.logger?.error("Desktop application failed to start", error);
    if (!smokeTest) dialog.showErrorBox(`${PRODUCT_NAME} failed to start`, `${message}\n\nSee the desktop log for details.`);
    runtime.isQuitting = true;
    void (async () => { await runtime.reminderPoller?.stop(); await runtime.conversationAlerts?.stop(); await runtime.nextServer?.stop(); })().finally(() => app.exit(1));
  });
}
