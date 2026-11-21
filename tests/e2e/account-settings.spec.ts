import { openRecentConversations } from "../helpers/conversations";
import { test as base, expect, type Page } from "@playwright/test";
import { expectTemplate } from "../helpers/chat-header";
import { openWorkspace } from "../helpers/workspace-entry";
import { chooseRowAction } from "../helpers/row-menu";
import { toasts } from "../helpers/toast";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { startStandaloneServer } from "../helpers/standalone-server";
import { browserApi, browserData } from "../helpers/browser-api";
import { configureOfflineModels } from "../helpers/model-fixture";
import { chooseOption } from "../helpers/select";
import { closeSettings, openSettings, settingsDialog } from "../helpers/settings";
import { newTask } from "../helpers/slash-menu";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({ app: async ({}, runTest) => { const app = await startStandaloneServer({ modelFixture: true }); try { await runTest(app); } finally { await app.close(); } } });
async function register(page: Page, origin: string) {
  // The workspace has no login: the run's access cookie is already active.
  await openWorkspace(page, origin);
}
async function openBackups(page: Page, origin: string) { await page.goto(`${origin}/backups`); await expect(page.getByRole("button", { name: "创建备份", exact: true })).toBeEnabled(); }

test("workspace backup downloads and confirmed restore preserve media and business data across restart", { tag: "@integration" }, async ({ page, app }, info) => {
  await register(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6", image: "google/gemini-3.1-flash-image-preview" });
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "需要恢复的会话" })).body.data;
  await browserApi(page, `/api/conversations/${chat.id}/messages`, "POST", { role: "user", content: "备份正文", clientMessageId: randomUUID() });
  await browserApi(page, "/api/knowledge", "POST", { key: "restore-key", value: "保留知识" });
  expect((await browserApi(page, "/api/tasks", "POST", newTask("保留任务"))).status).toBe(201);
  const image = await browserApi(page, "/api/image", "POST", { prompt: "备份图片", chatId: chat.id }); expect(image.status).toBe(200);
  await openBackups(page, app.origin);
  await page.getByRole("button", { name: "创建备份", exact: true }).click(); await expect(page.getByRole("article")).toHaveCount(1);
  const backup = (await browserData(page, "/api/backups"))[0];
  const download = page.waitForEvent("download"); await chooseRowAction(page, page.getByRole("article"), "下载备份"); const saved = await download; const file = info.outputPath(saved.suggestedFilename()); await saved.saveAs(file);
  const bytes = await readFile(file); expect(bytes.subarray(0, 8).toString()).toBe("RIAB0001"); expect(bytes.includes(Buffer.from("tokenHash"))).toBe(false); expect(bytes.includes(Buffer.from("sessionToken"))).toBe(false);
  await browserApi(page, `/api/conversations/${chat.id}`, "DELETE");
  await chooseRowAction(page, page.getByRole("article"), "恢复"); const dialog = page.getByRole("dialog", { name: "确认覆盖当前数据？" }); await expect(dialog.getByRole("button", { name: "确认恢复" })).toBeDisabled(); await dialog.getByRole("button", { name: "取消操作" }).click(); expect(await browserData(page, "/api/conversations")).toHaveLength(0);
  await chooseRowAction(page, page.getByRole("article"), "恢复"); await dialog.getByLabel("恢复确认文字").fill("恢复"); await dialog.getByRole("button", { name: "确认恢复" }).click(); await expect(toasts(page).getByText("恢复完成")).toBeVisible();
  const restored = await browserData(page, "/api/conversations"); expect(restored[0].title).toBe("需要恢复的会话"); expect(restored[0].id).not.toBe(chat.id);
  expect((await browserData(page, `/api/conversations/${restored[0].id}/messages`))[0].content).toBe("备份正文");
  expect(await browserData(page, "/api/tasks")).toHaveLength(1);
  const media = (await browserData(page, "/api/media/library"))[0]; expect(media.id).not.toBe(image.body.asset.assetId);
  const detail = await browserData(page, `/api/media/${media.id}/details`); expect(detail.sourceChat.id).toBe(restored[0].id);
  await app.restart(); await openBackups(page, app.origin); expect((await browserData(page, `/api/backups/${backup.id}`)).counts.assets).toBe(1);
  await page.screenshot({ path: info.outputPath("workspace-backups.png"), fullPage: true });
  expect(app.providerCalls).toHaveLength(1);
});

test("portable backup import uploads bounded chunks and restores the workspace", { tag: "@integration" }, async ({ page, app }, info) => {
  await register(page, app.origin);
  await page.evaluate(async () => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8XcAAAAASUVORK5CYII="), c => c.charCodeAt(0)); const form = new FormData();
    // Two different files: the same bytes twice would be kept once.
    for (let i = 0; i < 2; i++) { const bytes = new Uint8Array(4.5 * 1024 * 1024); bytes.set(png); bytes[bytes.length - 1] = i + 1; form.append("files", new Blob([bytes], { type: "image/png" }), `image-${i}.png`); }
    const response = await fetch("/api/media/upload", { method: "POST", body: form }); if (response.status !== 201) throw new Error("Synthetic media upload failed");
  });
  await openBackups(page, app.origin); await page.getByRole("button", { name: "创建备份", exact: true }).click(); await expect(page.getByRole("article")).toHaveCount(1);
  const created = (await browserData(page, "/api/backups"))[0];
  const pending = page.waitForEvent("download"); await chooseRowAction(page, page.getByRole("article"), "下载备份"); const download = await pending; const file = info.outputPath(download.suggestedFilename()); await download.saveAs(file);
  const chunks: number[] = [];
  page.on("request", request => { if (request.method() === "PUT" && request.url().includes("/api/backups/import/")) chunks.push(request.postDataBuffer()?.length ?? 0); });
  await page.getByLabel("导入备份文件", { exact: true }).setInputFiles(file); await expect(toasts(page).getByText("备份已导入并校验")).toBeVisible();
  // A portable archive is uploaded in more than one bounded chunk.
  expect(chunks.length).toBeGreaterThan(1); expect(Math.max(...chunks)).toBeLessThanOrEqual(8 * 1024 * 1024);
  // The import adds a second entry beside the one this workspace just created.
  const imported = (await browserData(page, "/api/backups")).find((entry: { id: string }) => entry.id !== created.id) as { id: string };
  const importedArticle = page.getByLabel(`备份 ${imported.id}`);
  await chooseRowAction(page, importedArticle, "恢复"); await page.getByLabel("恢复确认文字").fill("恢复"); await page.getByRole("button", { name: "确认恢复" }).click(); await expect(toasts(page).getByText("恢复完成")).toBeVisible();
  expect(await browserData(page, "/api/media/library")).toHaveLength(2);
  expect(app.providerCalls).toHaveLength(0);
});

test("backup validation and a missing credential surface errors without changing business data", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin); await openBackups(page, app.origin);
  await page.getByLabel("导入备份文件", { exact: true }).setInputFiles({ name: "corrupt.riab", mimeType: "application/octet-stream", buffer: Buffer.alloc(100, 7) });
  await expect(settingsDialog(page).getByRole("alert")).toContainText("备份格式"); expect(await browserData(page, "/api/backups")).toHaveLength(0);
  expect((await browserApi(page, "/api/backups", "POST", { unexpected: true })).status).toBe(400);
  // Dropping the credential stops the operation, and there is no login page to
  // return to: the refusal is reported in place.
  await page.context().clearCookies();
  await page.getByRole("button", { name: "创建备份", exact: true }).click(); await expect(settingsDialog(page).getByRole("alert")).toContainText(/凭证|Authentication required/);
  expect(app.readRows("SELECT id FROM chats")).toHaveLength(0); expect(app.providerCalls).toHaveLength(0);
});

test("saved mode defaults apply to new conversations and model settings survive service restart", { tag: "@integration" }, async ({ page, app }, info) => {
  await register(page, app.origin); await openSettings(page, "模型");
  await page.getByRole("tab", { name: "图片生成", exact: true }).click();
  const imageCatalogRow = page.locator("li").filter({ hasText: "google/gemini-3.1-flash-image-preview" });
  await imageCatalogRow.getByRole("button", { name: "添加", exact: true }).click();
  await expect(imageCatalogRow.getByRole("button", { name: "已添加", exact: true })).toBeVisible();
  await chooseOption(page.getByLabel("新会话默认模式", { exact: true }), "图片生成"); await chooseOption(page.getByLabel("图片生成默认模型", { exact: true }), "Gemini Image Offline");
  await page.getByRole("button", { name: "保存模型偏好" }).click(); await expect(toasts(page)).toContainText("模型偏好已保存");
  await app.restart(); await page.reload(); await expect(page.getByLabel("新会话默认模式", { exact: true })).toContainText("图片生成");
  await closeSettings(page);
  const createButton = page.getByRole("button", { name: "新会话", exact: true });
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
    await openRecentConversations(page);
    await expect(page.getByRole("button", { name: /^New Chat/ })).toBeVisible();
    expect(await browserData(page, "/api/conversations")).toEqual([expect.objectContaining({ id: chat.id })]);
    await expect.poll(() => page.evaluate(id =>
      JSON.parse(localStorage.getItem(`chat:prefs:${id}`) ?? "null"), chat.id))
      .toMatchObject({ modelMode: "image", selectedImageModel: { providerId: "openrouter", modelId: "google/gemini-3.1-flash-image-preview" } });
  } finally {
    releaseCreation();
    await page.unrouteAll({ behavior: "wait" });
  }
  await page.goto(`${app.origin}/models`); await expect(page.getByRole("button", { name: "保存模型偏好" })).toBeVisible(); await page.screenshot({ path: info.outputPath("workspace-models.png"), fullPage: true }); expect(app.providerCalls).toHaveLength(0);
  // The offline feed deliberately returns a duplicate id and one unusable id.
  // Those rows are skipped and reported, but the two usable models are still
  // listed: a partial parse must not present an empty catalog as unavailable.
  await expect(page.getByText("Claude Opus Offline", { exact: true })).toBeVisible();
  await expect(page.getByText("Gemini Flash Offline", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("目录暂不可用。", { exact: true })).toHaveCount(0);
  // The skipped count describes a live parse, so read it after a forced
  // refresh rather than from the cached first load.
  await page.getByRole("button", { name: "刷新当前目录" }).click();
  // Said beside the count on demand rather than as a headline.
  await expect(page.getByRole("img", { name: "已跳过 2 条无效或重复记录，其余目录可用。", exact: true })).toBeVisible();
  await expect(page.getByText("Claude Opus Offline", { exact: true })).toBeVisible();
});

test("configured chat fallback runs through the real provider adapter and persists usage estimates", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin); await page.goto(`${app.origin}/models`);
  for (const modelId of ["anthropic/claude-opus-4.6", "google/gemini-3-flash-preview"]) {
    const catalogRow = page.locator("li").filter({ hasText: modelId });
    await catalogRow.getByRole("button", { name: "添加", exact: true }).click();
    await expect(catalogRow.getByRole("button", { name: "已添加", exact: true })).toBeVisible();
  }
  await chooseOption(page.getByLabel("聊天默认模型", { exact: true }), "Claude Opus Offline");
  await chooseOption(page.getByLabel("聊天备用模型", { exact: true }), "Gemini Flash Offline");
  await page.getByText("配置估算费率（USD）", { exact: true }).click();
  // Rates are keyed by provider and model, so the two entries for the same
  // underlying model reached through different providers are edited separately.
  const rateKey = "openrouter:google/gemini-3-flash-preview";
  await page.getByLabel(`${rateKey} 输入 / 百万 Token`, { exact: true }).fill("2"); await page.getByLabel(`${rateKey} 输出 / 百万 Token`, { exact: true }).fill("4");
  await page.getByRole("button", { name: "保存模型偏好" }).click(); await expect(toasts(page)).toContainText("已保存");
  // Each library entry is checked against what the catalogs currently say about
  // it, keyed by provider and model rather than by model id alone. An entry the
  // catalogs know carries no status; only one that cannot be used says why.
  const library = page.locator('section[aria-label="我的模型"]');
  for (const modelId of ["anthropic/claude-opus-4.6", "google/gemini-3-flash-preview"]) {
    const row = library.locator("li").filter({ hasText: modelId });
    await expect(row).toBeVisible();
    for (const label of ["可用", "未配置密钥", "目录暂不可用", "尚未获取目录", "官方目录已不再提供"]) await expect(row).not.toContainText(label);
  }
  // The fallback takes over a conversation with every tool attached: the general assistant.
  await page.goto(`${app.origin}/chat`);
  await expect(page.getByRole("checkbox", { name: "仅手动", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "新会话", exact: true }).click();
  await expectTemplate(page, "通用助理");
  await page.getByPlaceholder(/输入你的问题/).fill("OFFLINE_PRIMARY_FAILURE 测试备用模型"); await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("离线回答：OFFLINE_PRIMARY_FAILURE 测试备用模型", { exact: true })).toBeVisible();
  // The turn's own call (the conversation's title, written after it, may fall back as well).
  await expect.poll(async () => (await browserData(page, "/api/usage")).recent.filter((row: { fallback: boolean; source: string }) => row.fallback && row.source === "chat").length).toBe(1);
  const usage = await browserData(page, "/api/usage"); const backup = usage.recent.find((row: { fallback: boolean; source: string }) => row.fallback && row.source === "chat"); expect(backup).toMatchObject({ modelId: "google/gemini-3-flash-preview", inputTokens: 10, outputTokens: 10, costSource: "configured", costUsd: 0.00006 });
  // The primary's 503 is retried three times before the fallback answers; each attempt is recorded.
  expect(app.providerCalls.filter(call => call.stream)).toHaveLength(5);
  expect(usage.recent.filter((row: { fallback: boolean; status: string }) => !row.fallback && row.status === "error")).toHaveLength(4);
  await app.restart(); await page.goto(`${app.origin}/chat?settings=usage`);
  await page.getByRole("button", { name: "查看调用明细", exact: true }).click();
  const usageDrawer = page.getByRole("dialog", { name: "模型调用明细", exact: true });
  // The turn's own call; the title written after it is internal work, listed under its own source.
  const fallbackRow = usageDrawer.getByRole("listitem").filter({ hasText: "成功（备用）" }).filter({ hasText: "· 聊天" });
  await expect(fallbackRow).toHaveCount(1);
  await expect(fallbackRow.getByText("$0.000060", { exact: true })).toBeVisible();
});

test("model settings and usage reject invalid prices and a missing credential over HTTP", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin);
  const { data: settings } = await browserData(page, "/api/models");
  // A selection the library does not contain is refused, whether it is named by
  // provider and id or by a bare id from the era before it had to be.
  expect((await browserApi(page, "/api/models", "PUT", { ...settings, chat: { model: { providerId: "openrouter", modelId: "removed/model" }, fallback: null } })).status).toBe(400);
  expect((await browserApi(page, "/api/models", "PUT", { ...settings, chat: { modelId: "removed/model", fallbackId: null } })).status).toBe(400);
  expect((await browserApi(page, "/api/models", "PUT", { ...settings, rates: { invalid: { inputPerMillion: -1, outputPerMillion: 0, perRequest: null } } })).status).toBe(400);
  expect((await browserApi(page, "/api/models", "PUT", { ...settings, rates: { "openrouter:removed/model": { inputPerMillion: -1, outputPerMillion: 0, perRequest: null } } })).status).toBe(400);
  expect((await browserData(page, "/api/usage")).totals.costUsd).toBeNull();
  const stored = app.readRows("SELECT settings FROM account_preferences");
  await page.goto(`${app.origin}/models`); await expect(page.getByRole("button", { name: "保存模型偏好" })).toBeVisible();
  // Dropping the credential refuses the write; nothing is persisted.
  await page.context().clearCookies(); await page.getByRole("button", { name: "保存模型偏好" }).click(); await expect(settingsDialog(page).getByRole("alert")).toContainText(/凭证|Authentication required/);
  expect(app.readRows("SELECT settings FROM account_preferences")).toEqual(stored); expect(app.providerCalls).toHaveLength(0);
});

test("adding and removing models changes only the model's own row and button: the list, the catalog and the rest of the page stay put", async ({ page, app }) => {
  await page.setViewportSize({ width: 1280, height: 360 });
  await register(page, app.origin); await page.goto(`${app.origin}/models`);
  const library = page.locator("#model-library");
  const count = library.locator("h2 + span");
  const catalogRow = (modelId: string) => page.locator("#model-catalog li").filter({ hasText: modelId });
  await expect(library.getByText("“我的模型”为空", { exact: false })).toBeVisible();
  await expect(count).toHaveText("0");
  // The catalog's search and scroll position, which a change must not reset.
  // Every catalog id has a slash, so the whole catalog stays listed and can be scrolled.
  await page.getByLabel("搜索模型目录", { exact: true }).fill("/");
  const scroller = page.getByRole("region", { name: "模型目录结果" });
  const catalogList = scroller.getByRole("list");
  await expect(catalogRow("anthropic/claude-opus-4.6")).toBeVisible();
  const scrollCatalog = async () => {
    await expect.poll(() => scroller.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThanOrEqual(12);
    const top = await scroller.evaluate(node => { node.scrollTop = 12; return node.scrollTop; });
    expect(top).toBeGreaterThan(0);
    return top;
  };
  // The rows the catalog shows now are the ones it shows at the end: nothing is rebuilt, so nothing scrolls back.
  await catalogList.evaluate(node => { (node as HTMLElement & { __kept?: boolean }).__kept = true; });

  // Each library change waits a while, so what the page does meanwhile can be seen.
  let release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  let fail = false;
  await page.route("**/api/models/library", async route => {
    await gate;
    if (fail) await route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "模型库暂时无法写入" } } });
    else await route.continue();
  });
  const watch = () => page.evaluate(() => {
    const seen = { emptied: false, dimmed: 0 };
    const library = document.querySelector("#model-library")!;
    new MutationObserver(() => { if (!library.querySelector("li") && !library.querySelector(".models-library-empty")) seen.emptied = true; }).observe(library, { childList: true, subtree: true });
    new MutationObserver(records => { for (const record of records) if ((record.target as HTMLElement).hasAttribute("disabled")) seen.dimmed++; })
      .observe(document.body, { subtree: true, attributes: true, attributeFilter: ["disabled"] });
    (window as unknown as { __seen: typeof seen }).__seen = seen;
  });
  const seen = () => page.evaluate(() => (window as unknown as { __seen: { emptied: boolean; dimmed: number } }).__seen);

  // The first model: only its own button waits; other buttons and the preference controls stay usable.
  await watch();
  await catalogRow("anthropic/claude-opus-4.6").getByRole("button", { name: "添加", exact: true }).click();
  await expect(catalogRow("anthropic/claude-opus-4.6").getByRole("button", { name: "添加", exact: true })).toBeDisabled();
  await expect(catalogRow("google/gemini-3-flash-preview").getByRole("button", { name: "添加", exact: true })).toBeEnabled();
  await expect(page.getByLabel("新会话默认模式", { exact: true })).toBeEnabled();
  await expect(library.getByText("“我的模型”为空", { exact: false })).toBeVisible();
  // The click can scroll its own target into view. Measure from the position the response must preserve.
  const addingScrollTop = await scrollCatalog();
  release();
  await expect(catalogRow("anthropic/claude-opus-4.6").getByRole("button", { name: "已添加", exact: true })).toBeVisible();
  await expect(library.locator("li")).toHaveCount(1);
  await expect(count).toHaveText("1");
  expect((await seen()).dimmed, "only the button that was pressed was disabled").toBe(1);
  expect(await scroller.evaluate(node => node.scrollTop)).toBe(addingScrollTop);

  // A second one, then a failing one: the list stays as it was shown, and the button can be pressed again.
  gate = Promise.resolve();
  await catalogRow("google/gemini-3-flash-preview").getByRole("button", { name: "添加", exact: true }).click();
  await expect(catalogRow("google/gemini-3-flash-preview").getByRole("button", { name: "已添加", exact: true })).toBeVisible();
  await expect(count).toHaveText("2");
  const removingScrollTop = await scrollCatalog();
  fail = true;
  gate = new Promise<void>(resolve => { release = resolve; });
  await watch();
  await chooseRowAction(page, library.locator("li").first(), "移除");
  await expect(library.locator("li")).toHaveCount(2);
  release();
  await expect(page.getByRole("alert").filter({ hasText: "模型库暂时无法写入" })).toBeVisible();
  await expect(library.locator("li")).toHaveCount(2);
  await expect(count).toHaveText("2");
  await expect(library.getByRole("button", { name: /^更多操作 / }).first()).toBeEnabled();
  expect((await seen()).emptied).toBe(false);

  // Removing them, down to the last one: rows go, the count and the catalog buttons follow.
  fail = false;
  gate = Promise.resolve();
  for (const remaining of [1, 0]) {
    await chooseRowAction(page, library.locator("li").first(), "移除");
    await expect(library.locator("li")).toHaveCount(remaining);
    await expect(count).toHaveText(String(remaining));
  }
  await expect(library.getByText("“我的模型”为空", { exact: false })).toBeVisible();
  await expect(catalogRow("anthropic/claude-opus-4.6").getByRole("button", { name: "添加", exact: true })).toBeEnabled();
  await expect(page.getByLabel("搜索模型目录", { exact: true })).toHaveValue("/");
  // Rebuilt rows are what would send the list back to its top; these were kept, and the frame keeps its height.
  expect(await catalogList.evaluate(node => (node as HTMLElement & { __kept?: boolean }).__kept)).toBe(true);
  expect(await scroller.evaluate(node => node.scrollTop)).toBe(removingScrollTop);
});

test("the model library ends as far above the catalog's line as the catalog starts below it, with rows or without", async ({ page, app }) => {
  await register(page, app.origin); await page.goto(`${app.origin}/models`);
  await expect(page.locator("#model-library").getByText("“我的模型”为空", { exact: false })).toBeVisible();
  // Measured once rows have finished coming in: a row enters with a short slide.
  const gaps = async () => { await page.waitForFunction(() => document.querySelector("#model-library")!.getAnimations({ subtree: true }).every(animation => animation.playState === "finished")); return page.evaluate(() => {
    const catalog = document.querySelector("#model-catalog")!.getBoundingClientRect();
    const library = document.querySelector("#model-library")!;
    const last = library.querySelector("li:last-child");
    // A row's content ends at its padding; the empty note is its own text.
    const end = last ? last.getBoundingClientRect().bottom - parseFloat(getComputedStyle(last).paddingBottom) : library.querySelector(".models-library-empty")!.getBoundingClientRect().bottom;
    const heading = document.querySelector("#model-catalog > div")!.getBoundingClientRect();
    return { above: Math.round(catalog.top - end), below: Math.round(heading.top - catalog.top) };
  }); };
  const empty = await gaps();
  expect(Math.abs(empty.above - empty.below)).toBeLessThanOrEqual(2);
  await page.locator("#model-catalog li").filter({ hasText: "anthropic/claude-opus-4.6" }).getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.locator("#model-library li")).toHaveCount(1);
  const withRow = await gaps();
  expect(Math.abs(withRow.above - withRow.below)).toBeLessThanOrEqual(2);
});

test("the catalog holds its full height while it is read, then eases down to fit a short list and refits as a search narrows it", async ({ page, app }) => {
  await register(page, app.origin);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.pathname === "/api/models/catalog", async route => { await gate; await route.continue(); });
  await page.goto(`${app.origin}/models`);
  const frame = page.locator(".catalog-scroll");
  await expect(frame).toHaveAttribute("data-state", "loading");
  await expect(frame).toContainText("正在读取模型目录");
  const full = (await frame.boundingBox())!.height;
  expect(full).toBeGreaterThan(300);
  // Each height the frame passes through once the catalog arrives.
  await frame.evaluate(node => {
    const heights: number[] = [];
    (window as unknown as { heights: number[] }).heights = heights;
    const tick = () => { heights.push(Math.round(node.getBoundingClientRect().height)); if (heights.length < 90) requestAnimationFrame(tick); };
    tick();
  });
  release();
  await expect(frame).toHaveAttribute("data-state", "list");
  await page.waitForTimeout(1600);
  const fitted = (await frame.boundingBox())!.height;
  const content = await frame.locator(".catalog-scroll-content").evaluate(node => (node as HTMLElement).offsetHeight);
  expect(fitted).toBeLessThan(full);
  expect(Math.abs(fitted - Math.min(content + 2, full))).toBeLessThanOrEqual(2);
  const heights = await page.evaluate(() => (window as unknown as { heights: number[] }).heights);
  expect(heights.some(height => height < full - 4 && height > fitted + 4), `eased through: ${heights.join(",")}`).toBe(true);
  // A narrower search refits it, from the top.
  await page.getByLabel("搜索模型目录", { exact: true }).fill("claude-opus");
  await expect.poll(async () => (await frame.boundingBox())!.height).toBeLessThan(fitted);
  expect(await frame.evaluate(node => node.scrollTop)).toBe(0);
  await page.getByLabel("搜索模型目录", { exact: true }).fill("nothing-matches-this");
  await expect(frame).toHaveAttribute("data-state", "empty");
  await expect(frame).toContainText("没有匹配的模型");
});
