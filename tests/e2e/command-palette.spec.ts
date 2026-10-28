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

  // One character is below the service's search length: recent titles are filtered, not listed whole.
  await page.keyboard.press("Control+K");
  await palette(page).fill("旅");
  await expect(page.getByRole("option", { name: /旅行行李清单/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /季度复盘提纲/ })).toHaveCount(0);
  await palette(page).fill("");
  await expect(page.getByRole("option", { name: /季度复盘提纲/ })).toBeVisible();
  await page.keyboard.press("Escape");

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

test("the palette floats without blocking the page, and pinning or dragging keeps it beside the work", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/`);
  const navigation = page.getByRole("navigation", { name: "工作区导航" });
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  // The page behind keeps its colour and takes the click; an unmoved palette steps aside.
  await page.keyboard.press("Control+K");
  await expect(palette(page)).toBeFocused();
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(background);
  await navigation.getByRole("link", { name: "任务", exact: true }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(palette(page)).toHaveCount(0);

  // Dragged by its footer, it moves, keeps the caret, and survives clicks on the page.
  await page.keyboard.press("Control+K");
  const box = page.locator(".command-palette");
  const settled = () => page.waitForFunction(() => document.querySelector(".command-palette")?.getAnimations().length === 0);
  await settled();
  const before = (await box.boundingBox())!;
  const handle = (await page.locator(".command-palette-footer").boundingBox())!;
  await page.mouse.move(handle.x + 40, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 240, handle.y + handle.height / 2 - 60, { steps: 6 });
  await page.mouse.up();
  const after = (await box.boundingBox())!;
  expect(Math.round(after.x - before.x)).toBe(200);
  expect(Math.round(after.y - before.y)).toBe(-60);
  await expect(palette(page)).toBeFocused();
  const pin = page.getByRole("button", { name: "固定命令面板", exact: true });
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".command-palette-footer")).toContainText("已固定");
  await navigation.getByRole("link", { name: "聊天", exact: true }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(palette(page)).toBeVisible();
  // Set aside, its contents step back until it is used again; the surface stays opaque.
  await page.mouse.move(2, 2);
  await expect(page.locator(".command-palette-list")).toHaveCSS("opacity", "0.55");
  await expect(box).toHaveCSS("opacity", "1");
  // Escape outside it is left to the page; Ctrl+K brings focus back, then Escape closes it.
  await page.getByPlaceholder(/输入你的问题/).click();
  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press("Control+K");
  await expect(palette(page)).toBeFocused();
  // A pinned palette runs a command and stays, ready for the next one.
  await palette(page).fill("任务");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(palette(page)).toHaveValue("");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);

  // Pinned with the button alone it stays too; unpinned, the next click elsewhere closes it.
  await page.keyboard.press("Control+K");
  await pin.click();
  await navigation.getByRole("link", { name: "首页", exact: true }).click();
  await expect(palette(page)).toBeVisible();
  await pin.click();
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await navigation.getByRole("link", { name: "聊天", exact: true }).click();
  await expect(palette(page)).toHaveCount(0);

  // Reopened, it starts from its usual place, and the close button dismisses it.
  await page.keyboard.press("Control+K");
  await settled();
  expect(Math.round((await box.boundingBox())!.x)).toBe(Math.round(before.x));
  // Focus the page moves by itself (the composer after navigation) is not a click away.
  await page.evaluate(() => document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus());
  await expect(page.getByPlaceholder(/输入你的问题/)).toBeFocused();
  await expect(palette(page)).toBeVisible();
  await page.getByRole("button", { name: "关闭命令面板", exact: true }).click();
  await expect(palette(page)).toHaveCount(0);
});

test("closing the palette from inside returns focus to where the user was", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/chat`);
  const composer = page.getByPlaceholder(/输入你的问题/);
  await composer.click();
  await page.keyboard.press("Control+K");
  await expect(palette(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
  await expect(composer).toBeFocused();
});

test("the chat title bar search opens the palette and names its shortcut", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/`);
  const search = page.getByRole("button", { name: /搜索会话、页面和操作/ });
  // Only the chat page carries it.
  await expect(search).toHaveCount(0);
  await page.goto(`${app.origin}/chat`);
  await expect(search).toContainText("Ctrl K");
  const bar = (await page.locator(".workspace-main > .workspace-topbar").boundingBox())!;
  const box = (await search.boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - (bar.x + bar.width / 2))).toBeLessThan(2);
  await search.click();
  await expect(palette(page)).toBeFocused();
  // Pressing it again while open is not a click away: the palette stays and keeps focus.
  await search.click();
  await expect(palette(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
  await expect(search).toBeFocused();
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
