import { openExecutionDetails } from "../helpers/execution-records";
import { expect, test as base, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startStandaloneServer } from "../helpers/standalone-server";
import { startExtensionService, echoSchema } from "../helpers/extension-service";
import { configureOfflineModels } from "../helpers/model-fixture";
import { browserApi, browserData } from "../helpers/browser-api";

type App = { runtime: Awaited<ReturnType<typeof startStandaloneServer>>; service: Awaited<ReturnType<typeof startExtensionService>> };
const test = base.extend<{ app: App }>({ app: async ({}, provide) => {
  const service = await startExtensionService();
  const runtime = await startStandaloneServer({ modelFixture: true, extensionFixtureOrigin: service.origin });
  try { await provide({ runtime, service }); } finally { await runtime.close(); await service.close(); }
} });
async function create(page: Page, app: App, name: string, kind: "http" | "mcp-http", credentials = false) {
  await page.goto(`${app.runtime.origin}/extensions`);
  await expect(page.getByRole("heading", { name: "扩展管理", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "添加扩展", exact: true }).first().click();
  await page.getByLabel("扩展名称", { exact: true }).fill(name);
  if (kind === "http") {
    await page.getByLabel("连接类型", { exact: true }).click();
    await page.getByRole("option", { name: "HTTP · API 接口", exact: true }).click();
    await page.getByLabel("工具用途", { exact: true }).fill("Echo a browser test value");
    await page.getByLabel("参数格式（JSON Schema）", { exact: true }).fill(JSON.stringify(echoSchema));
  }
  await page.getByLabel("接口地址", { exact: true }).fill(`${app.service.origin}/${kind === "http" ? "http" : "mcp"}`);
  if (credentials) {
    await page.getByLabel("凭据名称 1", { exact: true }).fill("Authorization");
    await page.getByLabel("凭据值 1", { exact: true }).fill("Bearer synthetic-browser-token");
  }
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "添加扩展", exact: true })).toHaveCount(0);
  const row = (await browserData(page, "/api/extensions")).items.find(item => item.name === name);
  expect(row.enabled).toBe(false);
  return row;
}
async function enable(page: Page, row, toolName: string) {
  const card = page.getByTestId(`extension-${row.id}`);
  await card.getByRole("button", { name: "检测连接", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: `${row.name} · 工具`, exact: true });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel(toolName, { exact: true }).check();
  await sheet.getByRole("button", { name: "启用所选工具", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(card.getByText("已启用", { exact: true })).toBeVisible();
}
async function ask(page: Page, app: App) {
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "扩展调用验证" })).body.data;
  await page.evaluate(id => localStorage.setItem("chat:last-active-id", id), chat.id);
  await page.goto(`${app.runtime.origin}/chat?conversationId=${chat.id}`);
  await page.getByPlaceholder(/输入你的问题/).fill("OFFLINE_EXTENSION_TOOL");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("button", { name: "批准", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "批准", exact: true })).toBeEnabled();
  await page.getByRole("region", { name: "操作审批", exact: true }).getByRole("button", { name: "查看详情", exact: true }).click();
  await expect(page.getByLabel("待审批参数", { exact: true })).not.toContainText("extensionId");
  await expect.poll(async () => (await browserData(page, `/api/conversations/${chat.id}/messages`)).some(message => message.content.includes('"state":"approval-requested"') && message.content.includes('"binding"'))).toBe(true);
  return chat;
}
const shots = join(tmpdir(), "ria-extensions-qa");

test("long extension names stay inside narrow cards and tool sheets without covering status labels", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const name = "AnExtensionNameWithoutAnyBreaks".repeat(2);
  const row = await create(page, app, name, "mcp-http");
  const card = page.getByTestId(`extension-${row.id}`);
  const title = card.getByRole("heading", { name, exact: true });
  const status = (await card.getByText("待检测", { exact: true }).boundingBox())!;
  const textRight = await title.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); return Math.max(...Array.from(range.getClientRects(), rect => rect.right)); });
  expect(textRight).toBeLessThanOrEqual(status.x - 8);
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: join(shots, "mobile-long-name.png"), animations: "disabled" });
  const trigger = card.getByRole("button", { name: "检测连接", exact: true });
  await trigger.click();
  const sheet = page.getByRole("dialog", { name: `${name} · 工具`, exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveCSS("animation-name", "sheet-in");
  await sheet.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
  const heading = sheet.getByRole("heading", { name: `${name} · 工具`, exact: true });
  const right = await heading.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); return Math.max(...Array.from(range.getClientRects(), rect => rect.right)); });
  expect(right).toBeLessThan(390 - 24);
  await page.screenshot({ path: join(shots, "mobile-long-name-tools.png"), animations: "disabled" });
  await page.keyboard.press("Escape"); await expect(sheet).toBeHidden(); await expect(trigger).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await card.getByRole("button", { name: "管理工具", exact: true }).click();
  await expect(sheet).toHaveCSS("animation-name", "none");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(title).toBeVisible();
  await page.screenshot({ path: join(shots, "desktop-light.png"), animations: "disabled" });
  expect(errors).toEqual([]);
});

test("HTTP extension management, approved calls and encrypted credentials survive restart and uninstall preserves chat", { tag: "@integration" }, async ({ page, app }) => {
  test.setTimeout(60_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const consoles: string[] = []; page.on("console", message => { if (message.type() === "error") consoles.push(message.text()); });
  await page.setViewportSize({ width: 1440, height: 960 });
  const row = await create(page, app, "HTTP echo", "http", true);
  await enable(page, row, "request");
  expect(app.service.state.calls).toHaveLength(0);
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: join(shots, "desktop.png"), fullPage: false, animations: "disabled" });
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const chat = await ask(page, app);
  await page.reload();
  await expect(page.getByRole("button", { name: "批准", exact: true })).toBeVisible();
  expect(app.service.state.calls).toHaveLength(0);
  await page.screenshot({ path: join(shots, "approval.png"), fullPage: false, animations: "disabled" });
  await page.getByRole("button", { name: "批准", exact: true }).click();
  await expect.poll(() => app.service.state.calls.length).toBe(1);
  expect(app.service.state.calls[0].authorization).toBe("Bearer synthetic-browser-token");
  await expect.poll(async () => (await browserData(page, `/api/conversations/${chat.id}/messages`)).some(message => message.content.includes('"state":"output-available"'))).toBe(true);
  await app.runtime.restart(); await page.reload();
  await openExecutionDetails(page);
  await expect(page.getByText("工具详情：HTTP echo · request · 执行完成", { exact: true })).toBeVisible();
  const config = await browserData(page, "/api/extensions");
  expect(config.items[0].enabled).toBe(true); expect(JSON.stringify(config)).not.toContain("synthetic-browser-token");
  await page.goto(`${app.runtime.origin}/extensions`);
  await page.getByTestId(`extension-${row.id}`).getByRole("button", { name: "配置", exact: true }).click();
  await expect(page.getByLabel("凭据值 1", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "删除扩展 HTTP echo", exact: true }).click();
  await expect(page.getByTestId(`extension-${row.id}`)).toHaveCount(0);
  await page.goto(`${app.runtime.origin}/chat?conversationId=${chat.id}`);
  await page.getByPlaceholder(/输入你的问题/).fill("继续说明");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator("article").last()).toContainText("离线回答：继续说明");
  expect(app.service.state.calls).toHaveLength(1); expect(errors).toEqual([]); expect(consoles).toEqual([]);
});

test("MCP discovery exposes real tools while rejection and later configuration edits prevent execution", { tag: "@integration" }, async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const row = await create(page, app, "MCP echo", "mcp-http"); await enable(page, row, "echo");
  expect(app.service.state.calls).toHaveLength(0);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const deniedChat = await ask(page, app);
  await page.getByRole("button", { name: "拒绝", exact: true }).click();
  await expect(page.getByRole("button", { name: "批准", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await browserData(page, `/api/conversations/${deniedChat.id}/messages`)).some(message => message.content.includes('"state":"output-denied"'))).toBe(true);
  expect(app.service.state.calls).toHaveLength(0);
  const approvedChat = await ask(page, app);
  await page.getByRole("button", { name: "批准", exact: true }).click();
  await expect.poll(() => app.service.state.calls.length).toBe(1);
  await expect.poll(async () => (await browserData(page, `/api/conversations/${approvedChat.id}/messages`)).some(message => message.content.includes('"state":"output-available"'))).toBe(true);
  const chat = await ask(page, app);
  const saved = (await browserData(page, "/api/extensions")).items[0];
  const changed = await browserApi(page, `/api/extensions/${row.id}`, "PUT", { name: row.name, config: row.config, revision: saved.revision });
  expect(changed.status).toBe(200);
  const response = page.waitForResponse(item => item.url().endsWith("/api/chat") && item.request().method() === "POST");
  await page.getByRole("button", { name: "批准", exact: true }).click();
  expect((await response).status()).toBe(409);
  expect(app.service.state.calls).toHaveLength(1);
  await page.reload();
  expect((await browserData(page, `/api/conversations/${chat.id}/messages`)).some(message => message.content.includes('"state":"approval-requested"'))).toBe(true);
  expect(errors).toEqual([]);
});

test("extension sheets remain usable in a narrow window, restore focus, validate drafts and recover from failed detection", { tag: "@integration" }, async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${app.runtime.origin}/extensions`);
  const add = page.getByRole("button", { name: "添加扩展", exact: true }).first(); await add.click();
  const sheet = page.getByRole("dialog", { name: "添加扩展", exact: true });
  await expect(sheet).toBeVisible();
  await page.getByLabel("扩展名称", { exact: true }).fill("Draft");
  await page.getByLabel("连接类型", { exact: true }).click(); await page.getByRole("option", { name: "HTTP · API 接口", exact: true }).click();
  await page.getByLabel("接口地址", { exact: true }).fill(`${app.service.origin}/http`);
  await page.getByLabel("工具用途", { exact: true }).fill("Echo");
  await page.getByLabel("参数格式（JSON Schema）", { exact: true }).fill("{");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(sheet.getByRole("alert")).toContainText("参数格式必须是有效的 JSON Schema");
  await expect(page.getByLabel("扩展名称", { exact: true })).toHaveValue("Draft");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir(shots, { recursive: true }); await page.screenshot({ path: join(shots, "mobile-editor.png"), fullPage: false, animations: "disabled" });
  await page.keyboard.press("Escape"); await expect(sheet).toHaveCount(0); await expect(add).toBeFocused();
  const row = await create(page, app, "Recoverable API", "http");
  app.service.state.fail = true;
  await page.getByTestId(`extension-${row.id}`).getByRole("button", { name: "检测连接", exact: true }).click();
  await expect(page.getByTestId(`extension-${row.id}`)).toContainText("连接失败");
  app.service.state.fail = false; await enable(page, row, "request");
  await page.screenshot({ path: join(shots, "mobile.png"), fullPage: false, animations: "disabled" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByTestId(`extension-${row.id}`).getByRole("button", { name: "停用", exact: true }).click();
  await expect(page.getByTestId(`extension-${row.id}`).getByText("已停用", { exact: true })).toBeVisible();
  expect(app.service.state.calls).toHaveLength(0); expect(errors).toEqual([]);
});
