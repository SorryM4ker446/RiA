/* The tray, the global shortcut, and bringing the window forward: how the desktop app is reached while it runs. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, Menu, Tray, globalShortcut } from "electron";
import { runtime, PRODUCT_NAME } from "./runtime-state";

/** Brings the window forward, on a page inside the app when the notice names one. */
export function openFromNotice(path: string | null) {
  focusMainWindow();
  // The page moves itself, so a draft and the rest of its state survive the move.
  if (path && runtime.mainWindow && !runtime.mainWindow.isDestroyed()) runtime.mainWindow.webContents.send("desktop:navigate", path);
}

export function focusMainWindow() {
  if (!runtime.mainWindow || runtime.mainWindow.isDestroyed()) return;
  if (runtime.mainWindow.isMinimized()) runtime.mainWindow.restore();
  runtime.mainWindow.show();
  runtime.mainWindow.focus();
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
export function trayIconCandidates(): string[] {
  return [
    join(process.resourcesPath, "assets", "desktop-icon.png"),
    join(__dirname, "..", "assets", "desktop-icon.png"),
    join(runtime.desktopPaths?.projectRoot ?? process.cwd(), "assets", "desktop-icon.png"),
  ];
}

export function trayIconPath(): string | null {
  return trayIconCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * RiA's own picture in a notification, so it never depends on how Windows has
 * resolved the application ID to a name and icon.
 */
export function notificationIcon(): { icon?: string } {
  const icon = trayIconPath();
  return icon ? { icon } : {};
}

export function createTray(): Tray {
  const iconPath = trayIconPath();
  if (!iconPath) throw new Error(`The tray icon is missing: ${trayIconCandidates().join(", ")}`);
  const created = new Tray(iconPath);
  created.setToolTip(PRODUCT_NAME);
  updateTrayMenu(created);
  // A left click on the icon is the ordinary way back to the window.
  created.on("click", () => showMainWindow());
  return created;
}

export function updateTrayMenu(target: Tray) {
  const english = runtime.settingsStore?.getLocale() === "en-US";
  target.setContextMenu(Menu.buildFromTemplate([
    { label: english ? "Open RiA" : "打开 RiA", click: () => showMainWindow() },
    { type: "separator" },
    { label: english ? "Quit" : "退出", click: () => quitFromTray() }
  ]));
}

/**
 * Why a shortcut did not take, in words the settings screen can show.
 *
 * `register` returning false means another program already owns the
 * combination. That is reported rather than swallowed: a shortcut that silently
 * does nothing is worse than one the user is told is taken.
 */
export type HotkeyOutcome = { ok: true; hotkey: string } | { ok: false; hotkey: string; reason: "conflict" | "invalid" | "not-stored" };

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

export function registerGlobalHotkey(accelerator: string): HotkeyOutcome {
  const wanted = accelerator.trim();
  if (!wanted) {
    globalShortcut.unregisterAll();
    runtime.activeAccelerator = "";
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
  if (runtime.activeAccelerator === wanted && globalShortcut.isRegistered(wanted)) {
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
    return { ok: false, hotkey: runtime.activeAccelerator, reason: "invalid" };
  }
  if (!registered) {
    runtime.logger?.warn("Global shortcut was already taken by another program", { accelerator: wanted });
    return { ok: false, hotkey: runtime.activeAccelerator, reason: "conflict" };
  }
  // The new combination is held; only now is the previous one released.
  if (runtime.activeAccelerator && runtime.activeAccelerator !== wanted) globalShortcut.unregister(runtime.activeAccelerator);
  runtime.activeAccelerator = wanted;
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
export async function applyDesktopPresence(): Promise<void> {
  const behaviour = (await runtime.settingsStore?.getCloseBehaviour().catch(() => "quit")) ?? "quit";
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
    if (!runtime.tray) runtime.tray = createTray();
    runtime.closeBehaviour = "tray";
    return;
  }
  runtime.tray?.destroy();
  runtime.tray = null;
  runtime.closeBehaviour = "quit";
}

export function showMainWindow() {
  if (!runtime.mainWindow || runtime.mainWindow.isDestroyed()) return;
  if (runtime.mainWindow.isMinimized()) runtime.mainWindow.restore();
  runtime.mainWindow.show();
  runtime.mainWindow.focus();
}

export function quitFromTray() {
  /*
   * Not `app.quit()` with a flag already set. Setting `isQuitting` here meant
   * `before-quit` returned early, and that handler is where the local service
   * is stopped — so quitting from the tray left the Next child process running
   * with nothing supervising it. `before-quit` sets the flag itself.
   */
  runtime.tray?.destroy();
  runtime.tray = null;
  app.quit();
}
