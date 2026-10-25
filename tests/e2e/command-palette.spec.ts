import { test as base, expect } from "@playwright/test";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { configureOfflineModels } from "../helpers/model-fixture";
import { browserApi, browserData } from "../helpers/browser-api";
import { settingsDialog } from "../helpers/settings";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => { const app = await startStandaloneServer({ modelFixture: true }); try { await runTest(app); } finally { await app.close(); } },
});

const palette = (page: import("@playwright/test").Page) => page.getByRole("combobox", { name: "命令面板", exact: true });

test("Ctrl+K reaches pages, settings sections and conversations from anywhere", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await browserApi(page, "/api/conversations", "POST", { title: "季度复盘提纲" });
  await browserApi(page, "/api/conversations", "POST", { title: "旅行行李清单" });
  await page.goto(`${app.origin}/`);

  await page.keyboard.press("Control+K");
  await expect(palette(page)).toBeFocused();
  await palette(page).fill("任务");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(palette(page)).toHaveCount(0);

  await page.keyboard.press("Control+K");
  await palette(page).fill("API");
  await expect(page.getByRole("option", { name: /API 密钥/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(settingsDialog(page).getByRole("tab", { name: "API 密钥", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(settingsDialog(page)).toBeHidden();

  // A conversation found by part of its title opens in chat.
  await page.keyboard.press("Control+K");
  await palette(page).fill("复盘");
  const found = page.getByRole("option", { name: /季度复盘提纲/ });
  await expect(found).toBeVisible();
  await found.click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.locator(".chat-toolbar h3")).toHaveText("季度复盘提纲");
  // Moving the selection with the arrow keys and Escape closes without acting.
  await page.keyboard.press("Control+K");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
});

test("keyboard shortcuts start a conversation, focus the message box and list themselves", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await browserApi(page, "/api/conversations", "POST", { title: "已有会话" });
  await page.goto(`${app.origin}/tasks`);
  // From another page: chat opens and a new conversation is created there.
  await page.keyboard.press("Control+Shift+O");
  await expect(page).toHaveURL(/\/chat$/);
  await expect.poll(async () => (await browserData(page, "/api/conversations")).length).toBe(2);
  await expect(page.locator(".chat-toolbar h3")).toHaveText("New Chat");

  await page.locator(".chat-toolbar h3").click();
  await page.keyboard.press("Shift+Escape");
  await expect(page.getByPlaceholder(/输入你的问题/)).toBeFocused();

  await page.keyboard.press("Control+/");
  const help = page.getByRole("dialog", { name: "键盘快捷键", exact: true });
  await expect(help).toBeVisible();
  for (const label of ["打开命令面板", "新建会话", "聚焦输入框", "打开或关闭执行记录", "停止生成（光标在输入框时）"]) await expect(help.getByText(label, { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
});

test("the palette switches the chat model", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await browserApi(page, "/api/conversations", "POST", { title: "切换模型" });
  await page.goto(`${app.origin}/chat`);
  const picker = page.getByRole("combobox", { name: "选择模型", exact: true });
  await expect(picker).toContainText("Claude Opus Offline");
  await page.keyboard.press("Control+K");
  await palette(page).fill("Gemini");
  await expect(page.getByRole("option", { name: /Gemini Flash Offline/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(picker).toContainText("Gemini Flash Offline");
});
