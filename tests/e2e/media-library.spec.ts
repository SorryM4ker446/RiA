import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { NO_CREDENTIAL_STATE, localHostOrigin, openWorkspace } from "../helpers/workspace-entry";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { startStandaloneServer } from "../helpers/standalone-server";
import { browserApi, browserData } from "../helpers/browser-api";
import { configureOfflineModels } from "../helpers/model-fixture";
import { chooseOption } from "../helpers/select";
import { openMenu } from "../helpers/row-menu";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => { const app = await startStandaloneServer({ modelFixture: true }); try { await runTest(app); } finally { await app.close(); } },
});
async function register(page: Page, origin: string) {
  // The workspace has no login: the run's access cookie is already active.
  await openWorkspace(page, origin);
}
/** Uploads `count` different pictures: the same bytes again would reuse the asset already there. */
async function upload(page: Page, count = 1): Promise<Array<{ assetId: string; url: string; mediaType: string }>> {
  return page.evaluate(async count => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8XcAAAAASUVORK5CYII="), c => c.charCodeAt(0));
    const form = new FormData();
    for (let i = 0; i < count; i++) form.append("files", new Blob([bytes, new TextEncoder().encode(`#${crypto.randomUUID()}`)], { type: "image/png" }), "library.png");
    const response = await fetch("/api/media/upload", { method: "POST", body: form });
    if (response.status !== 201) throw new Error("Fixture upload failed");
    return (await response.json()).data;
  }, count);
}
async function library(page: Page, origin: string) {
  await page.goto(`${origin}/media`);
  await expect(page.getByRole("combobox", { name: "媒体类型" })).toBeEnabled();
}
async function inspect(page: Page, id: string) {
  await page.getByRole("article", { name: `媒体 ${id}`, exact: true }).getByRole("button", { name: "查看详情", exact: true }).click();
  const detail = page.getByRole("region", { name: "媒体详情" });
  await expect(detail).toContainText(id);
  return detail;
}
/** Showing the file and deleting it sit in the detail's "more actions" menu, beside the download. */
async function detailAction(page: Page, detail: Locator, action: string) {
  await detail.getByRole("button", { name: "更多操作 媒体详情", exact: true }).click();
  await openMenu(page).getByRole("menuitem", { name: action, exact: true }).click();
}

test("media library shows real generation provenance and the full prompt, and downloads private images", { tag: "@integration" }, async ({ page, app }, info) => {
  await register(page, app.origin);
  await configureOfflineModels(page, { image: "google/gemini-3.1-flash-image-preview" });
  const [input] = await upload(page);
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "媒体来源会话" })).body.data;
  const first = await browserApi(page, "/api/image", "POST", { prompt: "离线月光图片", chatId: chat.id, inputImages: [{ url: input.url, mediaType: input.mediaType }] });
  expect(first.status).toBe(200);
  const id = first.body.asset.assetId;
  await page.getByRole("link", { name: "媒体资源库", exact: true }).click();
  const detail = await inspect(page, id);
  await expect(detail).toContainText("离线月光图片"); await expect(detail).toContainText("媒体来源会话（生成来源）");
  await expect(detail.getByRole("img")).toBeVisible();
  await expect.poll(() => detail.getByRole("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
  await page.screenshot({ path: info.outputPath("media-library-wide.png"), fullPage: true });
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("media-library-narrow.png"), fullPage: true });
  await page.setViewportSize(viewport);
  // The prompt is read here in full, and copied from here; the menu leads to the file instead of regenerating it.
  await expect(detail.getByTestId("asset-prompt")).toHaveText("离线月光图片");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await detail.getByRole("button", { name: "复制提示词", exact: true }).click();
  await expect(page.getByText("已复制提示词")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("离线月光图片");
  await detail.getByRole("button", { name: "更多操作 媒体详情", exact: true }).click();
  await expect(openMenu(page).getByRole("menuitem", { name: "重新生成", exact: true })).toHaveCount(0);
  await openMenu(page).getByRole("menuitem", { name: "在资源管理器中打开", exact: true }).click();
  // Outside the desktop app there is no file manager: it says so.
  await expect(page.getByText("在 RiA 桌面应用中才能打开文件位置。").first()).toBeVisible();
  expect(app.providerCalls).toHaveLength(1);
  const newId = id;
  const pending = page.waitForEvent("download");
  await detail.getByRole("button", { name: "下载原文件" }).click();
  const download = await pending; expect(download.suggestedFilename()).toBe(`${newId}.png`);
  const file = info.outputPath(download.suggestedFilename()); await download.saveAs(file);
  expect((await readFile(file)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await app.restart(); await library(page, app.origin);
  await inspect(page, newId); await expect(detail).toContainText("参考图：1 张");
  await detail.getByRole("button", { name: "打开会话", exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}/chat`);
  await expect(page.getByText("媒体来源会话", { exact: true }).first()).toBeVisible();
});

test("video library filters and generation options survive HTTP regeneration while quotas and credentials remain enforced", { tag: "@integration" }, async ({ page, browser, app }, info) => {
  await register(page, app.origin);
  await configureOfflineModels(page, { video: "bytedance/seedance-2.0" });
  const first = await browserApi(page, "/api/video", "POST", { prompt: "离线视频", aspectRatio: "9:16", duration: 5, fps: 24 });
  expect(first.status).toBe(200);
  const id = first.body.asset.assetId;
  await upload(page); await library(page, app.origin);
  await chooseOption(page.getByLabel("媒体类型", { exact: true }), "视频");
  await expect(page.getByRole("article")).toHaveCount(1);
  const detail = await inspect(page, id);
  await expect(detail).toContainText("比例：9:16 · 时长：5 秒 · 帧率：24");
  await expect(detail.getByRole("alert")).toContainText("无法预览此文件");
  const pending = page.waitForEvent("download"); await detail.getByRole("button", { name: "下载原文件" }).click();
  const download = await pending; const file = info.outputPath(download.suggestedFilename()); await download.saveAs(file);
  expect((await readFile(file)).toString("ascii", 4, 8)).toBe("ftyp");
  for (let i = 0; i < 2; i++) expect((await browserApi(page, `/api/media/${id}/regenerate`, "POST", { confirm: true })).status).toBe(201);
  expect((await browserApi(page, `/api/media/${id}/regenerate`, "POST", { confirm: true })).status).toBe(429);
  expect(app.providerCalls).toHaveLength(3);
  // A browser that never obtained the credential reaches no stored asset.
  const other = await browser.newContext({ storageState: NO_CREDENTIAL_STATE });
  try {
    const base = localHostOrigin(app.origin);
    expect((await other.request.get(`${base}/api/media/library`)).status()).toBe(401);
    const stranger = await other.newPage(); await stranger.goto(`${base}/chat`);
    for (const suffix of ["details", "regenerate"]) expect((await browserApi(stranger, `${base}/api/media/${id}/${suffix}`, suffix === "regenerate" ? "POST" : "GET", suffix === "regenerate" ? { confirm: true } : undefined)).status).toBe(401);
    expect((await browserApi(stranger, `${base}/api/media/library`)).status).toBe(401);
  } finally { await other.close(); }
});

test("media pagination and confirmed deletion preserve referenced inputs and update real storage statistics", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin);
  await configureOfflineModels(page, { image: "google/gemini-3.1-flash-image-preview" });
  const inputs = [];
  for (let i = 0; i < 7; i++) inputs.push(...await upload(page, 4));
  const generated = (await browserApi(page, "/api/image", "POST", { prompt: "保护参考图", inputImages: [{ url: inputs[0].url, mediaType: inputs[0].mediaType }] })).body.asset;
  await library(page, app.origin);
  await expect(page.getByRole("article")).toHaveCount(24);
  await page.getByRole("button", { name: "加载更多资源" }).click();
  await expect(page.getByRole("article")).toHaveCount(29);
  let detail = await inspect(page, inputs[0].assetId);
  // A referenced input cannot be deleted; its menu says so by disabling it.
  await detail.getByRole("button", { name: "更多操作 媒体详情", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "删除资源", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await detail.getByRole("button", { name: "关闭详情" }).click();
  detail = await inspect(page, generated.assetId);
  await detailAction(page, detail, "删除资源");
  await page.getByRole("dialog", { name: "永久删除这个资源？" }).getByRole("button", { name: "取消操作" }).click();
  expect(app.readRows("SELECT id FROM media_assets")).toHaveLength(29);
  await detailAction(page, detail, "删除资源");
  await page.getByRole("dialog", { name: "永久删除这个资源？" }).getByRole("button", { name: "确认永久删除" }).click();
  await expect(page.getByText("资源已删除，文件无法恢复。")).toBeVisible();
  expect((await browserData(page, `/api/media/${inputs[0].assetId}/details`)).generationReferenceCount).toBe(0);
  await page.getByText("磁盘占用与清理", { exact: true }).click();
  await expect(page.getByText("磁盘占用", { exact: true })).toBeVisible();
  const stats = await browserData(page, "/api/media"); expect(stats.assetCount).toBe(28); expect(stats.referencedCount).toBe(0);
  // A fresh input cannot be reclaimed immediately after deleting its dependent result.
  await expect(page.getByRole("button", { name: "清理未使用媒体" })).toBeDisabled();
});

test("media errors, forged requests and a missing credential never trigger unintended generation", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin);
  const [input] = await upload(page);
  await library(page, app.origin); const detail = await inspect(page, input.assetId);
  await expect(detail).toContainText("没有完整生成参数");
  expect((await browserApi(page, `/api/media/${input.assetId}/regenerate`, "POST", { confirm: true })).status).toBe(409);
  expect((await browserApi(page, "/api/media/library?type=image&type=video")).status).toBe(400);
  const cookie = (await page.context().cookies()).map(value => `${value.name}=${value.value}`).join("; ");
  const denied = await fetch(`${localHostOrigin(app.origin)}/api/media/${input.assetId}/regenerate`, { method: "POST", headers: { cookie, origin: "https://outside.invalid", "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
  expect(denied.status).toBe(403);
  // Dropping the credential stops the download, and there is no login page to
  // fall back to: the workspace reports the refusal instead of redirecting.
  await page.context().clearCookies();
  await detail.getByRole("button", { name: "下载原文件" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("本地访问凭证已失效");
  expect(app.providerCalls).toHaveLength(0);
  // A reload without the credential keeps the workspace route and never falls
  // back to a login page, because there is none.
  await page.reload(); await expect(page).toHaveURL(`${app.origin}/media`);
});

/** A picture larger than the window, so it opens fitted and can be moved once shown at its own size. */
async function uploadLarge(page: Page): Promise<{ assetId: string; url: string }> {
  return page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 2400; canvas.height = 1600;
    const context = canvas.getContext("2d")!;
    const gradient = context.createLinearGradient(0, 0, 2400, 1600);
    gradient.addColorStop(0, "#1d4ed8"); gradient.addColorStop(1, "#f59e0b");
    context.fillStyle = gradient; context.fillRect(0, 0, 2400, 1600);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), "image/png"));
    const form = new FormData();
    form.append("files", blob, "large.png");
    const response = await fetch("/api/media/upload", { method: "POST", body: form });
    if (response.status !== 201) throw new Error("Fixture upload failed");
    return (await response.json()).data[0];
  });
}
const viewer = (page: Page) => page.locator(".image-viewer");
const scaleOf = async (page: Page) => Number((await viewer(page).locator(".image-viewer-scale").textContent())!.replace("%", ""));

test("a picture in the media detail opens in the viewer fitted to the window, zooms, moves when larger, and Esc returns to where it was opened", async ({ page, app }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await register(page, app.origin);
  const large = await uploadLarge(page);
  await library(page, app.origin);
  const detail = await inspect(page, large.assetId);
  const preview = detail.getByRole("img").first();
  await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(2400);

  await preview.dblclick();
  await expect(viewer(page)).toBeVisible();
  await expect(viewer(page)).toHaveCSS("-webkit-app-region", "no-drag");
  const picture = viewer(page).locator(".image-viewer-picture");
  // The scale shows once the picture has loaded and been fitted.
  await expect(viewer(page).locator(".image-viewer-scale")).toHaveText(/^\d+%$/);
  await expect.poll(() => scaleOf(page)).toBeLessThan(100);
  // Fitted: all of it shows, in proportion.
  const fitted = (await picture.boundingBox())!;
  expect(fitted.width / fitted.height).toBeCloseTo(1.5, 1);
  expect(fitted.width).toBeLessThanOrEqual(1280);
  expect(fitted.height).toBeLessThanOrEqual(860);
  const fittedScale = await scaleOf(page);
  await viewer(page).getByRole("button", { name: "放大", exact: true }).click();
  await expect.poll(() => scaleOf(page)).toBeGreaterThan(fittedScale);
  await viewer(page).getByRole("button", { name: "缩小", exact: true }).click();
  await expect.poll(() => scaleOf(page)).toBe(fittedScale);
  // Wheel input belongs to the viewer and zooms in both directions without a modifier.
  await picture.hover();
  await page.mouse.wheel(0, -240);
  await expect.poll(() => scaleOf(page)).toBeGreaterThan(fittedScale);
  await page.mouse.wheel(0, 240);
  await expect.poll(() => scaleOf(page)).toBe(fittedScale);
  await viewer(page).getByRole("button", { name: "原始尺寸", exact: true }).click();
  await expect.poll(() => scaleOf(page)).toBe(100);
  expect((await picture.boundingBox())!.width).toBeCloseTo(2400, 0);
  // Larger than the window now: dragging moves it.
  const before = (await picture.boundingBox())!;
  await page.mouse.move(640, 500); await page.mouse.down(); await page.mouse.move(440, 400, { steps: 5 }); await page.mouse.up();
  const after = (await picture.boundingBox())!;
  expect(after.x).toBeLessThan(before.x - 100);
  expect(after.y).toBeLessThan(before.y - 50);
  // The keyboard too: back to fitted.
  await page.keyboard.press("0");
  await expect.poll(() => scaleOf(page)).toBe(fittedScale);
  await expect(viewer(page).getByRole("button", { name: "适应窗口", exact: true })).toHaveAttribute("aria-pressed", "true");
  // Narrow, its controls still fit.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.keyboard.press("Escape");
  await expect(viewer(page)).toBeHidden();
  await expect(detail.getByRole("button", { name: "查看大图", exact: true })).toBeFocused();
  // Its own button opens it as well.
  await detail.getByRole("button", { name: "查看大图", exact: true }).press("Enter");
  await expect(viewer(page)).toBeVisible();
  await viewer(page).getByRole("button", { name: "关闭", exact: true }).click();
  await expect(detail.getByRole("button", { name: "查看大图", exact: true })).toBeFocused();
});

test("showing a media file in the file manager points the desktop app at that asset's own file, for images, videos and attachments", async ({ page, app }) => {
  await page.addInitScript(() => {
    // The settings the shell reads at start, and the one call this test is about.
    const settings = { hasOpenrouterApiKey: true, hasDeepseekApiKey: false, encryptionAvailable: true, outboundProxyUrl: "", openrouterSiteName: "RiA", openrouterHttpReferer: "", closeBehaviour: "quit", globalHotkey: "Control+Shift+Space", windowBounds: null };
    Object.defineProperty(window, "riaDesktop", { value: { getSettings: async () => settings, getRuntimeInfo: async () => ({ appVersion: "0.1.2", packaged: false, dataDirectory: "fixture/data", mediaDirectory: "fixture/media", logFile: "fixture/log" }), revealPath: async (target: string) => { (window as unknown as { revealed: string[] }).revealed = [...((window as unknown as { revealed?: string[] }).revealed ?? []), target]; return { revealed: true }; } } });
  });
  await register(page, app.origin);
  await configureOfflineModels(page, { image: "google/gemini-3.1-flash-image-preview", video: "bytedance/seedance-2.0" });
  const [attachment] = await upload(page);
  const image = (await browserApi(page, "/api/image", "POST", { prompt: "资源管理器里的图片" })).body.asset.assetId as string;
  const video = (await browserApi(page, "/api/video", "POST", { prompt: "资源管理器里的视频", aspectRatio: "16:9", duration: 5, fps: 24 })).body.asset.assetId as string;
  await library(page, app.origin);
  for (const [id, extension] of [[image, "png"], [video, "mp4"], [attachment.assetId, "png"]] as const) {
    const detail = await inspect(page, id);
    await detailAction(page, detail, "在资源管理器中打开");
    await expect.poll(() => page.evaluate(() => (window as unknown as { revealed?: string[] }).revealed?.at(-1) ?? "")).toMatch(new RegExp(`[\\\\/]${id}\\.${extension}$`));
    await detail.getByRole("button", { name: "关闭详情" }).click();
  }
  // The file is gone from disk: the service says so, and nothing is shown.
  const shown = await page.evaluate(() => (window as unknown as { revealed: string[] }).revealed.length);
  await page.route(`**/api/media/${image}/locate`, route => route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "媒体文件不可用。", details: null } } }));
  const detail = await inspect(page, image);
  await detailAction(page, detail, "在资源管理器中打开");
  await expect(page.getByRole("alert").filter({ hasText: "媒体文件不可用" }).first()).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { revealed: string[] }).revealed.length)).toBe(shown);
});
