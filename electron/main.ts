import { createResumeRecovery } from "./resume-recovery";
import { windowAppearance } from "./window-appearance";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { request as httpRequest } from "node:http";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  screen,
  Tray,
  powerMonitor,
  session,
  shell,
  type IpcMainInvokeEvent,
  globalShortcut,
} from "electron";
import { createDesktopLogger, DESKTOP_LOG_LIMITS, type DesktopLogger } from "./logger";
import { runDesktopMigrations } from "./migrations";
import { runWorkspaceUpgrade } from "./desktop-workspace-upgrade";
import { findAvailablePort, startNextServer, type NextServerExit, type RunningNextServer } from "./next-server";
import { resolveDesktopPaths, toSqliteUrl, type DesktopPaths } from "./paths";
import { configureDesktopSession, secureBrowserWindow } from "./security";
import { DesktopSettingsStore, type DesktopSettingsInput } from "./settings";
import { handleSquirrelStartupEvent } from "./squirrel";
import { createTaskNotificationDelivery, TaskReminderPoller, type TaskReminder } from "./task-reminders";
import { seedTaskReminderSmoke } from "./task-reminders-smoke";
import { prepareConversationSmoke, verifyConversationSmoke } from "./conversations-smoke";
import { seedMediaLibrarySmoke, verifyMediaLibrarySmoke } from "./media-library-smoke";
import { prepareAccountSettingsSmoke, verifyAccountBackupSmoke } from "./account-backup-smoke";

const PRODUCT_NAME = "RiA";
const DESKTOP_COOKIE_NAME = "desktop_session";
const forcePackagedRuntime = process.env.DESKTOP_FORCE_PACKAGED === "1";
const packagedRuntime = app.isPackaged || forcePackagedRuntime;
const smokeTest = process.env.DESKTOP_SMOKE_TEST === "1";
const squirrelEventHandled = handleSquirrelStartupEvent();
const applicationVersion = packagedRuntime
  ? app.getVersion()
  : (JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string }).version;

if (process.env.DESKTOP_USER_DATA_DIR) {
  app.setPath("userData", process.env.DESKTOP_USER_DATA_DIR);
}

app.setName(PRODUCT_NAME);

const singleInstanceLock = squirrelEventHandled ? false : app.requestSingleInstanceLock();
if (!squirrelEventHandled && !singleInstanceLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let nextServer: RunningNextServer | null = null;
let desktopPaths: DesktopPaths | null = null;
let logger: DesktopLogger | null = null;
let settingsStore: DesktopSettingsStore | null = null;
let desktopSessionToken = "";
let serverPort = 0;
let isQuitting = false;
let restartInProgress: Promise<void> | null = null;
/*
 * Cancels the launch a restart is in the middle of. The restart clears the old
 * service before it has a new one to point at, so for as long as that takes the
 * only handle on the child process being launched is this one.
 */
let restartAbort: AbortController | null = null;
let reminderPoller: TaskReminderPoller | null = null;

/**
 * Present only when the user chose to keep the app running when the window
 * closes. Its absence is meaningful: without it, closing the window closes
 * the app, which is the default and the only behaviour on offer at first run.
 */
let tray: Tray | null = null;

/*
 * Mirrors the stored close behaviour so the close handler can act on it
 * synchronously.
 *
 * Electron decides whether a window closes while the `close` handler is still
 * running. Calling `preventDefault()` from a promise callback arrives after that
 * decision, which is why the setting is read once here rather than on every
 * close — an earlier version read it inside the handler and the window closed
 * regardless of the setting.
 */
let closeBehaviour: "quit" | "tray" = "quit";
const smokeReminders: TaskReminder[] = [];

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function assertTrustedIpcSender(event: IpcMainInvokeEvent | Electron.IpcMainEvent) {
  if (!nextServer) throw new Error("Desktop service is not ready.");
  // senderFrame is the frame that actually sent this; getURL() is the top
  // frame, so a subframe would be checked against the wrong document.
  const senderUrl = event.senderFrame?.url ?? event.sender.getURL();
  let senderOrigin = "";
  try {
    senderOrigin = new URL(senderUrl).origin;
  } catch {
    throw new Error("Desktop request came from an invalid renderer URL.");
  }
  if (senderOrigin !== nextServer.origin) {
    throw new Error("Desktop request came from an untrusted renderer.");
  }
}

async function resolveServerEnvironment(): Promise<Record<string, string>> {
  if (!settingsStore) throw new Error("Desktop settings store is not ready.");
  const settingsEnvironment = await settingsStore.getServerEnvironment();
  if (!packagedRuntime) {
    for (const key of ["OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TAVILY_API_KEY", "OUTBOUND_PROXY_URL"] as const) {
      if (!settingsEnvironment[key]) delete settingsEnvironment[key];
    }
  }
  return settingsEnvironment;
}

async function launchNextServer(signal?: AbortSignal): Promise<RunningNextServer> {
  if (!desktopPaths || !logger) throw new Error("Desktop paths are not initialized.");
  if (packagedRuntime && !existsSync(desktopPaths.serverEntry)) {
    throw new Error(`Packaged Next.js server is missing: ${desktopPaths.serverEntry}`);
  }

  const nodeExecutable = process.env.DESKTOP_NODE_EXECUTABLE || process.env.npm_node_execpath || "node";
  return startNextServer({
    packagedRuntime,
    projectRoot: desktopPaths.projectRoot,
    runtimeDirectory: desktopPaths.runtimeDirectory,
    serverEntry: desktopPaths.serverEntry,
    nodeExecutable,
    databaseUrl: toSqliteUrl(desktopPaths.databaseFile),
    mediaDirectory: desktopPaths.mediaDirectory,
    desktopSessionToken,
    port: serverPort,
    environment: await resolveServerEnvironment(),
    logger,
    signal,
    onUnexpectedExit: handleUnexpectedServiceExit,
  });
}

/**
 * What this application does when the local service stops existing.
 *
 * Nothing else can notice it. The child is a separate process, the window is
 * holding a document that stays perfectly renderable without the service that
 * produced it, and the IPC trust checks compare an origin string a dead
 * process still matches — so the shell carries on looking healthy while every
 * request to it fails, and nothing in the log says why. The tray and the
 * global shortcut need nothing from the service and are left alone; both of
 * them bring the window forward, which now has something to say.
 *
 * The window is put into the state a launch that never came up already
 * produces, because it is the same fact: there is no service for this window
 * to reach. It is deliberately not restarted. A service that died is something
 * the user has to see and be able to report, and a restart loop would only
 * replace that with a window that keeps changing state without ever saying
 * what happened.
 */
function handleUnexpectedServiceExit(exit: NextServerExit): void {
  if (isQuitting) return;
  /*
   * Identity, not emptiness. A child this application has already replaced is
   * not the service it is running, and a launch that has not been adopted yet
   * is not one either — reporting either would put the window into a state
   * describing a process nothing is waiting for.
   */
  if (nextServer && nextServer.child !== exit.child) return;
  nextServer = null;
  /*
   * The poller reads `nextServer` for its connection, so clearing it also ends
   * the checks that would otherwise keep failing against a port nothing is
   * listening on, every thirty seconds, for as long as the window is open.
   */
  void (async () => {
    await reminderPoller?.stop();
    // The quit can land while the poller settles, and there is then nothing
    // left to tell anyone.
    if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
    await mainWindow.loadURL(serviceStoppedPage());
  })().catch((error) => {
    // Called from a process event, where an unhandled rejection is a crash.
    logger?.warn("Unable to show the page for a stopped local service", error);
  });
}

async function setDesktopCookie(origin: string) {
  // A session cookie lives as long as the Chromium session itself. The token
  // rotates on every launch, so a persistent expiry would only guarantee a
  // 403 wall for windows left open longer than a day.
  await session.defaultSession.cookies.set({
    url: origin,
    name: DESKTOP_COOKIE_NAME,
    value: desktopSessionToken,
    httpOnly: true,
    secure: false,
    sameSite: "strict",
  });
}

/**
 * What the window says when the local service could not be started.
 *
 * This replaces `about:blank`, whose origin is the string "null" and is refused
 * by every IPC trust check, so a blank window could ask the shell for nothing at
 * all. Plain text on a `data:` URL needs no origin to be trusted against, which is
 * why it can be the one page loaded while there is no server to trust anything to.
 */
function serviceStoppedPage(): string {
  const document = [
    `<!doctype html><meta charset='utf-8'><title>${PRODUCT_NAME}</title>`,
    `<body style='font:15px/1.6 system-ui,sans-serif;margin:3rem auto;max-width:34rem;color:#111'>`,
    `<h1 style='font-size:1.2rem'>The local service is not running.</h1>`,
    "<p>" + PRODUCT_NAME + " could not restart it after a settings change, so nothing on this screen can reach the service.</p>",
    "<p>The details are in the desktop log. Close the application and start it again.</p>",
  ].join("");
  return `data:text/html;charset=utf-8,${encodeURIComponent(document)}`;
}

async function restartLocalService(destination = "/settings?saved=1") {
  if (restartInProgress) return restartInProgress;
  const abort = new AbortController();
  restartAbort = abort;
  restartInProgress = (async () => {
    if (!logger) return;
    logger.info("Restarting local Next.js service");
    await reminderPoller?.stop();
    if (isQuitting) return;
    // Stop the old renderer's HMR reconnect and requests before restarting.
    // Otherwise its reload can abort the navigation to the restarted service.
    //
    // The stopped server is cleared before the relaunch rather than after it. A
    // failed launch used to leave `nextServer` pointing at a process that no
    // longer existed, so `activate` built a window on a dead origin, and the one
    // already open was parked on `about:blank` — which parses as the origin the
    // string "null", a value every IPC trust check refuses. The window was then a
    // dead end the user could only recover from by killing the process.
    const stopped = nextServer;
    nextServer = null;
    if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL("about:blank");
    if (stopped) await stopped.stop();
    /*
     * Clearing `nextServer` above opens a window in which this application owns a
     * service nothing points at: the old one is stopped, the new one is not yet a
     * value any of this holds. A quit landing in that window used to be let
     * straight through, leaving the launch below running on inside a process the
     * user had just closed. Every step the quit can overtake is a step to give
     * up at instead, and a launch already under way is stopped at the last moment
     * anything still can.
     *
     */
    if (isQuitting || abort.signal.aborted) return;
    let launched: RunningNextServer;
    try {
      launched = await launchNextServer(abort.signal);
    } catch (error) {
      if (isQuitting) return;
      // Blank is unrecoverable and says nothing, so the window states what
      // happened rather than leaving a white rectangle with no way forward.
      if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(serviceStoppedPage());
      throw error;
    }
    /*
     * The quit can land while the new service is still booting. The child is a
     * separate process by then, so adopting it here would leave a listener with no
     * supervisor the instant the shell exits. It is stopped here instead, which is
     * the last moment something is still able to do so.
     */
    if (isQuitting || abort.signal.aborted) {
      logger.info("Discarding a local service that finished launching after the quit was requested");
      await launched.stop();
      return;
    }
    nextServer = launched;
    await setDesktopCookie(nextServer.origin);
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(`${nextServer.origin}${destination}`);
    }
    reminderPoller?.start();

    // The tray and the close behaviour follow the stored setting, including
    // after a service restart and including a change made in the running app.
    if (!smokeTest) {
      await applyDesktopPresence();
      // A shortcut the operating system refuses is not fatal: the window is
      // still reachable, and the settings screen says the combination is taken.
      const hotkey = await settingsStore?.getGlobalHotkey().catch(() => "");
      if (hotkey) registerGlobalHotkey(hotkey);
    }
  })().finally(() => {
    restartInProgress = null;
    if (restartAbort === abort) restartAbort = null;
  });
  return restartInProgress;
}

function registerIpcHandlers() {
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
    guarded(event, (target) => target.minimize());
  });
  ipcMain.on("desktop:window:toggle-maximize", (event) => {
    guarded(event, (target) => (target.isMaximized() ? target.unmaximize() : target.maximize()));
  });
  ipcMain.on("desktop:window:close", (event) => {
    guarded(event, (target) => target.close());
  });
  // The page mounts before it can have observed a maximise event, so the initial
  // state has to be pullable. This one is an `invoke`, so a rejected sender
  // becomes a rejected promise instead.
  ipcMain.handle("desktop:window:state", (event) => {
    assertTrustedIpcSender(event);
    return { maximized: BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false };
  });

  ipcMain.handle("desktop:runtime:get", (event) => {
    assertTrustedIpcSender(event);
    if (!desktopPaths) throw new Error("Desktop paths are not initialized.");
    return {
      appVersion: applicationVersion,
      packaged: packagedRuntime,
      platform: process.platform,
      dataDirectory: dirname(desktopPaths.databaseFile),
      mediaDirectory: desktopPaths.mediaDirectory,
      logFile: desktopPaths.logFile,
      notificationsSupported: Notification.isSupported(),
    };
  });

  ipcMain.handle("desktop:settings:get", async (event) => {
    assertTrustedIpcSender(event);
    if (!settingsStore) throw new Error("Desktop settings store is not ready.");
    return settingsStore.getView();
  });

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
    if (!settingsStore) throw new Error("Desktop settings store is not ready.");
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Invalid desktop settings payload.");
    }
    const settings = await settingsStore.save(input);
    /*
     * The close behaviour and the tray follow the setting immediately, rather
     * than at some restart the user did not know they needed. The service restart
     * is only for what the server reads at start-up — the keys, the proxy and the
     * OpenRouter identity — so switching the close behaviour no longer parks the
     * window on `about:blank` and reloads it for a change that needed neither.
     */
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
      || input.tavilyApiKey
      || input.deepseekApiKey
      || input.clearOpenrouterApiKey
      || input.clearTavilyApiKey
      || input.clearDeepseekApiKey
      || input.outboundProxyUrl !== undefined
      || input.openrouterSiteName !== undefined
      || input.openrouterHttpReferer !== undefined,
    );
    if (!needsRestart) return { settings, restarting: false };
    setTimeout(() => {
      void restartLocalService().catch((error) => {
        logger?.error("Unable to restart local service after settings update", error);
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
    if (!outcome.ok || !settingsStore) return outcome;
    try {
      await settingsStore.save({ globalHotkey: accelerator });
    } catch (error) {
      /*
       * A write that failed leaves the combination live in the operating system
       * until the next launch and the stored record holding the previous one, so
       * the two disagree about what the user's shortcut is. Put the stored one
       * back rather than telling them it saved, and say so instead of reporting
       * success for a shortcut that will not survive a restart.
       */
      logger?.warn("Could not store the global shortcut", error);
      const previous = await settingsStore.getGlobalHotkey().catch(() => "");
      registerGlobalHotkey(previous);
      return { ok: false, hotkey: previous, reason: "not-stored" as const };
    }
    return outcome;
  });
}

/**
 * Trailing-edge debounce, so dragging a window edge writes one record rather
 * than one per frame of the drag.
 */
function debounce<T extends (...args: never[]) => void>(run: T, waitMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run(...args);
    }, waitMs);
    timer.unref?.();
  };
}

/**
 * The three things a tray icon is for, and nothing else.
 *
 * No clipboard, no screen, no key listener. The icon is a way back to the
 * window, a way to start a task, and a way out — a tray that watched more
 * than that would be monitoring the user rather than serving them.
 */
/**
 * The icon the tray uses.
  *
  * Packaged, the asset is staged loose beside the app under `resources`; the copy
  * inside the bundle archive and the working tree are the fallbacks for a build
  * that did not stage it. Every candidate is checked rather than assumed, because
  * a tray with a missing icon is an invisible process — one holding the database
  * and a listening port, with no window and no way back but Task Manager.
  */
function trayIconCandidates(): string[] {
  return [
    join(process.resourcesPath, "assets", "desktop-icon.png"),
    join(__dirname, "..", "assets", "desktop-icon.png"),
    join(desktopPaths?.projectRoot ?? process.cwd(), "assets", "desktop-icon.png"),
  ];
}

function trayIconPath(): string | null {
  return trayIconCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

function createTray(): Tray {
  const iconPath = trayIconPath();
  if (!iconPath) throw new Error(`The tray icon is missing: ${trayIconCandidates().join(", ")}`);
  const created = new Tray(iconPath);
  created.setToolTip(PRODUCT_NAME);
  created.setContextMenu(Menu.buildFromTemplate([
    { label: "Open RiA", click: () => showMainWindow() },
    { type: "separator" },
    { label: "Quit", click: () => quitFromTray() }
  ]));
  // A left click on the icon is the ordinary way back to the window.
  created.on("click", () => showMainWindow());
  return created;
}

/**
 * Why a shortcut did not take, in words the settings screen can show.
 *
 * `register` returning false means another program already owns the
 * combination. That is reported rather than swallowed: a shortcut that silently
 * does nothing is worse than one the user is told is taken.
 */
type HotkeyOutcome = { ok: true; hotkey: string } | { ok: false; hotkey: string; reason: "conflict" | "invalid" | "not-stored" };

/**
 * One combination, and it only brings the window forward.
 *
 * No clipboard history, no screen grab, no listening for ordinary typing. A
 * global hook that saw every keypress would be a keylogger wearing a
 * productivity feature, and nothing in this app needs one.
 */
/*
 * The combination currently held by the operating system, so a refusal can say
 * which one is still in force rather than which one was asked for. Releasing it
 * before the replacement is known to be registerable is what used to leave a
 * working shortcut dead after a typo: the old one went, the new one never took,
// and the stored setting still named the old one.
 */
let activeAccelerator = "";

function registerGlobalHotkey(accelerator: string): HotkeyOutcome {
  const wanted = accelerator.trim();
  if (!wanted) {
    globalShortcut.unregisterAll();
    activeAccelerator = "";
    return { ok: true, hotkey: "" };
  }
  /*
   * The combination already in force is not a conflict, and asking the
   * operating system for it again is not how a repeat is recognised: Electron
   * refuses a second registration of an accelerator this app already holds and
   * leaves the first one running. Re-applying the stored shortcut therefore read
   * as "another program owns this" while the app's own shortcut was the one
   * being reported, and saving the unchanged value looked like a refusal.
   */
  if (activeAccelerator === wanted && globalShortcut.isRegistered(wanted)) {
    return { ok: true, hotkey: wanted };
  }
  const bringWindowForward = () => showMainWindow();
  let registered = false;
  try {
    registered = globalShortcut.register(wanted, bringWindowForward);
  } catch {
    // Electron throws on a combination it cannot parse, and returns false on
    // one it cannot take. They are the same answer to the user, and neither is an
    // answer that touches the shortcut already in force.
    return { ok: false, hotkey: activeAccelerator, reason: "invalid" };
  }
  if (!registered) {
    logger?.warn("Global shortcut was already taken by another program", { accelerator: wanted });
    return { ok: false, hotkey: activeAccelerator, reason: "conflict" };
  }
  // The new combination is held; only now is the previous one released.
  if (activeAccelerator && activeAccelerator !== wanted) globalShortcut.unregister(activeAccelerator);
  activeAccelerator = wanted;
  return { ok: true, hotkey: wanted };
}

/**
 * Bring the tray and the close behaviour in line with the stored setting.
 *
 * Called at start-up and again whenever the user changes the setting, so
 * choosing "keep running in the tray" takes effect now rather than at some
 * future restart the user may not have known they needed. Turning it off
 * destroys the tray: an icon left behind for a mode that is no longer chosen
 * is a process the user cannot account for.
 */
async function applyDesktopPresence(): Promise<void> {
  const behaviour = (await settingsStore?.getCloseBehaviour().catch(() => "quit")) ?? "quit";
  /*
   * A tray is not optional once the behaviour is "tray": closing the window then
   * hides it, so one that could not be created would leave the app running with no
   * window, no icon and no way back. Quitting is the only mode that cannot strand
   * the user, so that is what stays in force until the tray can be built — and the
   * stored choice is left untouched for the next launch to retry. The failure is
   * raised rather than logged alone, because the caller is a screen that should be
   * able to say the setting did not take effect.
   */
  if (behaviour === "tray") {
    if (!tray) tray = createTray();
    closeBehaviour = "tray";
    return;
  }
  tray?.destroy();
  tray = null;
  closeBehaviour = "quit";
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function quitFromTray() {
  /*
   * Not `app.quit()` with a flag already set. Setting `isQuitting` here meant
   * `before-quit` returned early, and that handler is where the local service
   * is stopped — so quitting from the tray left the Next child process running
   * with nothing supervising it. `before-quit` sets the flag itself.
   */
  tray?.destroy();
  tray = null;
  app.quit();
}

/**
 * Whether a saved rectangle still lands on a display attached right now.
 *
 * Requires a real overlap, not merely an intersection: a window whose top
 * corner is on a monitor but whose body is entirely off it is not reachable.
 */
function isBoundsOnAScreen(bounds: { x: number; y: number; width: number; height: number }): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return overlapX > 80 && overlapY > 80;
  });
}

async function createMainWindow(initialPath: string): Promise<BrowserWindow> {
  if (!desktopPaths || !nextServer || !logger) throw new Error("Desktop runtime is not initialized.");

  configureDesktopSession({
    session: session.defaultSession,
    origin: nextServer.origin,
    development: !packagedRuntime,
    logger,
  });
  await setDesktopCookie(nextServer.origin);

  /*
  * Reopening where the user left it, but only if that place still exists.
  * Bounds saved on a monitor that has since been unplugged would otherwise
  * place the window off-screen with no way to drag it back.
  */
  const savedBounds = !smokeTest ? await settingsStore?.getView().then((view) => view.windowBounds).catch(() => null) : null;
  const usableBounds = savedBounds && isBoundsOnAScreen(savedBounds) ? savedBounds : null;

  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: PRODUCT_NAME,
    ...windowAppearance(process.platform),
    autoHideMenuBar: true,
    webPreferences: {
      preload: desktopPaths.preloadFile,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !packagedRuntime,
    },
  });
  if (usableBounds) {
    window.setBounds(usableBounds);
  }

  Menu.setApplicationMenu(null);
  secureBrowserWindow({ window, origin: nextServer.origin, logger });
  window.once("ready-to-show", () => {
    if (!smokeTest) window.show();
  });

  /*
   * Where the window was, and where closing it goes.
   *
   * Geometry is saved on move and resize rather than on exit, so a crash or a
   * forced quit does not lose it. The bounds are re-validated against the
   * displays that exist *now*, because a window saved on a monitor that is no
   * longer attached would otherwise open off-screen with no way to reach it.
   *
   * Closing to the tray is the user's explicit choice and never the default: a
   * process that keeps running unasked is one they did not agree to, and it is
   * harder to notice and harder to stop than one that exits when told to.
   */
  const rememberBounds = debounce(() => {
    if (window.isDestroyed() || window.isMinimized() || window.isMaximized() || window.isFullScreen()) return;
    void settingsStore
      ?.saveWindowBounds(window.getBounds())
      .catch((error) => logger?.warn("Could not remember window size", error));
  }, 400);
  window.on("resize", rememberBounds);
  window.on("move", rememberBounds);
  window.on("close", (event) => {
    // Everything this needs is already known: anything read here would be a
    // promise, and by the time it settled the window would already be gone.
    if (isQuitting || smokeTest || closeBehaviour !== "tray" || !tray) return;
    event.preventDefault();
    window.hide();
  });

  // The page draws the caption, so the window verbs have to be reachable from
  // it. `titleBarStyle: "hidden"` removes the native controls, which means
  // nothing else would restore, minimise or close this window.
  const sendMaximized = () => {
    if (!window.isDestroyed()) window.webContents.send("desktop:window:maximized", window.isMaximized());
  };
  window.on("maximize", sendMaximized);
  window.on("unmaximize", sendMaximized);
  window.on("restore", sendMaximized);
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  await window.loadURL(`${nextServer.origin}${initialPath}`);
  return window;
}

async function runSmokeAssertion() {
  if (!mainWindow || !nextServer) throw new Error("Smoke-test window was not created.");
  const result = (await mainWindow.webContents.executeJavaScript(
    `Promise.all([
      fetch('/api/health', { cache: 'no-store' }).then(async (response) => ({ status: response.status, body: await response.json() })),
      fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Desktop restart smoke test' })
      }).then(async (response) => ({ status: response.status, body: await response.json() })),
      window.privateAiDesktop.getRuntimeInfo(),
      window.privateAiDesktop.getSettings()
    ]).then(([health, conversation, runtime, settings]) => ({ health, conversation, runtime, settings }))`,
    true,
  )) as {
    health?: { status?: number; body?: { status?: string } };
    conversation?: { status?: number; body?: { data?: { id?: string } } };
    runtime?: { packaged?: boolean };
    settings?: { hasOpenrouterApiKey?: boolean; hasDeepseekApiKey?: boolean; encryptionAvailable?: boolean };
  };
  if (result.health?.status !== 200 || result.health.body?.status !== "ok") {
    throw new Error(`Desktop renderer health check failed: ${JSON.stringify(result)}`);
  }
  const conversationId = result.conversation?.body?.data?.id;
  if (
    result.conversation?.status !== 201 ||
    !conversationId ||
    result.runtime?.packaged !== packagedRuntime ||
    result.settings?.hasOpenrouterApiKey !== true ||
    result.settings?.hasDeepseekApiKey !== true ||
    result.settings.encryptionAvailable !== true
  ) {
    throw new Error("Desktop renderer bridge or authenticated API smoke check failed.");
  }

  // The caption is drawn by the page, so the real window is the only place its
  // behaviour can be checked: a browser build has no bridge and no window state.
  //
  // Geometry alone proved to be a weak check. A set of buttons can be the right
  // size, in the right place, clear of the scrollbar and still be completely
  // dead, because the title row is a window drag region and the hit test honours
  // that rather than the DOM stack. So the two halves are checked separately:
  // first that each control is genuinely reachable, then that the verbs reach
  // the window.
  const caption = (await mainWindow.webContents.executeJavaScript(
    `(() => {
      const controls = window.privateAiDesktop?.windowControls;
      const labels = ["最小化", "最大化", "关闭"];
      // The narrow and wide headers each render the controls and only one is
      // displayed at a time, so a hidden copy measures 0x0. Take the visible
      // ones or this fails on a layout that is correct.
      const nodes = labels
        .map(label => [...document.querySelectorAll('button[aria-label="' + label + '"]')]
          .find(node => node.getClientRects().length > 0))
        .filter(Boolean);
      return {
        bridge: Boolean(controls),
        verbs: ["minimize", "toggleMaximize", "close"].every(key => typeof controls?.[key] === "function"),
        state: typeof controls?.state === "function",
        count: nodes.length,
        heights: nodes.map(node => Math.round(node.getBoundingClientRect().height)),
        barHeights: nodes.map(node => node.closest(".workspace-topbar")?.clientHeight ?? 0),
        widths: nodes.map(node => Math.round(node.getBoundingClientRect().width)),
        // clientWidth excludes the document scrollbar; anything past it is drawn
        // over the scrollbar gutter.
        lastRight: nodes.length
          ? Math.round(nodes[nodes.length - 1].getBoundingClientRect().right)
          : 0,
        contentRight: document.documentElement.clientWidth,
        // The app-region property is not inherited: a no-drag wrapper leaves its
        // buttons inside the drag region, where a click moves the window
        // instead of firing. Only a per-button opt-out is visible here.
        regions: nodes.map(node => getComputedStyle(node).webkitAppRegion || "-"),
        // Nothing may cover a control's centre, or the pointer never reaches it.
        covering: nodes.map(node => {
          const box = node.getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          if (!hit) return "none";
          return hit === node || node.contains(hit) ? "ok" : (hit.getAttribute("aria-label") || hit.tagName);
        })
      };
    })()`,
    true,
  )) as {
    bridge: boolean; verbs: boolean; state: boolean; count: number;
    heights: number[]; barHeights: number[]; widths: number[]; lastRight: number; contentRight: number;
    regions: string[]; covering: string[];
  };
  if (!caption.bridge || !caption.verbs || !caption.state) {
    throw new Error(`Desktop window-control bridge is incomplete: ${JSON.stringify(caption)}`);
  }
  if (caption.count !== 3) {
    throw new Error(`Expected 3 drawn window controls, found ${caption.count}: ${JSON.stringify(caption)}`);
  }
  if (caption.regions.some(region => region !== "no-drag")) {
    throw new Error(`A window control sits inside a drag region: ${JSON.stringify(caption)}`);
  }
  if (caption.covering.some(entry => entry !== "ok")) {
    throw new Error(`Something covers a window control: ${JSON.stringify(caption)}`);
  }
  // A zero-height caption button is invisible and unclickable, which is exactly
  // what an `h-full` button inside an auto-height wrapper produces.
  if (caption.heights.some((height, index) => height < 32 || height !== caption.barHeights[index]) || caption.widths.some(width => width < 24)) {
    throw new Error(`Window controls are not full-height clickable targets: ${JSON.stringify(caption)}`);
  }
  if (caption.lastRight > caption.contentRight) {
    throw new Error(`The window controls overlap the document scrollbar: ${JSON.stringify(caption)}`);
  }
  async function verifyCanvasTransparency() {
    if (process.platform !== "win32") return;
    const image = await mainWindow!.capturePage();
    const bitmap = image.toBitmap();
    const size = image.getSize();
    const alpha = (x: number, y: number) => bitmap[(Math.floor(y * size.height) * size.width + Math.floor(x * size.width)) * 4 + 3];
    const sidebarAlpha = alpha(0.04, 0.55);
    const dockAlpha = alpha(0.55, 0.98);
    const headerAlpha = alpha(0.8, 0.02);
    const canvasAlpha = [alpha(0.55, 0.3), alpha(0.65, 0.6), alpha(0.7, 0.4)];
    if (sidebarAlpha !== 255 || dockAlpha !== 255 || headerAlpha !== 255 || !canvasAlpha.some(value => value >= 210 && value < 240)) {
      throw new Error(`Desktop canvas transparency is incorrect: ${JSON.stringify({ sidebarAlpha, dockAlpha, headerAlpha, canvasAlpha })}`);
    }
    logger?.info("Verified opaque sidebar and translucent desktop canvas", { sidebarAlpha, canvasAlpha });
  }

  await verifyCanvasTransparency();

  // Drive the bridge exactly as a click does, and require the window to change.
  const captionWindow = mainWindow;
  if (captionWindow && !captionWindow.isMaximized()) {
    const maximized = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 8000);
      captionWindow.once("maximize", () => { clearTimeout(timer); resolve(true); });
    });
    await captionWindow.webContents.executeJavaScript(
      "window.privateAiDesktop.windowControls.toggleMaximize()",
      true,
    );
    if (!(await maximized)) {
      throw new Error(`The maximise caption verb did not reach the window: ${JSON.stringify(caption)}`);
    }
    await verifyCanvasTransparency();
    const restored = new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), 8000);
      captionWindow.once("unmaximize", () => { clearTimeout(timer); resolve(true); });
    });
    captionWindow.unmaximize();
    if (!(await restored)) throw new Error("The transparent window did not restore after maximization");
    const bounds = captionWindow.getBounds();
    captionWindow.setSize(1100, 720);
    await captionWindow.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await verifyCanvasTransparency();
    captionWindow.setBounds(bounds);
  }

  const unauthenticatedResponse = await fetch(`${nextServer.origin}/api/conversations`);
  if (unauthenticatedResponse.status !== 403) {
    throw new Error(`Desktop API accepted a request without the session cookie (${unauthenticatedResponse.status}).`);
  }
  const deniedBody = await unauthenticatedResponse.json() as { error?: { code?: string } };
  if (deniedBody.error?.code !== "FORBIDDEN") throw new Error("Desktop authentication error contract changed");
  const invalidHeaders: Record<string, string>[] = [
    { Origin: "https://outside.invalid" },
    { Host: "outside.invalid" },
  ];
  for (const headers of invalidHeaders) {
    // Fetch can replace a supplied Host; raw HTTP verifies the actual wire boundary.
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${nextServer!.origin}/api/conversations`, {
        method: "POST", headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${desktopSessionToken}`, "Content-Type": "application/json", ...headers },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
        response.on("error", reject);
      });
      request.on("error", reject);
      request.setTimeout(10_000, () => request.destroy(new Error("Desktop boundary check timed out")));
      request.end(JSON.stringify({ title: "Must not be created" }));
    });
    if (status !== 403) throw new Error(`Desktop ${Object.keys(headers).join(",")} boundary check returned ${status}`);
  }
  for (let index = 0; index < 31; index++) {
    const response = await fetch(`${nextServer.origin}/api/chat`, {
      method: "POST", headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${desktopSessionToken}`, "Content-Type": "application/json", Origin: nextServer.origin }, body: "{}",
    });
    const payload = await response.json() as { error?: { code?: string } };
    if (response.status !== (index < 30 ? 400 : 429) || payload.error?.code !== (index < 30 ? "VALIDATION_ERROR" : "RATE_LIMITED")) {
      throw new Error("Desktop validation or chat throttle check failed");
    }
    if (index === 30 && !response.headers.get("retry-after")) throw new Error("Desktop rate limit is missing retry information");
  }

  const mediaBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8XcAAAAASUVORK5CYII=";
  const mediaBytes = Buffer.from(mediaBase64, "base64");
  const form = new FormData();
  form.append("files", new Blob([mediaBytes], { type: "image/png" }), "smoke.png");
  const uploadResponse = await fetch(`${nextServer.origin}/api/media/upload`, {
    method: "POST", headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${desktopSessionToken}` }, body: form,
  });
  const uploaded = await uploadResponse.json() as { data?: Array<{ assetId: string; url: string; relativePath: string; mediaType: string }> };
  const asset = uploaded.data?.[0];
  if (!uploadResponse.ok || !asset || !desktopPaths || !existsSync(join(desktopPaths.mediaDirectory, asset.relativePath))) throw new Error("Desktop media upload did not persist in the data directory");
  const messageResponse = await fetch(`${nextServer.origin}/api/conversations/${conversationId}/messages`, {
    method: "POST", headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${desktopSessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "user", content: "__USER_MESSAGE__:" + JSON.stringify({ type: "user-message", text: "Smoke attachment", files: [{ url: asset.url, mediaType: asset.mediaType }] }) }),
  });
  if (!messageResponse.ok) throw new Error("Desktop media reference did not persist");
  if ((await fetch(`${nextServer.origin}${asset.url}`)).status !== 403) throw new Error("Desktop media allowed unauthenticated access");

  const documentFixtures = JSON.parse(process.env.DESKTOP_SMOKE_DOCUMENTS || "[]") as Array<{ filename: string; data: string; expected: string; pageNumber: number | null }>;
  if (documentFixtures.length !== 2) throw new Error("Desktop document smoke fixtures are missing");
  const importedDocuments: { id: string; expected: string; pageNumber: number | null }[] = [];
  for (const fixture of documentFixtures) {
    const documentForm = new FormData();
    documentForm.append("file", new Blob([Buffer.from(fixture.data, "base64")]), fixture.filename);
    const imported = await fetch(`${nextServer.origin}/api/documents`, { method: "POST", headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${desktopSessionToken}` }, body: documentForm });
    const payload = await imported.json() as { data?: { document?: { id?: string } } };
    if (!imported.ok || !payload.data?.document?.id) throw new Error(`Desktop document import failed (${fixture.filename}, ${imported.status})`);
    const id = payload.data.document.id;
    if ((await fetch(`${nextServer.origin}/api/documents/${id}`)).status !== 403) throw new Error("Desktop document allowed unauthenticated access");
    importedDocuments.push({ id, expected: fixture.expected, pageNumber: fixture.pageNumber });
  }

  await reminderPoller?.poll();
  const reminderId = seedTaskReminderSmoke(desktopPaths.databaseFile, conversationId);
  await reminderPoller?.poll();
  await reminderPoller?.poll();
  if (smokeReminders.filter(task => task.id === reminderId).length !== 1) throw new Error("Desktop task notification was missing or duplicated");
  const completeReminder = () => fetch(`${nextServer!.origin}/api/tasks/${reminderId}`, {
    method: "PATCH", headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${desktopSessionToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }),
  });
  const completed = await completeReminder();
  const completion = await completed.json() as { nextTask?: { id: string; dueDate: string; reminderEnabled: boolean } };
  if (!completed.ok || !completion.nextTask?.reminderEnabled || Date.parse(completion.nextTask.dueDate) <= Date.now()) throw new Error("Desktop recurring task did not create a future reminder");

  await prepareConversationSmoke(nextServer.origin, `${DESKTOP_COOKIE_NAME}=${desktopSessionToken}`, conversationId);
  const libraryFixture = seedMediaLibrarySmoke(desktopPaths.databaseFile, desktopPaths.mediaDirectory, asset.assetId, conversationId);
  await prepareAccountSettingsSmoke(nextServer.origin, `${DESKTOP_COOKIE_NAME}=${desktopSessionToken}`);
  await restartLocalService();
  if (!nextServer) throw new Error("Desktop service did not restart.");
  await reminderPoller?.poll();
  if (smokeReminders.filter(task => task.id === reminderId).length !== 1) throw new Error("Desktop reminder replayed after service restart");
  const repeatedCompletion = await completeReminder();
  if (!repeatedCompletion.ok || (await repeatedCompletion.json() as { nextTask?: unknown }).nextTask !== null) throw new Error("Desktop task completion replay created a duplicate");
  const nextReminder = await fetch(`${nextServer.origin}/api/tasks/${completion.nextTask.id}`, { headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${desktopSessionToken}` } });
  if (!nextReminder.ok) throw new Error("Desktop recurring task did not survive restart");
  const persistedResponse = await fetch(`${nextServer.origin}/api/conversations`, {
    headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${desktopSessionToken}` },
  });
  const persistedPayload = (await persistedResponse.json()) as { data?: Array<{ id?: string }> };
  if (!persistedResponse.ok || !persistedPayload.data?.some((conversation) => conversation.id === conversationId)) {
    throw new Error("Desktop conversation did not persist across a local service restart.");
  }
  const persistedMedia = await fetch(`${nextServer.origin}${asset.url}`, { headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${desktopSessionToken}` } });
  if (!persistedMedia.ok || !Buffer.from(await persistedMedia.arrayBuffer()).equals(mediaBytes)) throw new Error("Desktop media did not survive a service restart");
  for (const document of importedDocuments) {
    const retained = await fetch(`${nextServer.origin}/api/documents/${document.id}`, { headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${desktopSessionToken}` } });
    const payload = await retained.json() as { data?: { chunks?: Array<{ text: string; pageNumber: number | null }> } };
    if (!retained.ok || !payload.data?.chunks?.some(chunk => chunk.text.includes(document.expected) && chunk.pageNumber === document.pageNumber)) throw new Error("Desktop document did not survive a service restart");
    const search = await fetch(`${nextServer.origin}/api/documents/search`, { method: "POST", headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${desktopSessionToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: document.expected }) });
    const results = await search.json() as { data?: Array<{ documentId: string }> };
    if (!search.ok || !results.data?.some(result => result.documentId === document.id)) throw new Error("Desktop document index did not survive a service restart");
  }
  await verifyConversationSmoke(mainWindow!, nextServer.origin, `${DESKTOP_COOKIE_NAME}=${desktopSessionToken}`, conversationId, dirname(desktopPaths.databaseFile));
  await verifyMediaLibrarySmoke(mainWindow!, nextServer.origin, `${DESKTOP_COOKIE_NAME}=${desktopSessionToken}`, libraryFixture, asset.assetId, mediaBytes, dirname(desktopPaths.databaseFile));
  await reminderPoller?.stop();
  await verifyAccountBackupSmoke(mainWindow!, nextServer.origin, `${DESKTOP_COOKIE_NAME}=${desktopSessionToken}`, dirname(desktopPaths.databaseFile), async () => { await restartLocalService(); return nextServer!.origin; });
  const log = readFileSync(desktopPaths.logFile, "utf8");
  if (!log.includes("Next stdout") || log.includes(`desktop-smoke-key-${process.pid}`) || statSync(desktopPaths.logFile).size > DESKTOP_LOG_LIMITS.maxBytes) {
    throw new Error("Desktop service output did not use bounded, redacted logging");
  }
  logger?.info("Desktop Electron smoke test passed");
}

async function bootstrap() {
  await app.whenReady();
  /*
    Windows groups a taskbar entry and routes a notification by this id, and
    Squirrel builds it from the installation name it was packaged under. It has
    to match that name exactly: leaving the old one here while the installer now
    says RiA gives a window whose taskbar group and notifications belong to an
    application that no longer exists.
  */
  app.setAppUserModelId("com.squirrel.RiA.RiA");

  desktopPaths = resolveDesktopPaths({
    isPackaged: packagedRuntime,
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath("userData"),
    compiledDirectory: __dirname,
    projectRootOverride: process.env.DESKTOP_PROJECT_ROOT,
    runtimeDirectoryOverride: process.env.DESKTOP_RUNTIME_DIR,
    dataDirectoryOverride: process.env.DESKTOP_DATA_DIR,
  });
  logger = createDesktopLogger(desktopPaths.logFile);
  logger.info("Starting desktop application", {
    version: applicationVersion,
    packagedRuntime,
    platform: process.platform,
  });

  runWorkspaceUpgrade({ desktopPaths, logger });

  runDesktopMigrations({
    databaseFile: desktopPaths.databaseFile,
    migrationsDirectory: desktopPaths.migrationsDirectory,
    backupsDirectory: desktopPaths.backupsDirectory,
    logger,
  });
  settingsStore = new DesktopSettingsStore(desktopPaths.settingsFile);
  if (smokeTest) {
    const smokeSecret = `desktop-smoke-key-${process.pid}`;
    // Both providers are seeded so the smoke proves a second key is stored and
    // cleared on its own, not just that one key happens to work.
    const deepseekSecret = `desktop-smoke-deepseek-${process.pid}`;
    await settingsStore.save({ openrouterApiKey: smokeSecret, deepseekApiKey: deepseekSecret });
    const storedSettings = readFileSync(desktopPaths.settingsFile, "utf8");
    if (storedSettings.includes(smokeSecret) || storedSettings.includes(deepseekSecret)) {
      throw new Error("Desktop settings stored an API key without encryption.");
    }
    const smokeView = await settingsStore.getView();
    if (!smokeView.hasOpenrouterApiKey || !smokeView.hasDeepseekApiKey) {
      throw new Error("Desktop settings did not report both provider keys as configured.");
    }
    await settingsStore.save({ clearDeepseekApiKey: true });
    const clearedView = await settingsStore.getView();
    if (clearedView.hasDeepseekApiKey || !clearedView.hasOpenrouterApiKey) {
      throw new Error("Clearing one provider key disturbed another.");
    }
    await settingsStore.save({ deepseekApiKey: deepseekSecret });
  }
  desktopSessionToken = randomBytes(32).toString("hex");
  serverPort = await findAvailablePort();
  nextServer = await launchNextServer();
  registerIpcHandlers();

  const settings = await settingsStore.getView();
  // The welcome page is for an installation that cannot call any model at all.
  // Keying it on one provider sent a workspace configured only for DeepSeek to
  // the settings screen on every launch, asking for a key it does not need.
  const hasAnyProviderKey = settings.hasOpenrouterApiKey || settings.hasDeepseekApiKey;
  const initialPath = packagedRuntime && !hasAnyProviderKey ? "/settings?welcome=1" : "/chat";
  mainWindow = await createMainWindow(initialPath);
  reminderPoller = new TaskReminderPoller({
    connection: () => nextServer ? { origin: nextServer.origin, cookie: `${DESKTOP_COOKIE_NAME}=${desktopSessionToken}` } : null,
    supported: () => smokeTest || Notification.isSupported(),
    deliver: smokeTest ? task => { smokeReminders.push(task); } : createTaskNotificationDelivery(Notification, focusMainWindow, logger),
    logger,
  });
  reminderPoller.start();
  /*
   * The tray and the global shortcut have to be set up on a cold start, not only
   * after a settings change. They were once wired into the service-restart path
   * alone, which meant a normally launched application had neither: closing the
   * window would quit even with "keep running in the tray" chosen, and the
   * shortcut the user had set was never taken.
   */
  if (!smokeTest) {
    await applyDesktopPresence().catch((error) => {
      logger?.warn("Could not apply the desktop presence setting", error);
    });
    const hotkey = await settingsStore?.getGlobalHotkey().catch(() => "");
    if (hotkey) registerGlobalHotkey(hotkey);
  }
  const recoverAfterResume = createResumeRecovery({
    current: () => nextServer,
    quitting: () => isQuitting || restartInProgress !== null,
    healthy: async service => {
      try { return (await fetch(`${service.origin}/api/health`, { signal: AbortSignal.timeout(5000), redirect: "error" })).ok; }
      catch { return false; }
    },
    refreshSession: service => setDesktopCookie(service.origin),
    restart: () => {
      let destination = "/chat";
      try {
        const url = new URL(mainWindow?.webContents.getURL() ?? "");
        if (url.origin === nextServer?.origin) destination = `${url.pathname}${url.search}${url.hash}`;
      } catch { /* A stopped page has no local route to preserve. */ }
      return restartLocalService(destination);
    },
    poll: () => reminderPoller?.poll() ?? Promise.resolve(),
    failed: () => logger?.error("Unable to recover the local service after resume"),
  });
  powerMonitor.on("resume", () => { void recoverAfterResume(); });
  if (smokeTest) await Promise.all([recoverAfterResume(), recoverAfterResume()]);


  if (smokeTest) {
    await runSmokeAssertion();
    isQuitting = true;
    await reminderPoller.stop();
    await nextServer.stop();
    app.exit(0);
  }
}

app.on("second-instance", () => {
  focusMainWindow();
});

app.on("activate", () => {
  if (mainWindow) {
    mainWindow.show();
    return;
  }
  if (nextServer) {
    void createMainWindow("/chat").then((window) => {
      mainWindow = window;
    });
  }
});

/*
 * Closing the window with a tray present does not mean quitting. Without one
 * it does, which is the default and what happens until the user chooses
 * otherwise in settings.
 */
app.on("window-all-closed", () => {
  if (tray && !isQuitting) return;
  app.quit();
});

app.on("before-quit", (event) => {
  // A global shortcut outlives the windows that own it. Releasing it here is
  // what stops the combination staying dead in the system while the app runs on
  // with no window.
  globalShortcut.unregisterAll();
  if (isQuitting) return;
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
  if (!nextServer && !restartInProgress) {
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
    isQuitting = true;
    void (async () => { await reminderPoller?.stop(); })().finally(() => app.exit(0));
    return;
  }
  event.preventDefault();
  isQuitting = true;
  restartAbort?.abort(new Error("The application is quitting."));
  void (async () => {
    await reminderPoller?.stop();
    await restartInProgress?.catch(() => {});
    await nextServer?.stop();
  })().finally(() => app.exit(0));
});

if (singleInstanceLock && !squirrelEventHandled) {
  void bootstrap().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logger?.error("Desktop application failed to start", error);
    if (!smokeTest) dialog.showErrorBox(`${PRODUCT_NAME} failed to start`, `${message}\n\nSee the desktop log for details.`);
    isQuitting = true;
    void (async () => { await reminderPoller?.stop(); await nextServer?.stop(); })().finally(() => app.exit(1));
  });
}
