import { test as base, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { startStandaloneServer } from "../helpers/standalone-server";
import { browserApi, browserData } from "../helpers/browser-api";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({ app: async ({}, runTest) => { const app = await startStandaloneServer({ modelFixture: true }); try { await runTest(app); } finally { await app.close(); } } });
async function register(page: Page, origin: string) {
  await page.goto(`${origin}/register`); await page.getByPlaceholder("邮箱", { exact: true }).fill(`${randomUUID()}@example.invalid`); await page.getByPlaceholder("密码（至少 8 位）").fill(randomUUID()); await page.getByRole("button", { name: "注册并登录" }).click(); await expect(page).toHaveURL(`${origin}/chat`); await expect(page.getByRole("checkbox", { name: "仅手动" })).toBeEnabled();
}
async function openBackups(page: Page, origin: string) { await page.goto(`${origin}/backups`); await expect(page.getByRole("button", { name: "创建备份", exact: true })).toBeEnabled(); }

test("account backup downloads and confirmed restore preserve media and business data across restart", { tag: "@integration" }, async ({ page, app }, info) => {
  await register(page, app.origin);
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "需要恢复的会话" })).body.data;
  await browserApi(page, `/api/conversations/${chat.id}/messages`, "POST", { role: "user", content: "备份正文", clientMessageId: randomUUID() });
  await browserApi(page, "/api/knowledge", "POST", { key: "restore-key", value: "保留知识" });
  expect((await browserApi(page, "/api/tools/run", "POST", { tool: "createTask", mode: "chat", input: { title: "保留任务" } })).status).toBe(200);
  const image = await browserApi(page, "/api/image", "POST", { prompt: "备份图片", chatId: chat.id }); expect(image.status).toBe(200);
  await openBackups(page, app.origin);
  await page.getByRole("button", { name: "创建备份", exact: true }).click(); await expect(page.getByRole("article")).toHaveCount(1);
  const backup = (await browserData(page, "/api/backups"))[0];
  const download = page.waitForEvent("download"); await page.getByRole("button", { name: "下载备份" }).click(); const saved = await download; const file = info.outputPath(saved.suggestedFilename()); await saved.saveAs(file);
  const bytes = await readFile(file); expect(bytes.subarray(0, 8).toString()).toBe("PAIB0001"); expect(bytes.includes(Buffer.from("tokenHash"))).toBe(false);
  await browserApi(page, `/api/conversations/${chat.id}`, "DELETE");
  await page.getByRole("button", { name: "恢复", exact: true }).click(); const dialog = page.getByRole("dialog"); await expect(dialog.getByRole("button", { name: "确认恢复" })).toBeDisabled(); await dialog.getByRole("button", { name: "取消操作" }).click(); expect(await browserData(page, "/api/conversations")).toHaveLength(0);
  await page.getByRole("button", { name: "恢复", exact: true }).click(); await dialog.getByLabel("恢复确认文字").fill("恢复"); await dialog.getByRole("button", { name: "确认恢复" }).click(); await expect(page.getByRole("status").filter({ hasText: "恢复完成" })).toBeVisible();
  const restored = await browserData(page, "/api/conversations"); expect(restored[0].title).toBe("需要恢复的会话"); expect(restored[0].id).not.toBe(chat.id);
  expect((await browserData(page, `/api/conversations/${restored[0].id}/messages`))[0].content).toBe("备份正文");
  expect(await browserData(page, "/api/tasks")).toHaveLength(1);
  const media = (await browserData(page, "/api/media/library"))[0]; expect(media.id).not.toBe(image.body.asset.assetId);
  const detail = await browserData(page, `/api/media/${media.id}/details`); expect(detail.sourceChat.id).toBe(restored[0].id);
  await app.restart(); await openBackups(page, app.origin); expect((await browserData(page, `/api/backups/${backup.id}`)).counts.assets).toBe(1);
  await page.screenshot({ path: info.outputPath("account-backups.png"), fullPage: true });
  expect(app.providerCalls).toHaveLength(1);
});

test("portable backup import uploads multiple bounded chunks and restores into another account", { tag: "@integration" }, async ({ page, browser, app }, info) => {
  await register(page, app.origin);
  await page.evaluate(async () => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8XcAAAAASUVORK5CYII="), c => c.charCodeAt(0)); const form = new FormData();
    for (let i = 0; i < 2; i++) { const bytes = new Uint8Array(4.5 * 1024 * 1024); bytes.set(png); form.append("files", new Blob([bytes], { type: "image/png" }), `image-${i}.png`); }
    const response = await fetch("/api/media/upload", { method: "POST", body: form }); if (response.status !== 201) throw new Error("Synthetic media upload failed");
  });
  await openBackups(page, app.origin); await page.getByRole("button", { name: "创建备份", exact: true }).click(); await expect(page.getByRole("article")).toHaveCount(1);
  const pending = page.waitForEvent("download"); await page.getByRole("button", { name: "下载备份" }).click(); const download = await pending; const file = info.outputPath(download.suggestedFilename()); await download.saveAs(file);
  const other = await browser.newContext();
  try {
    const stranger = await other.newPage(); await register(stranger, app.origin); await openBackups(stranger, app.origin);
    const chunks: number[] = []; stranger.on("request", request => { if (request.method() === "PUT" && request.url().includes("/api/backups/import/")) chunks.push(request.postDataBuffer()?.length ?? 0); });
    await stranger.getByLabel("导入备份文件", { exact: true }).setInputFiles(file); await expect(stranger.getByRole("status").filter({ hasText: "备份已导入并校验" })).toBeVisible();
    expect(chunks.length).toBeGreaterThan(1); expect(Math.max(...chunks)).toBeLessThanOrEqual(8 * 1024 * 1024); expect(await browserData(stranger, "/api/media/library")).toHaveLength(0);
    await stranger.getByRole("button", { name: "恢复", exact: true }).click(); await stranger.getByLabel("恢复确认文字").fill("恢复"); await stranger.getByRole("button", { name: "确认恢复" }).click(); await expect(stranger.getByRole("status").filter({ hasText: "恢复完成" })).toBeVisible();
    expect(await browserData(stranger, "/api/media/library")).toHaveLength(2); expect(await browserData(page, "/api/media/library")).toHaveLength(2);
  } finally { await other.close(); }
  expect(app.providerCalls).toHaveLength(0);
});

test("backup validation and expired sessions surface errors without changing business data", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin); await openBackups(page, app.origin);
  await page.getByLabel("导入备份文件", { exact: true }).setInputFiles({ name: "corrupt.paib", mimeType: "application/octet-stream", buffer: Buffer.alloc(100, 7) });
  await expect(page.locator("main").getByRole("alert")).toContainText("备份格式"); expect(await browserData(page, "/api/backups")).toHaveLength(0);
  expect((await browserApi(page, "/api/backups", "POST", { unexpected: true })).status).toBe(400);
  app.expireSessions(); await page.getByRole("button", { name: "创建备份", exact: true }).click(); await expect(page.locator("main").getByRole("alert")).toContainText(/Authentication required|登录/);
  await page.reload(); await expect(page).toHaveURL(`${app.origin}/login`); expect(app.providerCalls).toHaveLength(0);
});

test("saved mode defaults apply to new conversations and model settings survive service restart", { tag: "@integration" }, async ({ page, app }, info) => {
  await register(page, app.origin); await page.getByRole("link", { name: "模型与用量", exact: true }).click();
  await page.getByLabel("新会话默认模式", { exact: true }).selectOption("image"); await page.getByLabel("图片默认模型", { exact: true }).selectOption("google/gemini-3.1-flash-image-preview");
  await page.getByRole("button", { name: "保存模型偏好" }).click(); await expect(page.getByRole("status")).toContainText("模型偏好已保存");
  await app.restart(); await page.reload(); await expect(page.getByLabel("新会话默认模式", { exact: true })).toHaveValue("image");
  await page.getByRole("link", { name: "返回聊天", exact: true }).click();
  const createButton = page.getByRole("button", { name: "创建会话", exact: true });
  let releaseCreation!: () => void;
  const creationGate = new Promise<void>(resolve => { releaseCreation = resolve; });
  await page.route(`${app.origin}/api/conversations`, async route => {
    if (route.request().method() === "POST") await creationGate;
    await route.continue();
  });
  try {
    await createButton.click();
    await expect(createButton).toBeDisabled();
    // Account defaults can show the image composer before the real POST completes.
    await expect(page.getByPlaceholder(/描述你想生成的图片/)).toBeVisible();
    expect(await browserData(page, "/api/conversations")).toEqual([]);

    const created = page.waitForResponse(response =>
      response.url() === `${app.origin}/api/conversations` && response.request().method() === "POST");
    releaseCreation();
    const response = await created;
    expect(response.status()).toBe(201);
    const { data: chat } = await response.json();
    expect(chat).toMatchObject({ id: expect.any(String), title: "New Chat" });
    await expect(createButton).toBeEnabled();
    await expect(page.getByRole("button", { name: /^New Chat/ })).toBeVisible();
    expect(await browserData(page, "/api/conversations")).toEqual([expect.objectContaining({ id: chat.id })]);
    await expect.poll(() => page.evaluate(id =>
      JSON.parse(localStorage.getItem(`chat:prefs:${id}`) ?? "null"), chat.id))
      .toMatchObject({ modelMode: "image", selectedImageModel: "google/gemini-3.1-flash-image-preview" });
  } finally {
    releaseCreation();
    await page.unrouteAll({ behavior: "wait" });
  }
  await page.goto(`${app.origin}/models`); await expect(page.getByRole("button", { name: "保存模型偏好" })).toBeVisible(); await page.screenshot({ path: info.outputPath("account-models.png"), fullPage: true }); expect(app.providerCalls).toHaveLength(0);
});

test("configured chat fallback runs through the real provider adapter and persists usage estimates", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin); await page.goto(`${app.origin}/models`);
  await page.getByLabel("聊天备用模型", { exact: true }).selectOption("google/gemini-3-flash-preview");
  await page.getByText("配置估算费率（USD）", { exact: true }).click();
  await page.getByLabel("google/gemini-3-flash-preview 输入 / 百万 Token", { exact: true }).fill("2"); await page.getByLabel("google/gemini-3-flash-preview 输出 / 百万 Token", { exact: true }).fill("4");
  await page.getByRole("button", { name: "保存模型偏好" }).click(); await expect(page.getByRole("status")).toContainText("已保存");
  await page.getByRole("link", { name: "返回聊天", exact: true }).click(); await page.getByRole("checkbox", { name: "仅手动" }).check();
  await page.getByPlaceholder(/输入你的问题/).fill("OFFLINE_PRIMARY_FAILURE 测试备用模型"); await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("离线回答：OFFLINE_PRIMARY_FAILURE 测试备用模型", { exact: true })).toBeVisible();
  await expect.poll(async () => (await browserData(page, "/api/usage")).recent.filter((row: { fallback: boolean }) => row.fallback).length).toBe(1);
  const usage = await browserData(page, "/api/usage"); const backup = usage.recent.find((row: { fallback: boolean }) => row.fallback); expect(backup).toMatchObject({ modelId: "google/gemini-3-flash-preview", inputTokens: 10, outputTokens: 10, costSource: "configured", costUsd: 0.00006 });
  expect(app.providerCalls.filter(call => call.stream)).toHaveLength(2);
  await app.restart(); await page.goto(`${app.origin}/models`); await expect(page.getByRole("cell", { name: "成功（备用）" })).toBeVisible(); await expect(page.getByRole("cell").filter({ hasText: "$0.000060" })).toBeVisible();
});

test("model settings and usage enforce ownership, invalid prices and session expiration over HTTP", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin);
  const settings = await browserData(page, "/api/models");
  expect((await browserApi(page, "/api/models", "PUT", { ...settings, chat: { modelId: "removed/model", fallbackId: null } })).status).toBe(400);
  expect((await browserApi(page, "/api/models", "PUT", { ...settings, rates: { invalid: { inputPerMillion: -1, outputPerMillion: 0, perRequest: null } } })).status).toBe(400);
  expect((await browserData(page, "/api/usage")).totals.costUsd).toBeNull();
  await page.goto(`${app.origin}/models`); await expect(page.getByRole("button", { name: "保存模型偏好" })).toBeVisible(); app.expireSessions(); await page.getByRole("button", { name: "保存模型偏好" }).click(); await expect(page.locator("main").getByRole("alert")).toContainText(/Authentication required|登录/); expect(app.providerCalls).toHaveLength(0);
});
