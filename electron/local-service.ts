/* The local Next.js service the window talks to: launching it, noticing it stop, and restarting it. */
import { existsSync } from "node:fs";
import { session } from "electron";
import { desktopServiceEnvironment, startNextServer, type NextServerExit, type RunningNextServer } from "./next-server";
import { toSqliteUrl } from "./paths";
import { runtime, PRODUCT_NAME, DESKTOP_COOKIE_NAME, packagedRuntime, smokeTest } from "./runtime-state";
import { applyDesktopPresence, registerGlobalHotkey } from "./desktop-presence";

export async function resolveServerEnvironment(): Promise<Record<string, string>> {
  if (!runtime.settingsStore) throw new Error("Desktop settings store is not ready.");
  return desktopServiceEnvironment(await runtime.settingsStore.getServerEnvironment());
}

export async function launchNextServer(signal?: AbortSignal): Promise<RunningNextServer> {
  if (!runtime.desktopPaths || !runtime.logger) throw new Error("Desktop paths are not initialized.");
  if (packagedRuntime && !existsSync(runtime.desktopPaths.serverEntry)) {
    throw new Error(`Packaged Next.js server is missing: ${runtime.desktopPaths.serverEntry}`);
  }

  const nodeExecutable = process.env.DESKTOP_NODE_EXECUTABLE || process.env.npm_node_execpath || "node";
  return startNextServer({
    packagedRuntime,
    projectRoot: runtime.desktopPaths.projectRoot,
    runtimeDirectory: runtime.desktopPaths.runtimeDirectory,
    serverEntry: runtime.desktopPaths.serverEntry,
    nodeExecutable,
    databaseUrl: toSqliteUrl(runtime.desktopPaths.databaseFile),
    mediaDirectory: runtime.desktopPaths.mediaDirectory,
    desktopSessionToken: runtime.desktopSessionToken,
    port: runtime.serverPort,
    environment: await resolveServerEnvironment(),
    logger: runtime.logger,
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
export function handleUnexpectedServiceExit(exit: NextServerExit): void {
  if (runtime.isQuitting) return;
  /*
   * Identity, not emptiness. A child this application has already replaced is
   * not the service it is running, and a launch that has not been adopted yet
   * is not one either — reporting either would put the window into a state
   * describing a process nothing is waiting for.
   */
  if (runtime.nextServer && runtime.nextServer.child !== exit.child) return;
  runtime.nextServer = null;
  /*
   * The poller reads `nextServer` for its connection, so clearing it also ends
   * the checks that would otherwise keep failing against a port nothing is
   * listening on, every thirty seconds, for as long as the window is open.
   */
  void (async () => {
    await runtime.reminderPoller?.stop(); await runtime.conversationAlerts?.stop();
    // The quit can land while the poller settles, and there is then nothing
    // left to tell anyone.
    if (runtime.isQuitting || !runtime.mainWindow || runtime.mainWindow.isDestroyed()) return;
    await runtime.mainWindow.loadURL(serviceStoppedPage());
  })().catch((error) => {
    // Called from a process event, where an unhandled rejection is a crash.
    runtime.logger?.warn("Unable to show the page for a stopped local service", error);
  });
}

export async function setDesktopCookie(origin: string) {
  // A session cookie lives as long as the Chromium session itself. The token
  // rotates on every launch, so a persistent expiry would only guarantee a
  // 403 wall for windows left open longer than a day.
  await session.defaultSession.cookies.set({
    url: origin,
    name: DESKTOP_COOKIE_NAME,
    value: runtime.desktopSessionToken,
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
export function serviceStoppedPage(): string {
  const document = [
    `<!doctype html><meta charset='utf-8'><title>${PRODUCT_NAME}</title>`,
    `<body style='font:15px/1.6 system-ui,sans-serif;margin:3rem auto;max-width:34rem;color:#111'>`,
    `<h1 style='font-size:1.2rem'>The local service is not running.</h1>`,
    "<p>" + PRODUCT_NAME + " could not restart it after a settings change, so nothing on this screen can reach the service.</p>",
    "<p>The details are in the desktop log. Close the application and start it again.</p>",
  ].join("");
  return `data:text/html;charset=utf-8,${encodeURIComponent(document)}`;
}

// Saving provider keys restarts the service; the window comes back to chat with
// the settings still open on those keys and a note that they were saved.
export async function restartLocalService(destination = "/chat?settings=services&saved=1") {
  if (runtime.restartInProgress) return runtime.restartInProgress;
  const abort = new AbortController();
  runtime.restartAbort = abort;
  runtime.restartInProgress = (async () => {
    if (!runtime.logger) return;
    runtime.logger.info("Restarting local Next.js service");
    await runtime.reminderPoller?.stop(); await runtime.conversationAlerts?.stop();
    if (runtime.isQuitting) return;
    // Stop the old renderer's HMR reconnect and requests before restarting.
    // Otherwise its reload can abort the navigation to the restarted service.
    //
    // The stopped server is cleared before the relaunch rather than after it. A
    // failed launch used to leave `nextServer` pointing at a process that no
    // longer existed, so `activate` built a window on a dead origin, and the one
    // already open was parked on `about:blank` — which parses as the origin the
    // string "null", a value every IPC trust check refuses. The window was then a
    // dead end the user could only recover from by killing the process.
    const stopped = runtime.nextServer;
    runtime.nextServer = null;
    if (runtime.mainWindow && !runtime.mainWindow.isDestroyed()) await runtime.mainWindow.loadURL("about:blank");
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
    if (runtime.isQuitting || abort.signal.aborted) return;
    let launched: RunningNextServer;
    try {
      launched = await launchNextServer(abort.signal);
    } catch (error) {
      if (runtime.isQuitting) return;
      // Blank is unrecoverable and says nothing, so the window states what
      // happened rather than leaving a white rectangle with no way forward.
      if (runtime.mainWindow && !runtime.mainWindow.isDestroyed()) await runtime.mainWindow.loadURL(serviceStoppedPage());
      throw error;
    }
    /*
     * The quit can land while the new service is still booting. The child is a
     * separate process by then, so adopting it here would leave a listener with no
     * supervisor the instant the shell exits. It is stopped here instead, which is
     * the last moment something is still able to do so.
     */
    if (runtime.isQuitting || abort.signal.aborted) {
      runtime.logger.info("Discarding a local service that finished launching after the quit was requested");
      await launched.stop();
      return;
    }
    runtime.nextServer = launched;
    await setDesktopCookie(runtime.nextServer.origin);
    if (runtime.mainWindow && !runtime.mainWindow.isDestroyed()) {
      await runtime.mainWindow.loadURL(`${runtime.nextServer.origin}${destination}`);
    }
    runtime.reminderPoller?.start();
    runtime.conversationAlerts?.start();

    // The tray and the close behaviour follow the stored setting, including
    // after a service restart and including a change made in the running app.
    if (!smokeTest) {
      await applyDesktopPresence();
      // A shortcut the operating system refuses is not fatal: the window is
      // still reachable, and the settings screen says the combination is taken.
      const hotkey = await runtime.settingsStore?.getGlobalHotkey().catch(() => "");
      if (hotkey) registerGlobalHotkey(hotkey);
    }
  })().finally(() => {
    runtime.restartInProgress = null;
    if (runtime.restartAbort === abort) runtime.restartAbort = null;
  });
  return runtime.restartInProgress;
}
