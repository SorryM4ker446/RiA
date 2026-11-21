import { test as base, expect, type Page } from "@playwright/test";
import { useLightTheme } from "../helpers/theme";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { browserApi, browserData } from "../helpers/browser-api";
import { configureOfflineModels } from "../helpers/model-fixture";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer({ modelFixture: true });
    try { await runTest(app); } finally { await app.close(); }
  },
});

async function desktopBridge(page: Page) {
  await page.addInitScript(() => {
    const settings = { hasOpenrouterApiKey: true, hasDeepseekApiKey: false, encryptionAvailable: true, outboundProxyUrl: "", openrouterSiteName: "RiA", openrouterHttpReferer: "", closeBehaviour: "quit", globalHotkey: "Control+Shift+Space", windowBounds: null };
    Object.defineProperty(window, "riaDesktop", { value: {
      getSettings: async () => settings,
      getRuntimeInfo: async () => ({ appVersion: "0.1.2", packaged: false, dataDirectory: "fixture/data", mediaDirectory: "fixture/media", logFile: "fixture/log" }),
      saveSettings: async (input: unknown) => {
        sessionStorage.setItem("desktop-settings-input", JSON.stringify(input));
        return { settings, restarting: true };
      },
    } });
  });
}

test("default model readiness follows saved workspace preferences and leads to the models section", async ({ page, app }) => {
  await desktopBridge(page);
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6", image: "google/gemini-3.1-flash-image-preview" });
  const configured = await browserData(page, "/api/models");
  await browserApi(page, "/api/models", "PUT", { ...configured, chat: { ...configured.chat, model: null } });
  await page.goto(`${app.origin}/settings`);
  const steps = page.getByRole("list", { name: "配置进度", exact: true }).getByRole("listitem");
  await expect(steps.nth(1)).toHaveAttribute("data-complete", "true");
  await expect(steps.nth(2)).toHaveAttribute("data-complete", "false");
  await expect(steps.nth(2)).toContainText("尚未保存全局默认模型");
  // The default is chosen in one place: the models section, which the step leads to.
  await expect(page.getByRole("button", { name: "保存默认模型", exact: true })).toHaveCount(0);
  await steps.nth(2).getByRole("link").click();
  await expect(page.getByRole("tab", { name: "模型", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#model-preferences")).toBeInViewport();

  expect((await browserApi(page, "/api/models", "PUT", { ...configured })).status).toBe(200);
  await page.getByRole("tab", { name: "API 密钥", exact: true }).click();
  await expect(steps.nth(2)).toHaveAttribute("data-complete", "true");
  await expect(steps.nth(2)).toContainText("Claude Opus Offline");
  await page.reload();
  await expect(steps.nth(2)).toHaveAttribute("data-complete", "true");
  expect(await page.evaluate(() => sessionStorage.getItem("desktop-settings-input"))).toBeNull();
});

test("compact settings preserve unsaved fields across tabs and keep connection options reachable", async ({ page, app }, info) => {
  await desktopBridge(page);
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/settings`);
  const key = page.getByLabel("OpenRouter API Key", { exact: true });
  await expect(key).toHaveValue("");
  await key.fill("local-ui-fixture");
  const connection = page.getByText("连接与站点选项", { exact: false });
  await expect(page.getByLabel("出站代理 URL", { exact: true })).toBeHidden();
  await connection.click();
  await page.getByLabel("出站代理 URL", { exact: true }).fill("http://127.0.0.1:7897");
  const secureDns = page.getByRole("checkbox", { name: "代理虚拟地址回查", exact: true });
  await expect(secureDns).not.toBeChecked();
  await expect(secureDns).toHaveAccessibleDescription(/只解析到代理虚拟地址.*Cloudflare.*默认关闭/);
  // The box leads its row, and the explanation uses the row's width rather than a narrow label column.
  const hint = page.locator("#web-fake-ip-doh-hint");
  const [box, hintBox, rowBox] = await Promise.all([secureDns.boundingBox(), hint.boundingBox(), secureDns.locator("xpath=..").boundingBox()]);
  expect(box!.x).toBeLessThan(hintBox!.x);
  expect(hintBox!.width).toBeGreaterThan(rowBox!.width * 0.8);
  // Kept to a line or two in a wide window.
  expect(hintBox!.height).toBeLessThanOrEqual(2 * 20 + 2);
  // Operable from the keyboard.
  await secureDns.focus();
  await page.keyboard.press("Space");
  await expect(secureDns).toBeChecked();
  await page.keyboard.press("Space");
  await expect(secureDns).not.toBeChecked();
  await secureDns.check();
  await page.getByRole("tab", { name: "应用偏好", exact: true }).click();
  await expect(page.getByRole("heading", { name: "关闭窗口时", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "API 密钥", exact: true }).click();
  await expect(key).toHaveValue("local-ui-fixture");
  await expect(secureDns).toBeChecked();
  await page.getByRole("checkbox", { name: "删除已保存的 OpenRouter 密钥", exact: true }).check();
  await expect(key).toBeDisabled();
  await page.getByRole("button", { name: "保存并重启本地服务", exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("desktop-settings-input")!))).toMatchObject({ clearOpenrouterApiKey: true, outboundProxyUrl: "http://127.0.0.1:7897", webFakeIpDoh: true, openrouterSiteName: "RiA", deepseekApiKey: "" });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Narrow too, the box stays beside its title, and the explanation wraps inside the row.
    const [narrowBox, narrowHint] = await Promise.all([secureDns.boundingBox(), hint.boundingBox()]);
    expect(narrowBox!.x).toBeLessThan(narrowHint!.x);
    expect(narrowHint!.x + narrowHint!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`settings-${width}.png`), fullPage: true });
  }
});

test("an unreadable model configuration reports unknown readiness while secret settings remain usable", async ({ page, app }) => {
  await desktopBridge(page);
  await openWorkspace(page, app.origin);
  await page.route("**/api/models", route => route.fulfill({ status: 503, json: { error: { message: "无法读取模型偏好" } } }));
  await page.goto(`${app.origin}/settings`);
  await expect(page.getByRole("list", { name: "配置进度", exact: true }).getByRole("listitem").nth(2)).toHaveAttribute("data-complete", "unknown");
  await expect(page.getByLabel("OpenRouter API Key", { exact: true })).toBeEnabled();
});


for (const theme of ["dark", "light"] as const) {
  test(`settings sections remain usable in ${theme} theme`, async ({ page, app }, testInfo) => {
    await desktopBridge(page);
    await page.emulateMedia({ reducedMotion: theme === "light" ? "reduce" : "no-preference" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await openWorkspace(page, app.origin);
    if (theme === "light") await useLightTheme(page);
    await page.goto(`${app.origin}/settings`);
    await page.getByRole("tab", { name: "自动化与通知", exact: true }).click();
    // Tasks are made and kept on their own page; this tab holds the review and the reminders.
    await expect(page.getByRole("heading", { name: "定时任务", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "提醒中心", exact: true })).toBeVisible();
    const review = page.getByRole("region", { name: "本地事实回顾", exact: true });
    await expect(review.getByRole("button", { name: "查看事实回顾", exact: true })).toBeEnabled();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      for (const tab of ["API 密钥", "应用偏好", "自动化与通知", "工作区权限"]) {
        await page.getByRole("tab", { name: tab, exact: true }).click();
        await expect(page.getByRole("tab", { name: tab, exact: true })).toHaveAttribute("aria-selected", "true");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        if (theme === "light") await expect(page.getByRole("tabpanel", { name: tab, exact: true })).toHaveCSS("animation-name", "none");
        await page.locator(".workspace-content").evaluate(element => element.scrollTop = 0);
        await page.screenshot({ path: testInfo.outputPath(`settings-${theme}-${width}-${tab}.png`), fullPage: true, animations: "disabled" });
      }
    }
    expect(app.readRows("SELECT count(*) AS count FROM model_requests")[0]).toMatchObject({ count: 0 });
    expect(errors).toEqual([]);
  });
}

test("choosing to keep running in the tray only saves the choice: the window is not shown again or reloaded", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const settings = { hasOpenrouterApiKey: true, hasDeepseekApiKey: false, encryptionAvailable: true, outboundProxyUrl: "", openrouterSiteName: "RiA", openrouterHttpReferer: "", closeBehaviour: "quit", globalHotkey: "", windowBounds: null };
    const calls: string[] = [];
    (window as unknown as { bridgeCalls: string[] }).bridgeCalls = calls;
    // Showing the window again is what made it flash; it is kept here only so such a call would be seen.
    Object.defineProperty(window, "riaDesktop", { value: {
      showFromTray: async () => { calls.push("showFromTray"); return { shown: true }; },
      getSettings: async () => { calls.push("getSettings"); return settings; },
      getRuntimeInfo: async () => { calls.push("getRuntimeInfo"); return { appVersion: "0.1.22", packaged: false, dataDirectory: "fixture/data", mediaDirectory: "fixture/media", logFile: "fixture/log" }; },
      saveSettings: async (input: { closeBehaviour?: "quit" | "tray" }) => { calls.push("saveSettings"); if (input.closeBehaviour) settings.closeBehaviour = input.closeBehaviour; return { settings, restarting: false }; },
    } });
  });
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/chat?settings=application`);
  await page.evaluate(() => { (window as unknown as { sameDocument: boolean }).sameDocument = true; });
  const choice = page.getByRole("radio", { name: "继续在托盘运行", exact: true });
  await choice.click();
  await expect(choice).toBeChecked();
  const calls = await page.evaluate(() => (window as unknown as { bridgeCalls: string[] }).bridgeCalls);
  expect(calls.filter(name => name === "saveSettings")).toHaveLength(1);
  expect(calls.slice(calls.lastIndexOf("saveSettings") + 1)).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument)).toBe(true);
  expect(errors).toEqual([]);
});

test("diagnostics copy where the data, cache and log really are; the API keys page no longer lists paths", async ({ page, app }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => {
    const settings = { hasOpenrouterApiKey: true, hasDeepseekApiKey: false, encryptionAvailable: true, outboundProxyUrl: "", openrouterSiteName: "RiA", openrouterHttpReferer: "", closeBehaviour: "quit", globalHotkey: "", windowBounds: null };
    (window as unknown as { logsOpened: number }).logsOpened = 0;
    Object.defineProperty(window, "riaDesktop", { value: {
      getSettings: async () => settings,
      getRuntimeInfo: async () => ({ appVersion: "0.1.22", packaged: true, platform: "win32", dataDirectory: "E:\RiA-Data", dataMoved: true, cacheDirectory: "E:\RiA-Cache", cacheSeparate: true, logFile: "E:\RiA-Data\logs\desktop.log", notificationsSupported: true }),
      saveSettings: async () => ({ settings, restarting: false }),
      openLogsFolder: async () => { (window as unknown as { logsOpened: number }).logsOpened++; return { opened: true }; },
    } });
  });
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/chat?settings=services`);
  const dialog = page.getByRole("dialog");
  // The disclosure is titled once; its contents no longer repeat the title or list paths.
  await expect(dialog.locator("summary").filter({ hasText: "本地安全" })).toHaveCount(1);
  await expect(dialog.getByRole("heading", { name: "本地安全" })).toHaveCount(0);
  await expect(dialog).not.toContainText("媒体目录");
  await expect(dialog).not.toContainText("数据目录");
  await dialog.getByRole("tab", { name: "应用偏好", exact: true }).click();
  const section = dialog.getByRole("region", { name: "诊断" }).or(dialog.locator(".settings-section").filter({ hasText: "诊断" })).first();
  await expect(section).toBeVisible();
  await section.getByRole("button", { name: "打开日志文件夹", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { logsOpened: number }).logsOpened)).toBe(1);
  await section.getByRole("button", { name: "复制诊断信息", exact: true }).click();
  await expect(page.getByText("诊断信息已复制", { exact: true })).toBeVisible();
  // The system clipboard on Windows hands lines back with CRLF.
  const copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
  expect(copied).toBe(["RiA 0.1.22 · 安装版 · win32", "数据：E:\RiA-Data（已从默认位置移出）", "缓存：E:\RiA-Cache（单独位置）", "日志：E:\RiA-Data\logs\desktop.log"].join("\n"));
});
