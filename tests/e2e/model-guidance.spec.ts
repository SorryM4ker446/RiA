import { test as base, expect } from "@playwright/test";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { configureOfflineModels } from "../helpers/model-fixture";
import { browserApi, browserData } from "../helpers/browser-api";
import { wordDocument } from "../helpers/document-fixtures";
import { settingsDialog } from "../helpers/settings";
import { toasts } from "../helpers/toast";

// Each test starts from an empty installation with the offline model catalog.
const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => { const app = await startStandaloneServer({ modelFixture: true }); try { await runTest(app); } finally { await app.close(); } },
});
const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

test("with no model the chat says how to add one, and a model added in settings is offered without a reload", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/chat`);
  const hint = page.getByRole("status").filter({ hasText: "还没有可用的模型，添加一个就可以开始对话。" });
  await expect(hint).toBeVisible();
  const composer = page.getByPlaceholder(/输入你的问题/);
  await composer.fill("没有模型时的消息");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  // Nothing was requested, so nothing is reported as a failure.
  await expect(page.getByRole("alert").filter({ hasText: "请求失败" })).toHaveCount(0);
  await expect(composer).toHaveValue("没有模型时的消息");

  await hint.getByRole("button", { name: "添加模型", exact: true }).click();
  const dialog = settingsDialog(page);
  await expect(dialog.getByRole("tab", { name: "模型", exact: true })).toHaveAttribute("aria-selected", "true");
  const row = dialog.locator("li").filter({ hasText: "anthropic/claude-opus-4.6" });
  await row.getByRole("button", { name: "添加", exact: true }).click();
  await expect(toasts(page)).toContainText("已添加 anthropic/claude-opus-4.6，并设为默认模型。");
  expect((await browserData(page, "/api/models")).chat.model).toEqual({ providerId: "openrouter", modelId: "anthropic/claude-opus-4.6" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // The page underneath stayed mounted; it reads the new library and default.
  await expect(page.getByRole("combobox", { name: "选择模型", exact: true })).toContainText("Claude Opus Offline");
  await expect(hint).toBeHidden();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("离线回答：没有模型时的消息", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("");
  expect(errors).toEqual([]);
});

test("a send without a chosen model asks for one, and the model menu leads to adding more", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page);
  // Models are in the library, but no default is chosen for new conversations.
  const settings = await browserData(page, "/api/models");
  expect((await browserApi(page, "/api/models", "PUT", { ...settings, chat: { model: null, fallback: null } })).status).toBe(200);
  await page.goto(`${app.origin}/chat`);
  const composer = page.getByPlaceholder(/输入你的问题/);
  await composer.fill("先选模型再发");
  await expect(page.getByRole("status").filter({ hasText: "还没有可用的模型" })).toHaveCount(0);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const hint = page.getByRole("status").filter({ hasText: "先选择一个模型再发送。" });
  await expect(hint).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "请求失败" })).toHaveCount(0);

  await hint.getByRole("button", { name: "选择模型", exact: true }).click();
  await expect(page.getByRole("option", { name: "添加模型…", exact: true })).toBeVisible();
  // "No model" is what the picker says, not an entry ticked in its list.
  await expect(page.getByRole("option", { name: "选择模型", exact: true })).toHaveCount(0);
  // The menu opens over the hint, so the hint's text gives way while it is open.
  // An open menu hides the page beneath it from the accessibility tree, so the
  // hint is found by its place rather than its role here.
  await expect(page.locator(".chat-dock-notice [role=status]")).toHaveCSS("opacity", "0");
  await page.getByRole("option", { name: "Gemini Flash Offline", exact: true }).click();
  await expect(hint).toBeHidden();
  await expect(composer).toHaveValue("先选模型再发");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("离线回答：先选模型再发", { exact: true })).toBeVisible();

  const picker = page.getByRole("combobox", { name: "选择模型", exact: true });
  await picker.click();
  await page.getByRole("option", { name: "添加模型…", exact: true }).click();
  await expect(settingsDialog(page).getByRole("tab", { name: "模型", exact: true })).toHaveAttribute("aria-selected", "true");
  // The menu entry opens settings; it is never kept as the selected model.
  await page.keyboard.press("Escape");
  await expect(picker).toContainText("Gemini Flash Offline");
});

test("a send stopped by the composer explains why without calling it a failed request, in the current language", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6", image: "google/gemini-3.1-flash-image-preview" });
  await page.goto(`${app.origin}/chat`);
  await page.getByPlaceholder(/输入你的问题/).fill("请分析这个附件。");
  // setInputFiles dispatches change even on a disabled input; wait until a person could pick a file.
  const attach = page.getByLabel("选择要上传的附件", { exact: true });
  await expect(attach).toBeEnabled();
  await attach.setInputFiles({ name: "说明.docx", mimeType: docxMime, buffer: await wordDocument("附件内容。") });
  await expect(page.getByRole("list", { name: "已添加的附件", exact: true }).getByText("说明.docx", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "聊天模式", exact: true }).click();
  await page.getByRole("option", { name: "文生图模式", exact: true }).click();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const notice = page.getByRole("status").filter({ hasText: "PDF 和 Word 附件仅支持聊天模式，请移除文档或切回聊天模式。" });
  await expect(notice).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "请求失败" })).toHaveCount(0);
  await expect(page.getByPlaceholder(/描述你想生成的图片/)).toHaveValue("请分析这个附件。");

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await settingsDialog(page).getByRole("tab", { name: "应用偏好", exact: true }).click();
  await page.getByRole("combobox", { name: "界面语言", exact: true }).click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeHidden();
  const translated = page.getByRole("status").filter({ hasText: "PDF and Word attachments are supported only in chat mode. Remove documents or switch to chat." });
  await expect(translated).toBeVisible();
  // Dealing with the cause clears it: here, going back to chat mode.
  await page.getByRole("combobox", { name: "Chat mode", exact: true }).click();
  await page.getByRole("option", { name: "Chat mode", exact: true }).click();
  await expect(translated).toBeHidden();
});
