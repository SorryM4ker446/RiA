/*
 * The state the desktop main process shares between its parts (the local
 * service, the window, the tray and shortcut, updates, the IPC handlers), and
 * the facts about this run that do not change.
 */
import { app, type BrowserWindow, type Notification, type Tray } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { createWindowTransitions } from "./window-transitions";
import type { createStartupPresentation } from "./startup-presentation";
import type { RunningNextServer } from "./next-server";
import type { DesktopPaths } from "./paths";
import type { DesktopLogger } from "./logger";
import type { DesktopSettingsStore } from "./settings";
import type { TaskNotice, TaskReminderPoller } from "./task-reminders";
import type { ConversationAlerts } from "./conversation-alerts";
import type { UpdateService } from "./updater";

export const PRODUCT_NAME = "RiA";
export const DESKTOP_COOKIE_NAME = "desktop_session";
const forcePackagedRuntime = process.env.DESKTOP_FORCE_PACKAGED === "1";
export const packagedRuntime = app.isPackaged || forcePackagedRuntime;
export const smokeTest = process.env.DESKTOP_SMOKE_TEST === "1";
export const applicationVersion = packagedRuntime
  ? app.getVersion()
  : (JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string }).version;

export const windowTransitions = new WeakMap<BrowserWindow, ReturnType<typeof createWindowTransitions>>();
export const startupPresentations = new WeakMap<BrowserWindow, ReturnType<typeof createStartupPresentation>>();
/** Task notices a smoke run collects instead of showing. */
export const smokeReminders: TaskNotice[] = [];

/** What the main process holds while it runs, shared by its parts. */
export const runtime: {
  mainWindow: BrowserWindow | null;
  nextServer: RunningNextServer | null;
  desktopPaths: DesktopPaths | null;
  logger: DesktopLogger | null;
  settingsStore: DesktopSettingsStore | null;
  desktopSessionToken: string;
  serverPort: number;
  isQuitting: boolean;
  restartInProgress: Promise<void> | null;
  /*
   * Cancels the launch a restart is in the middle of. The restart clears the old
   * service before it has a new one to point at, so for as long as that takes the
   * only handle on the child process being launched is this one.
   */
  restartAbort: AbortController | null;
  reminderPoller: TaskReminderPoller | null;
  /** Notifications for answers that end while the window is not in front; started and stopped with the poller. */
  conversationAlerts: ConversationAlerts | null;
  /**
   * Present only when the user chose to keep the app running when the window
   * closes. Its absence is meaningful: without it, closing the window closes
   * the app, which is the default and the only behaviour on offer at first run.
   */
  tray: Tray | null;
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
  closeBehaviour: "quit" | "tray";
  updateService: UpdateService | null;
  /** One system notification per version per run; the settings card stays the record. */
  notifiedUpdateVersion: string | null;
  updateNotification: Notification | null;
  /*
   * The combination currently held by the operating system, so a refusal can say
   * which one is still in force rather than which one was asked for. Releasing it
   * before the replacement is known to be registerable is what used to leave a
   * working shortcut dead after a typo: the old one went, the new one never took,
   * and the stored setting still named the old one.
   */
  activeAccelerator: string;
} = {
  mainWindow: null, nextServer: null, desktopPaths: null, logger: null, settingsStore: null,
  desktopSessionToken: "", serverPort: 0, isQuitting: false, restartInProgress: null, restartAbort: null,
  reminderPoller: null, conversationAlerts: null, tray: null, closeBehaviour: "quit",
  updateService: null, notifiedUpdateVersion: null, updateNotification: null, activeAccelerator: "",
};
