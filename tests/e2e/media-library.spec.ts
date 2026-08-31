import { test as base, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { startStandaloneServer } from "../helpers/standalone-server";
import { browserApi, browserData } from "../helpers/browser-api";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => { const app = await startStandaloneServer({ modelFixture: true }); try { await runTest(app); } finally { await app.close(); } },
});
async function register(page: Page, origin: string) {
  await page.goto(`${origin}/register`);
  await page.getByPlaceholder("邮箱", { exact: true }).fill(`${randomUUID()}@example.invalid`);
  await page.getByPlaceholder("密码（至少 8 位）").fill(randomUUID());
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page).toHaveURL(`${origin}/chat`);
}
async function upload(page: Page, count = 1): Promise<Array<{ assetId: string; url: string; mediaType: string }>> {
  return page.evaluate(async count => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8XcAAAAASUVORK5CYII="), c => c.charCodeAt(0));
    const form = new FormData();
    for (let i = 0; i < count; i++) form.append("files", new Blob([bytes], { type: "image/png" }), "library.png");
    const response = await fetch("/api/media/upload", { method: "POST", body: form });
    if (response.status !== 201) throw new Error("Fixture upload failed");
    return (await response.json()).data;
  }, count);
}
async function library(page: Page, origin: string) {
  await page.goto(`${origin}/media`);
  await expect(page.getByRole("button", { name: "刷新资源" })).toBeEnabled();
}
async function inspect(page: Page, id: string) {
  await page.getByRole("article", { name: `媒体 ${id}`, exact: true }).getByRole("button", { name: "查看详情", exact: true }).click();
  const detail = page.getByRole("region", { name: "媒体详情" });
  await expect(detail).toContainText(id);
  return detail;
}

test("media library shows real generation provenance, confirms regeneration and downloads private images", { tag: "@integration" }, async ({ page, app }, info) => {
  await register(page, app.origin);
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
  await detail.getByRole("button", { name: "重新生成", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("可能产生费用");
  await expect(dialog.getByRole("button", { name: "取消操作" })).toBeFocused();
  await page.keyboard.press("Escape"); expect(app.providerCalls).toHaveLength(1);
  await detail.getByRole("button", { name: "重新生成", exact: true }).click();
  const response = page.waitForResponse(response => response.url().endsWith(`/api/media/${id}/regenerate`));
  await dialog.getByRole("button", { name: "确认重新生成" }).click();
  const regenerated = await response; expect(regenerated.status()).toBe(201);
  const newId = (await regenerated.json()).asset.assetId;
  await expect(detail).toContainText(newId);
  expect(newId).not.toBe(id); expect(app.providerCalls).toHaveLength(2);
  expect(app.providerCalls[1].messages).toEqual(app.providerCalls[0].messages);
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

test("video library filters and generation options survive HTTP regeneration while quotas and ownership remain enforced", { tag: "@integration" }, async ({ page, browser, app }, info) => {
  await register(page, app.origin);
  const first = await browserApi(page, "/api/video", "POST", { prompt: "离线视频", aspectRatio: "9:16", duration: 5, fps: 24 });
  expect(first.status).toBe(200);
  const id = first.body.asset.assetId;
  await upload(page); await library(page, app.origin);
  await page.getByLabel("媒体类型", { exact: true }).selectOption("video");
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
  const other = await browser.newContext();
  try {
    expect((await other.request.get(`${app.origin}/api/media/library`)).status()).toBe(401);
    const stranger = await other.newPage(); await register(stranger, app.origin);
    for (const suffix of ["details", "regenerate"]) expect((await browserApi(stranger, `/api/media/${id}/${suffix}`, suffix === "regenerate" ? "POST" : "GET", suffix === "regenerate" ? { confirm: true } : undefined)).status).toBe(404);
    expect((await browserData(stranger, "/api/media/library"))).toEqual([]);
  } finally { await other.close(); }
});

test("media pagination and confirmed deletion preserve referenced inputs and update real storage statistics", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin);
  const inputs = [];
  for (let i = 0; i < 7; i++) inputs.push(...await upload(page, 4));
  const generated = (await browserApi(page, "/api/image", "POST", { prompt: "保护参考图", inputImages: [{ url: inputs[0].url, mediaType: inputs[0].mediaType }] })).body.asset;
  await library(page, app.origin);
  await expect(page.getByRole("article")).toHaveCount(24);
  await page.getByRole("button", { name: "加载更多资源" }).click();
  await expect(page.getByRole("article")).toHaveCount(29);
  let detail = await inspect(page, inputs[0].assetId);
  await expect(detail.getByRole("button", { name: "删除资源", exact: true })).toBeDisabled();
  await expect(detail.getByRole("button", { name: "重新生成", exact: true })).toBeDisabled();
  await detail.getByRole("button", { name: "关闭详情" }).click();
  detail = await inspect(page, generated.assetId);
  await detail.getByRole("button", { name: "删除资源", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "取消操作" }).click();
  expect(app.readRows("SELECT id FROM media_assets")).toHaveLength(29);
  await detail.getByRole("button", { name: "删除资源", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认永久删除" }).click();
  await expect(page.getByText("资源已删除，文件无法恢复。")).toBeVisible();
  expect((await browserData(page, `/api/media/${inputs[0].assetId}/details`)).generationReferenceCount).toBe(0);
  await page.getByText("磁盘占用与清理", { exact: true }).click();
  await expect(page.getByText("磁盘占用", { exact: true })).toBeVisible();
  const stats = await browserData(page, "/api/media"); expect(stats.assetCount).toBe(28); expect(stats.referencedCount).toBe(0);
  // A fresh input cannot be reclaimed immediately after deleting its dependent result.
  await expect(page.getByRole("button", { name: "清理未使用媒体" })).toBeDisabled();
});

test("media errors, forged requests and expired sessions never trigger unintended generation", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin);
  const [input] = await upload(page);
  await library(page, app.origin); const detail = await inspect(page, input.assetId);
  await expect(detail).toContainText("没有完整生成参数");
  expect((await browserApi(page, `/api/media/${input.assetId}/regenerate`, "POST", { confirm: true })).status).toBe(409);
  expect((await browserApi(page, "/api/media/library?type=image&type=video")).status).toBe(400);
  const cookie = (await page.context().cookies()).map(value => `${value.name}=${value.value}`).join("; ");
  const denied = await fetch(`${app.origin}/api/media/${input.assetId}/regenerate`, { method: "POST", headers: { cookie, origin: "https://outside.invalid", "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
  expect(denied.status).toBe(403);
  app.expireSessions();
  await detail.getByRole("button", { name: "下载原文件" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("重新登录");
  expect(app.providerCalls).toHaveLength(0);
  await page.reload(); await expect(page).toHaveURL(`${app.origin}/login`);
});
