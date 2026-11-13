/* The application window: where it opens, how it closes, and what it reports. */
import { windowAppearance } from "./window-appearance";
import { createStartupPresentation } from "./startup-presentation";
import { createWindowTransitions } from "./window-transitions";
import { BrowserWindow, Menu, screen, session } from "electron";
import { configureDesktopSession, secureBrowserWindow } from "./security";
import { runtime, PRODUCT_NAME, packagedRuntime, smokeTest, windowTransitions, startupPresentations } from "./runtime-state";
import { setDesktopCookie } from "./local-service";

/**
 * Trailing-edge debounce, so dragging a window edge writes one record rather
 * than one per frame of the drag.
 */
export function debounce<T extends (...args: never[]) => void>(run: T, waitMs: number) {
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
 * Whether a saved rectangle still lands on a display attached right now.
 *
 * Requires a real overlap, not merely an intersection: a window whose top
 * corner is on a monitor but whose body is entirely off it is not reachable.
 */
export function isBoundsOnAScreen(bounds: { x: number; y: number; width: number; height: number }): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return overlapX > 80 && overlapY > 80;
  });
}

export async function createMainWindow(initialPath: string, animateStartup = false): Promise<BrowserWindow> {
  if (!runtime.desktopPaths || !runtime.nextServer || !runtime.logger) throw new Error("Desktop runtime is not initialized.");

  configureDesktopSession({
    session: session.defaultSession,
    origin: runtime.nextServer.origin,
    development: !packagedRuntime,
    logger: runtime.logger,
  });
  await setDesktopCookie(runtime.nextServer.origin);

  /*
  * Reopening where the user left it, but only if that place still exists.
  * Bounds saved on a monitor that has since been unplugged would otherwise
  * place the window off-screen with no way to drag it back.
  */
  const savedBounds = !smokeTest ? await runtime.settingsStore?.getView().then((view) => view.windowBounds).catch(() => null) : null;
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
      preload: runtime.desktopPaths.preloadFile,
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
  const transitions = process.platform === "win32"
    ? createWindowTransitions(window, error => runtime.logger?.warn("Window transition failed", error))
    : null;
  if (transitions) windowTransitions.set(window, transitions);

  Menu.setApplicationMenu(null);
  secureBrowserWindow({ window, origin: runtime.nextServer.origin, logger: runtime.logger });
  startupPresentations.set(window, createStartupPresentation(window, {
    enabled: animateStartup && !smokeTest,
    show: !smokeTest,
    onError: error => runtime.logger?.warn("Unable to present the desktop window", error),
  }));

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
    void runtime.settingsStore
      ?.saveWindowBounds(window.getBounds())
      .catch((error) => runtime.logger?.warn("Could not remember window size", error));
  }, 400);
  window.on("resize", rememberBounds);
  window.on("move", rememberBounds);
  window.on("close", (event) => {
    if (!runtime.isQuitting && !smokeTest && transitions && !transitions.isClosing()) {
      event.preventDefault();
      transitions.request("close");
      return;
    }
    // Everything this needs is already known: anything read here would be a
    // promise, and by the time it settled the window would already be gone.
    if (runtime.isQuitting || smokeTest || runtime.closeBehaviour !== "tray" || !runtime.tray) return;
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
    if (runtime.mainWindow === window) runtime.mainWindow = null;
  });
  // A stalled or lost renderer freezes the page while the process itself stays
  // healthy, so this log is the only evidence such a report leaves behind.
  let unresponsiveSince = 0;
  window.on("unresponsive", () => {
    unresponsiveSince = Date.now();
    runtime.logger?.warn("Window stopped responding");
  });
  window.on("responsive", () => {
    if (unresponsiveSince) runtime.logger?.info("Window responding again", { stalledMs: Date.now() - unresponsiveSince });
    unresponsiveSince = 0;
  });
  window.webContents.on("render-process-gone", (_event, details) => runtime.logger?.error("Renderer process gone", details));
  if (smokeTest && process.env.DESKTOP_SMOKE_START_MAXIMIZED === "1") {
    window.maximize();
  }
  await window.loadURL(`${runtime.nextServer.origin}${initialPath}`);
  return window;
}
