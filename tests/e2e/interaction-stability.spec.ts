import { test as base, expect, type Page } from "@playwright/test";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { configureOfflineModels } from "../helpers/model-fixture";
import { browserApi } from "../helpers/browser-api";
import { openRecentConversations } from "../helpers/conversations";
import { settingsDialog } from "../helpers/settings";
import { expectNoUnexpectedShift, expectSteady, watchLayout } from "../helpers/layout-watch";

/**
 * The interaction inventory: each everyday interaction, watched frame by frame
 * for anything already on screen that moves, flashes or jumps. Only the
 * interaction's own target may change; everything around it stays put.
 */
const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => { const app = await startStandaloneServer({ modelFixture: true }); try { await runTest(app); } finally { await app.close(); } },
});

const navigation = (page: Page) => page.getByRole("navigation", { name: "工作区导航" });

async function conversationWithMessages(page: Page, title: string, count: number) {
  const chat = (await browserApi(page, "/api/conversations", "POST", { title })).body.data;
  for (let index = 0; index < count; index++) {
    await browserApi(page, `/api/conversations/${chat.id}/messages`, "POST", { role: index % 2 ? "assistant" : "user", content: `${title} 的第 ${index + 1} 条消息。`.repeat(6), status: "success" });
  }
  return chat.id as string;
}

// Each check runs as the app usually looks, and again in the light theme with
// reduced motion: things must stay put whether or not they are animated.
const variants = [{ theme: "dark", reducedMotion: "no-preference" }, { theme: "light", reducedMotion: "reduce" }] as const;
for (const variant of variants) test.describe(`${variant.theme} theme, ${variant.reducedMotion === "reduce" ? "reduced motion" : "full motion"}`, () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ colorScheme: variant.theme, reducedMotion: variant.reducedMotion });
    await page.addInitScript(theme => localStorage.setItem("ui:theme", theme), variant.theme);
  });

  test("moving between pages keeps the navigation and the content frame still, and each page keeps its scroll", async ({ page, app }) => {
    await openWorkspace(page, app.origin);
    for (let index = 0; index < 30; index++) await browserApi(page, "/api/conversations", "POST", { title: `滚动会话 ${String(index).padStart(2, "0")}` });
    await page.goto(`${app.origin}/`);
    const layout = await watchLayout(page, { navigation: navigation(page), content: ".workspace-content" });
    for (const link of ["聊天", "任务", "管理会话", "知识库", "媒体资源库", "助理模板", "知识专题", "首页"]) {
      await navigation(page).getByRole("link", { name: link, exact: true }).click();
      await expect(navigation(page).getByRole("link", { name: link, exact: true })).toHaveAttribute("aria-current", "page");
    }
    const record = await layout.read();
    expectSteady(record, "navigation");
    expectSteady(record, "content");

    // A long list scrolled part way down is where it was after a trip to chat.
    await navigation(page).getByRole("link", { name: "管理会话", exact: true }).click();
    await expect(page.getByRole("article")).toHaveCount(30);
    const content = page.locator(".workspace-content");
    await content.evaluate(node => node.scrollTo({ top: 600, behavior: "instant" }));
    await expect.poll(() => content.evaluate(node => Math.round(node.scrollTop))).toBe(600);
    await navigation(page).getByRole("link", { name: "聊天", exact: true }).click();
    await expect(page.getByPlaceholder(/输入你的问题/)).toBeVisible();
    await navigation(page).getByRole("link", { name: "管理会话", exact: true }).click();
    await expect.poll(() => content.evaluate(node => Math.round(node.scrollTop))).toBe(600);
    // Another page starts at its own top rather than inheriting that position.
    await navigation(page).getByRole("link", { name: "任务", exact: true }).click();
    await expect.poll(() => content.evaluate(node => Math.round(node.scrollTop))).toBe(0);
  });

  test("switching conversations replaces the transcript without moving the composer or the toolbar", async ({ page, app }) => {
    await openWorkspace(page, app.origin);
    await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
    await conversationWithMessages(page, "第一段对话", 4);
    await conversationWithMessages(page, "第二段对话", 6);
    await page.goto(`${app.origin}/chat`);
    const title = page.locator(".chat-toolbar h3");
    await expect(title).toHaveText("第二段对话");
    await expect(page.getByText("第二段对话 的第 6 条消息。", { exact: false }).first()).toBeVisible();
    await page.evaluate(() => {
      const seen = { welcome: false };
      (window as unknown as { switchSeen: typeof seen }).switchSeen = seen;
      new MutationObserver(() => { if (document.querySelector(".chat-welcome")) seen.welcome = true; }).observe(document.body, { childList: true, subtree: true });
    });
    const layout = await watchLayout(page, {
      composer: ".chat-workspace textarea",
      transcript: "[data-testid=message-list]",
      workspace: page.getByRole("button", { name: /选择工作区|工作区：/ }).first(),
      tools: '.chat-workspace [aria-label="选择工具"]',
    }, { allowShiftsIn: ["[data-testid=message-list]", ".chat-toolbar h3"] });
    await openRecentConversations(page);
    await page.getByRole("complementary", { name: "会话列表", exact: true }).getByRole("button", { name: /^第一段对话/ }).click();
    await expect(title).toHaveText("第一段对话");
    await expect(page.getByText("第一段对话 的第 4 条消息。", { exact: false }).first()).toBeVisible();
    await page.waitForTimeout(300);
    const record = await layout.read();
    // The old conversation gives way to the new one directly: no welcome page in between.
    expect(await page.evaluate(() => (window as unknown as { switchSeen: { welcome: boolean } }).switchSeen.welcome)).toBe(false);
    expectSteady(record, "composer");
    expectSteady(record, "transcript");
    expectSteady(record, "workspace", "left");
    expectSteady(record, "tools", "left");
    expectNoUnexpectedShift(record);
  });

  test("the settings window keeps its size and its categories still while sections change", async ({ page, app }) => {
    await openWorkspace(page, app.origin);
    await page.goto(`${app.origin}/chat`);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const dialog = settingsDialog(page);
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(400);
    const layout = await watchLayout(page, { window: ".settings-window", categories: dialog.getByRole("tablist") });
    for (const section of ["应用偏好", "自动化与通知", "工作区权限", "模型", "用量", "扩展", "备份与恢复", "API 密钥"]) {
      await dialog.getByRole("tab", { name: section, exact: true }).click();
      await expect(dialog.getByRole("tab", { name: section, exact: true })).toHaveAttribute("aria-selected", "true");
    }
    const record = await layout.read();
    expectSteady(record, "window");
    expectSteady(record, "categories");
    expectNoUnexpectedShift(record);
  });

  test("menus open and close without moving their trigger, and give focus back to it", async ({ page, app }) => {
    await openWorkspace(page, app.origin);
    await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
    await conversationWithMessages(page, "菜单测试", 2);
    await page.goto(`${app.origin}/chat`);
    await expect(page.locator(".chat-toolbar h3")).toHaveText("菜单测试");
    for (const name of ["选择模型", "聊天模式", "选择工具", "助理模板"]) {
      const trigger = page.getByRole("combobox", { name, exact: true });
      await expect(trigger).toBeEnabled();
      const layout = await watchLayout(page, { trigger, composer: ".chat-workspace textarea" });
      await trigger.click();
      await expect(page.getByRole("listbox")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await expect(trigger).toBeFocused();
      const record = await layout.read();
      expectSteady(record, "trigger");
      expectSteady(record, "composer");
    }
  });

  test("switching the interface language keeps the navigation and window frame in place", async ({ page, app }) => {
    await openWorkspace(page, app.origin);
    await page.goto(`${app.origin}/settings`);
    // Measured once the window has finished opening.
    await expect(settingsDialog(page)).toBeVisible();
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"));
    // The open settings window hides the page from role queries, so the rail is found by its class.
    const layout = await watchLayout(page, { navigation: ".workspace-navigation", window: ".settings-window" });
    await page.getByRole("tab", { name: "应用偏好", exact: true }).click();
    await page.getByRole("combobox", { name: "界面语言", exact: true }).click();
    await page.getByRole("option", { name: "English", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    await page.waitForTimeout(300);
    const record = await layout.read();
    expectSteady(record, "navigation");
    expectSteady(record, "window");
  });

  test("switching the theme repaints without moving anything", async ({ page, app }) => {
    await openWorkspace(page, app.origin);
    await page.goto(`${app.origin}/tasks`);
    await expect(page.getByRole("heading", { name: "任务", exact: true })).toBeVisible();
    const layout = await watchLayout(page, { navigation: navigation(page), content: ".workspace-content", title: page.getByRole("heading", { name: "任务", exact: true }) });
    const toggle = page.locator(".workspace-shell").getByRole("button", { name: /主题|切换/ }).first();
    const before = await page.locator("html").getAttribute("class");
    await toggle.click();
    await expect.poll(() => page.locator("html").getAttribute("class")).not.toBe(before);
    await toggle.click();
    await expect.poll(() => page.locator("html").getAttribute("class")).toBe(before);
    const record = await layout.read();
    expectSteady(record, "navigation");
    expectSteady(record, "content");
    expectSteady(record, "title");
    expectNoUnexpectedShift(record);
  });

  test("the conversation list opens over the chat and closes back to its trigger without moving it", async ({ page, app }) => {
    await openWorkspace(page, app.origin);
    await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
    await conversationWithMessages(page, "弹出列表", 2);
    await page.goto(`${app.origin}/chat`);
    await expect(page.locator(".chat-toolbar h3")).toHaveText("弹出列表");
    const trigger = page.getByRole("button", { name: "会话列表", exact: true });
    const layout = await watchLayout(page, { trigger, composer: ".chat-workspace textarea", transcript: "[data-testid=message-list]" });
    await trigger.click();
    await expect(page.getByRole("complementary", { name: "会话列表", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("complementary", { name: "会话列表", exact: true })).toBeHidden();
    await expect(trigger).toBeFocused();
    const record = await layout.read();
    expectSteady(record, "trigger");
    expectSteady(record, "composer");
    expectSteady(record, "transcript");
  });

  test("removing a model folds its row away and the next one eases up into its place", async ({ page, app }) => {
    await openWorkspace(page, app.origin);
    await configureOfflineModels(page);
    await page.goto(`${app.origin}/chat?settings=models`);
    const library = page.locator('section[aria-label="我的模型"]');
    const rows = library.locator("li");
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    expect(count).toBeGreaterThan(2);
    // A model no mode uses as its default, so removing it needs no other change.
    const target = rows.filter({ hasText: "google/gemini-3-flash-preview" });
    const index = await rows.evaluateAll((items, id) => items.findIndex(item => item.textContent?.includes(id as string)), "google/gemini-3-flash-preview");
    expect(index).toBeLessThan(count - 1);
    const removed = (await target.boundingBox())!;
    const layout = await watchLayout(page, { following: rows.nth(index + 1) });
    await target.getByRole("button", { name: "移除", exact: true }).click();
    await expect(rows).toHaveCount(count - 1);
    await page.waitForTimeout(300);
    const tops = (await layout.read()).frames.following.map(box => box.top);
    const steps = tops.slice(1).map((top, index) => Math.abs(top - tops[index])).filter(step => step > 0);
    expect(Math.abs(tops.at(-1)! - tops[0]), tops.join(",")).toBeGreaterThan(removed.height * 0.9);
    // With reduced motion the row takes its place in one step; otherwise it eases there.
    if (variant.reducedMotion === "reduce") expect(steps, tops.join(",")).toHaveLength(1);
    else expect(Math.max(...steps), tops.join(",")).toBeLessThan(removed.height * 0.6);
  });
});
