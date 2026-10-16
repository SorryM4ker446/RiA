import { test as base, expect, type Page } from "@playwright/test";
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
    const settings = { hasOpenrouterApiKey: true, hasDeepseekApiKey: false, hasTavilyApiKey: false, encryptionAvailable: true, outboundProxyUrl: "", openrouterSiteName: "RiA", openrouterHttpReferer: "", closeBehaviour: "quit", globalHotkey: "Control+Shift+Space", windowBounds: null };
    Object.defineProperty(window, "privateAiDesktop", { value: {
      getSettings: async () => settings,
      getRuntimeInfo: async () => ({ appVersion: "0.1.2", packaged: false, dataDirectory: "fixture/data", mediaDirectory: "fixture/media", logFile: "fixture/log" }),
      saveSettings: async (input: unknown) => {
        sessionStorage.setItem("desktop-settings-input", JSON.stringify(input));
        return { settings, restarting: true };
      },
    } });
  });
}

test("default model readiness follows saved workspace preferences and survives reload", async ({ page, app }) => {
  await desktopBridge(page);
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6", image: "google/gemini-3.1-flash-image-preview" });
  const configured = await browserData(page, "/api/models");
  await browserApi(page, "/api/models", "PUT", { ...configured, chat: { ...configured.chat, model: null }, persona: { ...configured.persona, name: "保留偏好" } });
  await page.goto(`${app.origin}/settings`);
  const steps = page.getByRole("list", { name: "配置进度", exact: true }).getByRole("listitem");
  await expect(steps.nth(1)).toHaveAttribute("data-complete", "true");
  await expect(steps.nth(2)).toHaveAttribute("data-complete", "false");
  await expect(steps.nth(2)).toContainText("尚未保存全局默认模型");
  const select = page.getByRole("combobox", { name: "默认聊天模型", exact: true });
  await select.click();
  await page.getByRole("option", { name: "Claude Opus Offline · openrouter", exact: true }).click();
  // Selecting a draft alone does not claim that a saved default exists.
  await expect(steps.nth(2)).toHaveAttribute("data-complete", "false");
  await page.getByRole("button", { name: "保存默认模型", exact: true }).click();
  await expect(steps.nth(2)).toHaveAttribute("data-complete", "true");
  await expect(page.getByRole("status")).toContainText("默认聊天模型已保存");
  const saved = await browserData(page, "/api/models");
  expect(saved.chat.model).toEqual({ providerId: "openrouter", modelId: "anthropic/claude-opus-4.6" });
  expect(saved.image).toEqual(configured.image);
  expect(saved.persona.name).toBe("保留偏好");
  expect(await page.evaluate(() => sessionStorage.getItem("desktop-settings-input"))).toBeNull();
  await page.reload();
  await expect(steps.nth(2)).toHaveAttribute("data-complete", "true");

  await select.click();
  await page.getByRole("option", { name: "不设置默认模型", exact: true }).click();
  await page.route("**/api/models", route => route.request().method() === "PUT" ? route.fulfill({ status: 503, json: { error: { message: "模型偏好暂时无法保存" } } }) : route.continue());
  await page.getByRole("button", { name: "保存默认模型", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "模型配置未更新" })).toContainText("模型偏好暂时无法保存");
  await expect(steps.nth(2)).toHaveAttribute("data-complete", "true");
  expect((await browserData(page, "/api/models")).chat.model).toEqual(saved.chat.model);
  await page.unroute("**/api/models");
  await page.getByRole("button", { name: "保存默认模型", exact: true }).click();
  await expect(steps.nth(2)).toHaveAttribute("data-complete", "false");
  await page.reload();
  await expect(steps.nth(2)).toHaveAttribute("data-complete", "false");
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
  await page.getByRole("tab", { name: "应用偏好", exact: true }).click();
  await expect(page.getByRole("heading", { name: "关闭窗口时", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "服务与模型", exact: true }).click();
  await expect(key).toHaveValue("local-ui-fixture");
  await page.getByRole("checkbox", { name: "删除已保存的 OpenRouter 密钥", exact: true }).check();
  await expect(key).toBeDisabled();
  await page.getByRole("button", { name: "保存并重启本地服务", exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("desktop-settings-input")!))).toMatchObject({ clearOpenrouterApiKey: true, outboundProxyUrl: "http://127.0.0.1:7897", openrouterSiteName: "RiA", deepseekApiKey: "", tavilyApiKey: "" });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`settings-${width}.png`), fullPage: true });
  }
});

test("an unreadable model configuration reports unknown readiness while secret settings remain usable", async ({ page, app }) => {
  await desktopBridge(page);
  await openWorkspace(page, app.origin);
  await page.route("**/api/models", route => route.fulfill({ status: 503, json: { error: { message: "无法读取模型偏好" } } }));
  await page.goto(`${app.origin}/settings`);
  await expect(page.getByRole("list", { name: "配置进度", exact: true }).getByRole("listitem").nth(2)).toHaveAttribute("data-complete", "unknown");
  await expect(page.getByRole("alert").filter({ hasText: "模型配置未更新" })).toContainText("无法读取模型偏好");
  await expect(page.getByLabel("OpenRouter API Key", { exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "保存默认模型", exact: true })).toBeDisabled();
});
