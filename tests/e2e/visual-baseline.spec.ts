import { test as base, expect, type Page } from "@playwright/test";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { configureOfflineModels } from "../helpers/model-fixture";
import { browserApi } from "../helpers/browser-api";

/**
 * The screenshot baseline: the main pages as the desktop app shows them, in
 * both themes and both languages. Run on demand with `npm run test:visual`
 * (compare) or `npm run test:visual:update` (record after an intended change);
 * a failure leaves expected, actual and diff images in the report.
 */
const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => { const app = await startStandaloneServer({ modelFixture: true }); try { await runTest(app); } finally { await app.close(); } },
});
test.describe.configure({ mode: "serial" });
test.use({ timezoneId: "UTC" });

async function desktopBridge(page: Page, locale: string) {
  // On the desktop the interface language is a desktop setting, read from here.
  await page.addInitScript(locale => {
    const settings = { locale, hasOpenrouterApiKey: true, hasDeepseekApiKey: false, encryptionAvailable: true, outboundProxyUrl: "", openrouterSiteName: "RiA", openrouterHttpReferer: "", closeBehaviour: "quit", globalHotkey: "Control+Shift+Space", windowBounds: null };
    Object.defineProperty(window, "riaDesktop", { value: {
      getSettings: async () => settings,
      getRuntimeInfo: async () => ({ appVersion: "0.0.0", packaged: true, dataDirectory: "C:/RiA/data", mediaDirectory: "C:/RiA/media", logFile: "C:/RiA/logs/main.log" }),
      saveSettings: async () => ({ settings, restarting: true }),
    } });
  }, locale);
}

/** The same content every run, so only a change to the interface shows up. */
async function seed(page: Page) {
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  // Created last, so chat opens on the conversation with messages.
  for (const title of ["旅行行李清单", "读书笔记：设计心理学"]) await browserApi(page, "/api/conversations", "POST", { title });
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "季度复盘提纲" })).body.data;
  const lines = ["帮我整理本季度的复盘提纲。", "## 复盘提纲\n\n1. **目标回顾**：对照季度目标逐项核对。\n2. **关键数据**：收入、留存与成本三项。\n3. **问题与改进**：每个问题对应一个负责人。\n\n> 先给结论，再展开细节。"];
  for (const [index, content] of lines.entries()) await browserApi(page, `/api/conversations/${chat.id}/messages`, "POST", { role: index ? "assistant" : "user", content, status: "success" });
  for (const title of ["复习泛型笔记", "整理周报"]) await browserApi(page, "/api/tasks", "POST", { title, priority: "medium", timeZone: "UTC", reminderEnabled: false, repeatRule: "none" });
  await browserApi(page, "/api/knowledge", "POST", { key: "回答风格", value: "先给结论，再列三点理由。" });
}

const pages: { name: string; path: string; ready: (page: Page) => Promise<void> }[] = [
  { name: "home", path: "/", ready: async page => { await expect(page.locator("main")).toBeVisible(); } },
  { name: "chat", path: "/chat", ready: async page => { await expect(page.getByText("先给结论，再展开细节。")).toBeVisible(); } },
  { name: "tasks", path: "/tasks", ready: async page => { await expect(page.getByTestId("task-item").first()).toBeVisible(); } },
  { name: "conversations", path: "/conversations", ready: async page => { await expect(page.getByRole("article").first()).toBeVisible(); } },
  { name: "knowledge", path: "/knowledge", ready: async page => { await expect(page.getByText("回答风格").first()).toBeVisible(); } },
  { name: "media", path: "/media", ready: async page => { await expect(page.locator("main")).toBeVisible(); } },
  { name: "assistants", path: "/assistants", ready: async page => { await expect(page.getByRole("article").first()).toBeVisible(); } },
  { name: "settings-keys", path: "/chat?settings=services", ready: async page => { await expect(page.getByRole("dialog")).toBeVisible(); } },
  { name: "settings-models", path: "/chat?settings=models", ready: async page => { await expect(page.getByRole("dialog")).toBeVisible(); } },
];

// A roomy window and one close to the desktop app's minimum width (900px).
const windows = [{ width: 1280, height: 800 }, { width: 960, height: 720 }] as const;
for (const size of windows) for (const locale of ["zh-CN", "en-US"] as const) {
  for (const theme of ["dark", "light"] as const) {
    test(`main pages at ${size.width}px in ${locale} ${theme} @visual`, async ({ page, app }) => {
      test.setTimeout(180_000);
      await page.setViewportSize(size);
      await desktopBridge(page, locale);
      await page.addInitScript(([locale, theme]) => { localStorage.setItem("ui:locale", locale); localStorage.setItem("ui:theme", theme); }, [locale, theme] as const);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await openWorkspace(page, app.origin);
      await seed(page);
      for (const entry of pages) {
        await page.goto(`${app.origin}${entry.path}`);
        await entry.ready(page);
        await page.waitForFunction(() => document.fonts.status === "loaded");
        await page.waitForTimeout(300);
        await expect(page).toHaveScreenshot(`${entry.name}-${size.width}-${locale}-${theme}.png`, {
          // Times and dates move with the clock, not with the interface.
          mask: [page.locator("time"), page.locator(".conversation-metadata"), page.locator(".col-meta"), page.locator("[data-relative-time]")],
        });
      }
    });
  }
}
