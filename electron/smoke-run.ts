/* The checks a desktop smoke run makes against the real window and service. */
import { canvasSamplePoints, imageAlphaSampler, type CanvasGeometry } from "./workspace-transparency";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { request as httpRequest } from "node:http";
import { DESKTOP_LOG_LIMITS } from "./logger";
import { seedTaskReminderSmoke } from "./task-reminders-smoke";
import { prepareConversationSmoke, verifyConversationSmoke } from "./conversations-smoke";
import { seedMediaLibrarySmoke, verifyMediaLibrarySmoke } from "./media-library-smoke";
import { prepareAccountSettingsSmoke, verifyAccountBackupSmoke } from "./account-backup-smoke";
import { verifyDocumentProcessorSmoke } from "./document-processor-smoke";
import { runtime, DESKTOP_COOKIE_NAME, packagedRuntime, applicationVersion, smokeReminders } from "./runtime-state";
import { restartLocalService } from "./local-service";

export async function runSmokeAssertion() {
  if (!runtime.mainWindow || !runtime.nextServer) throw new Error("Smoke-test window was not created.");
  const result = (await runtime.mainWindow.webContents.executeJavaScript(
    `Promise.all([
      fetch('/api/health', { cache: 'no-store' }).then(async (response) => ({ status: response.status, body: await response.json() })),
      fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Desktop restart smoke test' })
      }).then(async (response) => ({ status: response.status, body: await response.json() })),
      window.riaDesktop.getRuntimeInfo(),
      window.riaDesktop.getSettings()
    ]).then(([health, conversation, runtime, settings]) => ({ health, conversation, runtime, settings }))`,
    true,
  )) as {
    health?: { status?: number; body?: { status?: string } };
    conversation?: { status?: number; body?: { data?: { id?: string } } };
    runtime?: { packaged?: boolean };
    settings?: { hasOpenrouterApiKey?: boolean; hasDeepseekApiKey?: boolean; encryptionAvailable?: boolean };
  };
  const updates = await runtime.mainWindow.webContents.executeJavaScript("window.riaDesktop.updates.state()", true) as { supported?: boolean; currentVersion?: string; phase?: string };
  if (updates.supported !== false || updates.currentVersion !== applicationVersion || updates.phase !== "idle") {
    throw new Error(`Desktop update bridge is not wired or not inert in a smoke run: ${JSON.stringify(updates)}`);
  }
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
  const caption = (await runtime.mainWindow.webContents.executeJavaScript(
    `(() => {
      const controls = window.riaDesktop?.windowControls;
      const selectors = [
        'button[aria-label="最小化"], button[aria-label="Minimize"]',
        'button[aria-label="最大化"], button[aria-label="向下还原"], button[aria-label="Maximize"], button[aria-label="Restore"]',
        'button[aria-label="关闭"], button[aria-label="Close"]'
      ];
      // The narrow and wide headers each render the controls and only one is
      // displayed at a time, so a hidden copy measures 0x0. Take the visible
      // ones or this fails on a layout that is correct.
      const nodes = selectors
        .map(selector => [...document.querySelectorAll(selector)]
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
  async function verifyWorkspaceTransparency() {
    if (process.platform !== "win32") return;
    const captureWindow = runtime.mainWindow!;
    const restoreHidden = !captureWindow.isVisible();
    if (restoreHidden) captureWindow.showInactive();
    try {
      await runtime.mainWindow!.webContents.executeJavaScript(`Promise.allSettled(
        document.getAnimations().filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity).map(animation => animation.finished)
      ).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
      const geometry = await captureWindow.webContents.executeJavaScript(`(() => {
        const node = document.querySelector(".chat-transcript");
        if (!node) throw new Error("The chat transcript did not render");
        const rect = node.getBoundingClientRect();
        return { viewport: { width: innerWidth, height: innerHeight }, transcript: {
          left: rect.left, top: rect.top, height: rect.height, clientLeft: node.clientLeft,
          paddingLeft: parseFloat(getComputedStyle(node).paddingLeft)
        }};
      })()`) as CanvasGeometry;
      const image = await captureWindow.capturePage();
      const alpha = imageAlphaSampler(image);
      const sidebarAlpha = alpha(0.04, 0.55);
      // Above the corner, where a development run shows Next's own badge.
      const dockAlpha = alpha(0.98, 0.92);
      const headerAlpha = alpha(0.8, 0.02);
      const canvasPoints = canvasSamplePoints(geometry);
      const canvasAlpha = canvasPoints.map(point => alpha(point.x, point.y));
      const composerPoint = await captureWindow.webContents.executeJavaScript(`(() => {
        const node = document.querySelector(".composer-surface");
        if (!node) throw new Error("The composer surface did not render");
        const rect = node.getBoundingClientRect();
        return { x: (rect.left + rect.width / 2) / innerWidth, y: (rect.top + 12) / innerHeight };
      })()`) as { x: number; y: number };
      const composerAlpha = alpha(composerPoint.x, composerPoint.y);
      if ([sidebarAlpha, composerAlpha].some(value => value !== 255) || [dockAlpha, headerAlpha, ...canvasAlpha].some(value => value < 210 || value >= 240)) {
        try { writeFileSync(join(runtime.desktopPaths!.logsDirectory, "transparency-failure.png"), image.toPNG()); }
        catch (error) { runtime.logger?.warn("Unable to save transparency failure screenshot", error); }
        const surfaces = await runtime.mainWindow!.webContents.executeJavaScript(`({
          route: location.pathname, desktop: document.documentElement.dataset.desktopRuntime,
          surfaces: ["body", ".workspace-shell", ".workspace-content", ".chat-canvas", ".chat-transcript"].map(selector => {
            const node = document.querySelector(selector); if (!node) return {selector, absent: true};
            const style = getComputedStyle(node); return {selector, background: style.backgroundColor, opacity: style.opacity};
          })
        })`);
        throw new Error(`Desktop workspace transparency is incorrect: ${JSON.stringify({ sidebarAlpha, dockAlpha, composerAlpha, headerAlpha, canvasAlpha, canvasPoints, geometry, surfaces })}`);
      }
      runtime.logger?.info("Verified solid composer with translucent canvas and dock", { sidebarAlpha, dockAlpha, composerAlpha, headerAlpha, canvasAlpha });
    } finally {
      if (restoreHidden && !captureWindow.isDestroyed()) captureWindow.hide();
    }
  }

  await verifyWorkspaceTransparency();

  // Drive the bridge exactly as a click does, and require the window to change.
  const captionWindow = runtime.mainWindow;
  if (captionWindow && !captionWindow.isMaximized()) {
    const maximized = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 8000);
      captionWindow.once("maximize", () => { clearTimeout(timer); resolve(true); });
    });
    await captionWindow.webContents.executeJavaScript(
      "window.riaDesktop.windowControls.toggleMaximize()",
      true,
    );
    if (!(await maximized)) {
      throw new Error(`The maximise caption verb did not reach the window: ${JSON.stringify(caption)}`);
    }
    await verifyWorkspaceTransparency();
    const restored = new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), 8000);
      captionWindow.once("unmaximize", () => { clearTimeout(timer); resolve(true); });
    });
    captionWindow.unmaximize();
    if (!(await restored)) throw new Error("The transparent window did not restore after maximization");
    const bounds = captionWindow.getBounds();
    captionWindow.setSize(1100, 720);
    await verifyWorkspaceTransparency();
    captionWindow.setBounds(bounds);
  }

  const unauthenticatedResponse = await fetch(`${runtime.nextServer.origin}/api/conversations`);
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
      const request = httpRequest(`${runtime.nextServer!.origin}/api/conversations`, {
        method: "POST", headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${runtime.desktopSessionToken}`, "Content-Type": "application/json", ...headers },
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
    const response = await fetch(`${runtime.nextServer.origin}/api/chat`, {
      method: "POST", headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${runtime.desktopSessionToken}`, "Content-Type": "application/json", Origin: runtime.nextServer.origin }, body: "{}",
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
  const uploadResponse = await fetch(`${runtime.nextServer.origin}/api/media/upload`, {
    method: "POST", headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${runtime.desktopSessionToken}` }, body: form,
  });
  const uploaded = await uploadResponse.json() as { data?: Array<{ assetId: string; url: string; relativePath: string; mediaType: string }> };
  const asset = uploaded.data?.[0];
  if (!uploadResponse.ok || !asset || !runtime.desktopPaths || !existsSync(join(runtime.desktopPaths.mediaDirectory, asset.relativePath))) {
    throw new Error("Desktop media upload did not persist in the data directory");
  }
  const messageResponse = await fetch(`${runtime.nextServer.origin}/api/conversations/${conversationId}/messages`, {
    method: "POST", headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${runtime.desktopSessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "user", content: "__USER_MESSAGE__:" + JSON.stringify({ type: "user-message", text: "Smoke attachment", files: [{ url: asset.url, mediaType: asset.mediaType }] }) }),
  });
  if (!messageResponse.ok) throw new Error("Desktop media reference did not persist");
  if ((await fetch(`${runtime.nextServer.origin}${asset.url}`)).status !== 403) throw new Error("Desktop media allowed unauthenticated access");

  const documentFixtures = JSON.parse(process.env.DESKTOP_SMOKE_DOCUMENTS || "[]") as Array<{ filename: string; data: string; expected: string; pageNumber: number | null }>;
  if (documentFixtures.length !== 2) throw new Error("Desktop document smoke fixtures are missing");
  const importedDocuments: { id: string; expected: string; pageNumber: number | null }[] = [];
  for (const fixture of documentFixtures) {
    const documentForm = new FormData();
    documentForm.append("file", new Blob([Buffer.from(fixture.data, "base64")]), fixture.filename);
    const imported = await fetch(`${runtime.nextServer.origin}/api/documents`, { method: "POST", headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${runtime.desktopSessionToken}` }, body: documentForm });
    const payload = await imported.json() as { data?: { document?: { id?: string } } };
    if (!imported.ok || !payload.data?.document?.id) throw new Error(`Desktop document import failed (${fixture.filename}, ${imported.status})`);
    const id = payload.data.document.id;
    if ((await fetch(`${runtime.nextServer.origin}/api/documents/${id}`)).status !== 403) throw new Error("Desktop document allowed unauthenticated access");
    importedDocuments.push({ id, expected: fixture.expected, pageNumber: fixture.pageNumber });
  }

  await runtime.reminderPoller?.poll();
  const reminderId = seedTaskReminderSmoke(runtime.desktopPaths.databaseFile, conversationId);
  await runtime.reminderPoller?.poll();
  await runtime.reminderPoller?.poll();
  if (smokeReminders.filter(task => task.id === reminderId).length !== 1) throw new Error("Desktop task notification was missing or duplicated");

  await prepareConversationSmoke(runtime.nextServer.origin, `${DESKTOP_COOKIE_NAME}=${runtime.desktopSessionToken}`, conversationId);
  const libraryFixture = seedMediaLibrarySmoke(runtime.desktopPaths.databaseFile, runtime.desktopPaths.mediaDirectory, asset.assetId, conversationId);
  await prepareAccountSettingsSmoke(runtime.nextServer.origin, `${DESKTOP_COOKIE_NAME}=${runtime.desktopSessionToken}`);
  await restartLocalService();
  if (!runtime.nextServer) throw new Error("Desktop service did not restart.");
  await runtime.reminderPoller?.poll();
  if (smokeReminders.filter(task => task.id === reminderId).length !== 1) throw new Error("Desktop task notification replayed after service restart");
  const persistedResponse = await fetch(`${runtime.nextServer.origin}/api/conversations`, {
    headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${runtime.desktopSessionToken}` },
  });
  const persistedPayload = (await persistedResponse.json()) as { data?: Array<{ id?: string }> };
  if (!persistedResponse.ok || !persistedPayload.data?.some((conversation) => conversation.id === conversationId)) {
    throw new Error("Desktop conversation did not persist across a local service restart.");
  }
  const persistedMedia = await fetch(`${runtime.nextServer.origin}${asset.url}`, { headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${runtime.desktopSessionToken}` } });
  if (!persistedMedia.ok || !Buffer.from(await persistedMedia.arrayBuffer()).equals(mediaBytes)) throw new Error("Desktop media did not survive a service restart");
  for (const document of importedDocuments) {
    const retained = await fetch(`${runtime.nextServer.origin}/api/documents/${document.id}`, { headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${runtime.desktopSessionToken}` } });
    const payload = await retained.json() as { data?: { chunks?: Array<{ text: string; pageNumber: number | null }> } };
    const kept = payload.data?.chunks?.some(chunk => chunk.text.includes(document.expected) && chunk.pageNumber === document.pageNumber);
    if (!retained.ok || !kept) throw new Error("Desktop document did not survive a service restart");
    const search = await fetch(`${runtime.nextServer.origin}/api/documents/search`, {
      method: "POST",
      headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${runtime.desktopSessionToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: document.expected }),
    });
    const results = await search.json() as { data?: Array<{ documentId: string }> };
    if (!search.ok || !results.data?.some(result => result.documentId === document.id)) throw new Error("Desktop document index did not survive a service restart");
  }
  const wordDocument = importedDocuments.find(document => document.pageNumber === null);
  if (!wordDocument) throw new Error("Desktop Word fixture is missing");
  const sessionCookie = `${DESKTOP_COOKIE_NAME}=${runtime.desktopSessionToken}`;
  const dataDirectory = dirname(runtime.desktopPaths.databaseFile);
  await verifyDocumentProcessorSmoke(runtime.mainWindow!, runtime.nextServer.origin, sessionCookie, wordDocument.id, dataDirectory);
  await verifyConversationSmoke(runtime.mainWindow!, runtime.nextServer.origin, sessionCookie, conversationId, dataDirectory);
  await verifyMediaLibrarySmoke(runtime.mainWindow!, runtime.nextServer.origin, sessionCookie, libraryFixture, asset.assetId, mediaBytes, dataDirectory);
  await runtime.reminderPoller?.stop(); await runtime.conversationAlerts?.stop();
  await verifyAccountBackupSmoke(runtime.mainWindow!, runtime.nextServer.origin, sessionCookie, dataDirectory, async () => {
    await restartLocalService();
    return runtime.nextServer!.origin;
  });
  const log = readFileSync(runtime.desktopPaths.logFile, "utf8");
  if (!log.includes("Next stdout") || log.includes(`desktop-smoke-key-${process.pid}`) || statSync(runtime.desktopPaths.logFile).size > DESKTOP_LOG_LIMITS.maxBytes) {
    throw new Error("Desktop service output did not use bounded, redacted logging");
  }
  runtime.logger?.info("Desktop Electron smoke test passed");
}
