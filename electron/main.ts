import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { request as httpRequest } from "node:http";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  powerMonitor,
  session,
  type IpcMainInvokeEvent,
} from "electron";
import { createDesktopLogger, DESKTOP_LOG_LIMITS, type DesktopLogger } from "./logger";
import { runDesktopMigrations } from "./migrations";
import { runWorkspaceUpgrade } from "./desktop-workspace-upgrade";
import { findAvailablePort, startNextServer, type RunningNextServer } from "./next-server";
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
let reminderPoller: TaskReminderPoller | null = null;
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
    for (const key of ["OPENROUTER_API_KEY", "TAVILY_API_KEY", "OUTBOUND_PROXY_URL"] as const) {
      if (!settingsEnvironment[key]) delete settingsEnvironment[key];
    }
  }
  return settingsEnvironment;
}

async function launchNextServer(): Promise<RunningNextServer> {
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

async function restartLocalService() {
  if (restartInProgress) return restartInProgress;
  restartInProgress = (async () => {
    if (!logger) return;
    logger.info("Restarting local Next.js service after settings update");
    await reminderPoller?.stop();
    // Stop the old renderer's HMR reconnect and requests before restarting.
    // Otherwise its reload can abort the navigation to the restarted service.
    if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL("about:blank");
    if (nextServer) await nextServer.stop();
    nextServer = await launchNextServer();
    await setDesktopCookie(nextServer.origin);
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(`${nextServer.origin}/settings?saved=1`);
    }
    reminderPoller?.start();
  })().finally(() => {
    restartInProgress = null;
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

  ipcMain.handle("desktop:settings:save", async (event, input: DesktopSettingsInput) => {
    assertTrustedIpcSender(event);
    if (!settingsStore) throw new Error("Desktop settings store is not ready.");
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Invalid desktop settings payload.");
    }
    const settings = await settingsStore.save(input);
    setTimeout(() => {
      void restartLocalService().catch((error) => {
        logger?.error("Unable to restart local service after settings update", error);
        if (!smokeTest) dialog.showErrorBox("Unable to restart", "See the desktop log for details.");
      });
    }, 150);
    return { settings, restarting: true };
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

  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: PRODUCT_NAME,
    // Matches `--background`. The app boots light, so a dark canvas here showed
    // as a flash of the wrong theme before React painted anything.
    backgroundColor: "#ffffff",
    // Hide the caption but keep the native frame, so window resizing, snap
    // layouts and assistive technology still work.
    //
    // `titleBarOverlay` is deliberately NOT set. It makes Windows paint an
    // opaque, unstyleable strip over the top-right of the page — the band this
    // design removes — and that strip also covers the document scrollbar. The
    // app draws its own controls instead; see the caption block below.
    ...(process.platform === "win32" ? { titleBarStyle: "hidden" as const } : {}),
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
  Menu.setApplicationMenu(null);
  secureBrowserWindow({ window, origin: nextServer.origin, logger });
  window.once("ready-to-show", () => {
    if (!smokeTest) window.show();
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
    settings?: { hasOpenrouterApiKey?: boolean; encryptionAvailable?: boolean };
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
    heights: number[]; widths: number[]; lastRight: number; contentRight: number;
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
  if (caption.heights.some(height => height !== 40) || caption.widths.some(width => width < 24)) {
    throw new Error(`Window controls are not full-height clickable targets: ${JSON.stringify(caption)}`);
  }
  if (caption.lastRight > caption.contentRight) {
    throw new Error(`The window controls overlap the document scrollbar: ${JSON.stringify(caption)}`);
  }

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
    captionWindow.unmaximize();
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
  app.setAppUserModelId("com.squirrel.PrivateAIAssistant.PrivateAIAssistant");

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
    await settingsStore.save({ openrouterApiKey: smokeSecret });
    if (readFileSync(desktopPaths.settingsFile, "utf8").includes(smokeSecret)) {
      throw new Error("Desktop settings stored an API key without encryption.");
    }
  }
  desktopSessionToken = randomBytes(32).toString("hex");
  serverPort = await findAvailablePort();
  nextServer = await launchNextServer();
  registerIpcHandlers();

  const settings = await settingsStore.getView();
  const initialPath = packagedRuntime && !settings.hasOpenrouterApiKey ? "/settings?welcome=1" : "/chat";
  mainWindow = await createMainWindow(initialPath);
  reminderPoller = new TaskReminderPoller({
    connection: () => nextServer ? { origin: nextServer.origin, cookie: `${DESKTOP_COOKIE_NAME}=${desktopSessionToken}` } : null,
    supported: () => smokeTest || Notification.isSupported(),
    deliver: smokeTest ? task => { smokeReminders.push(task); } : createTaskNotificationDelivery(Notification, focusMainWindow, logger),
    logger,
  });
  reminderPoller.start();
  // One handler for one event. A wake from sleep must not outlive the session
  // cookie either, so the credential is reissued for a long-lived window.
  powerMonitor.on("resume", () => {
    void reminderPoller?.poll();
    if (nextServer) void setDesktopCookie(nextServer.origin).catch((error) => {
      logger?.error("Unable to refresh the desktop session cookie after resume", error);
    });
  });

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

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (isQuitting || !nextServer) return;
  event.preventDefault();
  isQuitting = true;
  void (async () => { await reminderPoller?.stop(); await nextServer?.stop(); })().finally(() => app.exit(0));
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
