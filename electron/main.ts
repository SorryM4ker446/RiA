import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  type IpcMainInvokeEvent,
} from "electron";
import { createDesktopLogger, type DesktopLogger } from "./logger";
import { runDesktopMigrations } from "./migrations";
import { findAvailablePort, startNextServer, type RunningNextServer } from "./next-server";
import { resolveDesktopPaths, toSqliteUrl, type DesktopPaths } from "./paths";
import { configureDesktopSession, secureBrowserWindow } from "./security";
import { DesktopSettingsStore, type DesktopSettingsInput } from "./settings";
import { handleSquirrelStartupEvent } from "./squirrel";

const PRODUCT_NAME = "Private AI Assistant";
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

function assertTrustedIpcSender(event: IpcMainInvokeEvent) {
  if (!nextServer) throw new Error("Desktop service is not ready.");
  const senderUrl = event.sender.getURL();
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
    logFile: desktopPaths.logFile,
    environment: await resolveServerEnvironment(),
    logger,
  });
}

async function setDesktopCookie(origin: string) {
  await session.defaultSession.cookies.set({
    url: origin,
    name: DESKTOP_COOKIE_NAME,
    value: desktopSessionToken,
    httpOnly: true,
    secure: false,
    sameSite: "strict",
    expirationDate: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
  });
}

async function restartLocalService() {
  if (restartInProgress) return restartInProgress;
  restartInProgress = (async () => {
    if (!logger) return;
    logger.info("Restarting local Next.js service after settings update");
    if (nextServer) await nextServer.stop();
    nextServer = await launchNextServer();
    await setDesktopCookie(nextServer.origin);
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(`${nextServer.origin}/settings?saved=1`);
    }
  })().finally(() => {
    restartInProgress = null;
  });
  return restartInProgress;
}

function registerIpcHandlers() {
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
    backgroundColor: "#0b0f19",
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

  const unauthenticatedResponse = await fetch(`${nextServer.origin}/api/conversations`);
  if (unauthenticatedResponse.status !== 403) {
    throw new Error(`Desktop API accepted a request without the session cookie (${unauthenticatedResponse.status}).`);
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

  await restartLocalService();
  if (!nextServer) throw new Error("Desktop service did not restart.");
  const persistedResponse = await fetch(`${nextServer.origin}/api/conversations`, {
    headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${desktopSessionToken}` },
  });
  const persistedPayload = (await persistedResponse.json()) as { data?: Array<{ id?: string }> };
  if (!persistedResponse.ok || !persistedPayload.data?.some((conversation) => conversation.id === conversationId)) {
    throw new Error("Desktop conversation did not persist across a local service restart.");
  }
  const persistedMedia = await fetch(`${nextServer.origin}${asset.url}`, { headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${desktopSessionToken}` } });
  if (!persistedMedia.ok || !Buffer.from(await persistedMedia.arrayBuffer()).equals(mediaBytes)) throw new Error("Desktop media did not survive a service restart");
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

  if (smokeTest) {
    await runSmokeAssertion();
    isQuitting = true;
    await nextServer.stop();
    app.exit(0);
  }
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
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
  void nextServer.stop().finally(() => app.exit(0));
});

if (singleInstanceLock && !squirrelEventHandled) {
  void bootstrap().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logger?.error("Desktop application failed to start", error);
    if (!smokeTest) dialog.showErrorBox(`${PRODUCT_NAME} failed to start`, `${message}\n\nSee the desktop log for details.`);
    isQuitting = true;
    void nextServer?.stop().finally(() => app.exit(1));
  });
}
