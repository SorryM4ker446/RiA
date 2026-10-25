import { test as base, expect } from "@playwright/test";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { browserApi, browserData } from "../helpers/browser-api";
import { configureOfflineModels } from "../helpers/model-fixture";
import { openSettings, settingsDialog } from "../helpers/settings";
import { toasts } from "../helpers/toast";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer({ modelFixture: true });
    try { await runTest(app); } finally { await app.close(); }
  },
});

test("settings open over the current page and closing returns to it", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/tasks`);
  const pageTitle = page.getByRole("heading", { level: 1 });
  const title = await pageTitle.textContent();
  const dialog = await openSettings(page);
  // The browser has no provider keys to edit, so settings open on the preferences.
  await expect(page).toHaveURL(`${app.origin}/tasks?settings=application`);
  await expect(dialog.getByRole("tab", { name: "应用偏好", exact: true })).toHaveAttribute("aria-selected", "true");
  await dialog.getByRole("tab", { name: "模型", exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}/tasks?settings=models`);
  // Moving between sections replaces the entry, so going back closes the overlay in one step.
  await page.goBack();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(`${app.origin}/tasks`);
  await expect(pageTitle).toHaveText(title!);

  await openSettings(page, "用量");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(`${app.origin}/tasks`);

  // Old addresses of these pages open the matching section over chat.
  for (const [path, value, section] of [["/models", "models", "模型"], ["/backups", "backups", "备份与恢复"], ["/extensions", "extensions", "扩展"]] as const) {
    await page.goto(`${app.origin}${path}`);
    await expect(page).toHaveURL(`${app.origin}/chat?settings=${value}`);
    await expect(dialog.getByRole("tab", { name: section, exact: true })).toHaveAttribute("aria-selected", "true");
  }
  // Opened by address, closing leaves the page beneath without the overlay in its address.
  await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(`${app.origin}/chat`);
});

test("unsaved edits survive moving between sections and closing asks before discarding them", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  const dialog = await openSettings(page, "API 密钥");
  await dialog.getByText("连接与站点选项", { exact: false }).click();
  const siteName = dialog.getByLabel("OpenRouter 站点名称", { exact: true });
  await siteName.fill("未保存的站点名称");
  await dialog.getByRole("tab", { name: "备份与恢复", exact: true }).click();
  await dialog.getByRole("tab", { name: "API 密钥", exact: true }).click();
  await expect(siteName).toHaveValue("未保存的站点名称");

  await page.keyboard.press("Escape");
  const discard = page.getByRole("alertdialog", { name: "放弃未保存的更改？", exact: true });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(siteName).toHaveValue("未保存的站点名称");

  await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
  await discard.getByRole("button", { name: "放弃更改", exact: true }).click();
  await expect(dialog).toBeHidden();
  // Going back would drop the edit too, so it asks; keeping it keeps the settings open.
  await openSettings(page, "API 密钥");
  await dialog.getByText("连接与站点选项", { exact: false }).click();
  await siteName.fill("未保存的站点名称");
  await page.goBack();
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(siteName).toHaveValue("未保存的站点名称");
  await expect(page).toHaveURL(/settings=services/);

  // A link out of the settings asks as well, and goes once the edit is given up.
  await dialog.getByRole("tab", { name: "扩展", exact: true }).click();
  const assistants = dialog.getByRole("link", { name: "在助理模板中选择工具", exact: true });
  await assistants.click();
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page).toHaveURL(/settings=extensions/);
  await assistants.click();
  await discard.getByRole("button", { name: "放弃更改", exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}/assistants`);
  await expect(dialog).toBeHidden();

  // Reopened, the section reads what is stored and nothing is left over.
  await openSettings(page, "API 密钥");
  await dialog.getByText("连接与站点选项", { exact: false }).click();
  await expect(siteName).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("saving model preferences keeps a default chat model changed elsewhere meanwhile", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await page.goto(`${app.origin}/chat?settings=models`);
  await page.getByLabel("后台每日调用次数", { exact: true }).fill("3");
  // Another section clears the default chat model while this one still shows it.
  const current = await browserData(page, "/api/models");
  expect((await browserApi(page, "/api/models", "PUT", { ...current, chat: { ...current.chat, model: null } })).status).toBe(200);
  await page.getByRole("button", { name: "保存模型偏好", exact: true }).click();
  await expect(toasts(page)).toContainText("模型偏好已保存");
  const saved = await browserData(page, "/api/models");
  expect(saved.callLimits.backgroundDailyCalls).toBe(3);
  expect(saved.chat.model).toBeNull();
  // The section now shows what was stored, so closing has nothing to discard.
  await page.keyboard.press("Escape");
  await expect(settingsDialog(page)).toBeHidden();
});

test("expanding a section brings it into view without shifting the content sideways", async ({ page, app }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/chat?settings=extensions`);
  const dialog = settingsDialog(page);
  const panel = dialog.locator(".settings-window-panel[data-state='active']");
  // With nothing connected yet, the empty line's action sits at the right edge under the page's own.
  const add = dialog.getByRole("button", { name: "添加扩展", exact: true });
  await expect(add).toHaveCount(2);
  const [header, empty] = [(await add.nth(0).boundingBox())!, (await add.nth(1).boundingBox())!];
  expect(Math.abs((header.x + header.width) - (empty.x + empty.width))).toBeLessThanOrEqual(16);

  const before = await panel.evaluate(node => ({ width: node.clientWidth, top: node.scrollTop }));
  await dialog.locator("summary").filter({ hasText: "内置工具" }).click();
  await expect.poll(() => panel.evaluate(node => node.scrollTop)).toBeGreaterThan(before.top);
  expect(await panel.evaluate(node => node.clientWidth)).toBe(before.width);
  await expect(dialog.getByText("执行终端命令", { exact: true })).toBeInViewport();
});
