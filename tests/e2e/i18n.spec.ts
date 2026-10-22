import { test as base, expect, type Page } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { configureOfflineModels } from "../helpers/model-fixture";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer({ modelFixture: true });
    try { await runTest(app); } finally { await app.close(); }
  },
});

async function chooseEnglish(page: Page) {
  await page.getByRole("combobox", { name: "界面语言", exact: true }).click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
}

test("a Chinese system defaults to Chinese, switches without losing edits, persists, and updates other tabs", async ({ page, context, app }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/settings`);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("combobox", { name: "界面语言", exact: true })).toContainText("简体中文");
  await page.getByRole("tab", { name: "服务与模型", exact: true }).click();
  await page.getByText("连接与站点选项", { exact: false }).click();
  await page.getByLabel("OpenRouter 站点名称", { exact: true }).fill("未保存的站点名称");
  await page.getByRole("tab", { name: "应用偏好", exact: true }).click();
  await chooseEnglish(page);
  await expect(page.getByRole("tab", { name: "Application", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("link", { name: "Models & usage", exact: true }).first()).toBeVisible();
  await page.getByRole("tab", { name: "Services & models", exact: true }).click();
  await expect(page.getByLabel("OpenRouter site name", { exact: true })).toHaveValue("未保存的站点名称");
  await page.getByRole("tab", { name: "Application", exact: true }).click();

  const other = await context.newPage();
  await other.goto(`${app.origin}/`);
  await expect(other.getByRole("heading", { name: "Turn ideas into next steps.", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Interface language", exact: true })).toContainText("English");
  await page.getByRole("combobox", { name: "Interface language", exact: true }).click();
  await page.getByRole("option", { name: "简体中文", exact: true }).click();
  await expect(other.getByRole("heading", { name: "把想法，变成下一步。", exact: true })).toBeVisible();
  await other.close();
  expect(errors).toEqual([]);
});

test("English settings remain usable on desktop and mobile and failed saves keep the active language", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/settings`);
  await chooseEnglish(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await expect(page.getByRole("combobox", { name: "Interface language", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(tmpdir(), `ria-i18n-settings-${width}.png`) });
  }
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === "ui:locale") throw new Error("Storage unavailable");
      original.call(this, key, value);
    };
  });
  await page.getByRole("combobox", { name: "Interface language", exact: true }).click();
  await page.getByRole("option", { name: "简体中文", exact: true }).click();
  await expect(page.getByRole("tabpanel", { name: "Application", exact: true }).getByRole("alert")).toContainText("Could not save language. Please try again.");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Interface language", exact: true })).toContainText("English");
});

test("desktop language uses device settings instead of origin storage and saves without restarting", async ({ page, app }) => {
  await page.addInitScript(() => {
    const locale = sessionStorage.getItem("desktop-locale") === "en-US" ? "en-US" : "zh-CN";
    const settings = { locale, hasOpenrouterApiKey: false, hasDeepseekApiKey: false, hasTavilyApiKey: false, encryptionAvailable: true, outboundProxyUrl: "", openrouterSiteName: "RiA", openrouterHttpReferer: "", closeBehaviour: "quit", globalHotkey: "", windowBounds: null };
    Object.defineProperty(window, "riaDesktop", { value: {
      getSettings: async () => settings,
      getRuntimeInfo: async () => ({ appVersion: "fixture", packaged: true, dataDirectory: "fixture", mediaDirectory: "fixture", logFile: "fixture" }),
      saveSettings: async (input: { locale: string }) => {
        sessionStorage.setItem("desktop-locale", input.locale);
        sessionStorage.setItem("desktop-language-input", JSON.stringify(input));
        return { settings: { ...settings, locale: input.locale }, restarting: false };
      },
    } });
    localStorage.setItem("ui:locale", "zh-CN");
  });
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/settings`);
  await page.getByRole("tab", { name: "应用偏好", exact: true }).click();
  await chooseEnglish(page);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("desktop-language-input")!))).toEqual({ locale: "en-US" });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Desktop settings", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Application", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Interface language", exact: true })).toContainText("English");
});

test("English is applied to primary pages and built-in metadata", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/settings`);
  await chooseEnglish(page);
  for (const route of ["/", "/assistants", "/topics", "/tasks", "/conversations", "/knowledge", "/models", "/media", "/backups", "/storage", "/extensions"]) {
    await page.goto(`${app.origin}${route}`);
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    await expect(page.getByRole("main")).toBeVisible();
    if (route === "/assistants") await expect(page.getByRole("heading", { name: "Knowledge assistant", exact: true })).toBeVisible();
    if (route === "/") {
      await expect(page.getByText("Your local-first AI agent.", { exact: false })).toBeVisible();
      await expect(page.getByRole("link", { name: "Open knowledge", exact: true })).toHaveCount(0);
    }
    if (route === "/extensions") await page.locator("summary").filter({ hasText: "Built-in tools" }).click();
    if (route === "/knowledge") await expect(page.locator("#knowledge-evaluation-cases")).toHaveValue(/How can I get reimbursed for work travel/);
    // Controlled textareas retain their initial text node after their displayed
    // value changes. Check editable values separately from interface copy.
    const copy = await page.getByRole("main").evaluate(element => {
      const clone = element.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("textarea, input").forEach(node => node.remove());
      return clone.textContent;
    });
    expect(copy, route).not.toMatch(/[\u4e00-\u9fff]/);
    if (route === "/extensions") {
      await page.getByRole("tab", { name: "Plugin marketplace", exact: true }).click();
      await page.getByPlaceholder("Filter featured plugins…", { exact: true }).fill("writing");
      await expect(page.getByRole("heading", { name: "Writing & editing", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "View plugin", exact: true }).click();
      const preview = page.getByRole("dialog", { name: "Writing & editing", exact: true });
      await expect(preview).toBeVisible();
      // The actual skill instructions remain the package's original content.
      await expect(preview.locator("pre")).toContainText("先识别文本用途、读者和语气");
      await preview.getByRole("button", { name: "Close", exact: true }).last().click();
    }
  }
  expect(errors).toEqual([]);
});

test("a fresh browser follows its language and a manual choice survives reload", async ({ browser, app }) => {
  for (const locale of ["en-GB", "zh-TW", "fr-FR"]) {
    const context = await browser.newContext({ locale });
    try {
      const page = await context.newPage();
      await openWorkspace(page, app.origin);
      await page.goto(`${app.origin}/settings`);
      const expected = locale.startsWith("zh") ? "zh-CN" : "en-US";
      await expect(page.locator("html")).toHaveAttribute("lang", expected);
      expect(await page.evaluate(() => localStorage.getItem("ui:locale"))).toBeNull();
      await page.getByRole("combobox", { name: expected === "en-US" ? "Interface language" : "界面语言", exact: true }).click();
      await page.getByRole("option", { name: expected === "en-US" ? "简体中文" : "English", exact: true }).click();
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("lang", expected === "en-US" ? "zh-CN" : "en-US");
    } finally { await context.close(); }
  }
});

test("UI language never changes user messages or the model's language policy", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await page.goto(`${app.origin}/chat`);
  const englishInput = "Please explain how clouds form.";
  await page.getByPlaceholder(/输入你的问题/).fill(englishInput);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => app.providerCalls.filter(call => call.stream).length).toBe(1);
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
  await page.getByPlaceholder(/输入你的问题/).fill("保留这个草稿 Keep this draft");
  await page.goto(`${app.origin}/settings`);
  await chooseEnglish(page);
  await page.getByRole("link", { name: "Back to chat", exact: true }).click();
  await expect(page.getByPlaceholder(/Ask a question/)).toHaveValue("保留这个草稿 Keep this draft");
  await expect(page.getByText(`离线回答：${englishInput}`, { exact: true })).toBeVisible();
  const chineseInput = "请解释云是怎样形成的。";
  await page.getByPlaceholder(/Ask a question/).fill(chineseInput);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => app.providerCalls.filter(call => call.stream).length).toBe(2);
  const calls = app.providerCalls.filter(call => call.stream);
  const systems = calls.map(call => call.messages.filter(message => message.role === "system"));
  expect(systems[1]).toEqual(systems[0]);
  expect(JSON.stringify(systems[1])).toContain("language of the user's latest message");
  expect(JSON.stringify(calls[0].messages.filter(message => message.role === "user").at(-1)?.content)).toContain(englishInput);
  expect(JSON.stringify(calls[1].messages.filter(message => message.role === "user").at(-1)?.content)).toContain(chineseInput);
});
