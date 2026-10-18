import { test as base, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStandaloneServer } from "../helpers/standalone-server";
import { browserApi, browserData } from "../helpers/browser-api";
import { configureOfflineModels } from "../helpers/model-fixture";
import { textPdf, wordDocument } from "../helpers/document-fixtures";
import { openRecentConversations } from "../helpers/conversations";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({ app: async ({}, provide) => {
  const app = await startStandaloneServer({ modelFixture: true });
  try { await provide(app); } finally { await app.close(); }
} });
const screenshots = join(tmpdir(), "ria-chat-documents-qa");
const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8XcAAAAASUVORK5CYII=", "base64");

async function openChat(page: Page, origin: string) {
  await page.goto(`${origin}/chat`);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6", image: "google/gemini-3.1-flash-image-preview" });
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "文档附件分析" })).body.data;
  await page.goto(`${origin}/chat?conversationId=${chat.id}`);
  await expect(page.locator(".composer-input")).toBeVisible();
  return chat;
}

test("mixed chat attachments survive draft reload and restart, send document text and download originals without knowledge ingestion", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const chat = await openChat(page, app.origin);
  const input = page.getByLabel("选择要上传的附件", { exact: true });
  expect(await input.getAttribute("accept")).toContain(".docx");
  const pdf = textPdf("Attachment support hours are 09:00 to 18:00.");
  await input.setInputFiles([
    { name: "支持时间.pdf", mimeType: "application/pdf", buffer: pdf },
    { name: "发布说明.docx", mimeType: docxMime, buffer: await wordDocument("附件发布的回滚窗口为三十分钟。") },
    { name: "参考图.png", mimeType: "image/png", buffer: png },
  ]);
  const attachments = page.getByRole("list", { name: "已添加的附件", exact: true });
  await expect(attachments.getByText("支持时间.pdf", { exact: true })).toBeVisible();
  await expect(attachments.getByText("发布说明.docx", { exact: true })).toBeVisible();
  await expect(attachments.getByRole("img", { name: "参考图.png" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "正在上传并处理附件" })).toBeHidden();
  await page.locator(".composer-input").fill("分析这两个文档并比较说明。");
  await page.reload();
  await expect(page.locator(".composer-input")).toHaveValue("分析这两个文档并比较说明。");
  await expect(attachments.getByText("支持时间.pdf", { exact: true })).toBeVisible();
  expect(app.readRows('SELECT id FROM "knowledge_documents"')).toHaveLength(0);
  expect(app.readRows('SELECT id FROM "document_chunks"')).toHaveLength(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(attachments.locator(".chat-document-attachment").first()).toHaveCSS("animation-name", "dialog-panel-in");
  await page.setViewportSize({ width: 390, height: 844 });
  await mkdir(screenshots, { recursive: true });
  await page.getByRole("button", { name: "发送", exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(screenshots, "mobile-draft-dark.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const download = page.getByRole("link", { name: "下载附件 支持时间.pdf", exact: true });
  await expect(download).toBeVisible();
  await expect.poll(() => app.providerCalls.filter(call => call.stream).length).toBe(1);
  const call = JSON.stringify(app.providerCalls.find(call => call.stream)!.messages);
  expect(call).toContain("Attachment support hours are 09:00 to 18:00.");
  expect(call).toContain("附件发布的回滚窗口为三十分钟。");
  expect(call).toContain("image_url"); expect(call).not.toContain("/api/media/");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeHidden();
  await download.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(screenshots, "desktop-attachments-dark.png"), animations: "disabled" });
  const history = await browserData(page, `/api/conversations/${chat.id}/messages`);
  const stored = history.find(message => message.role === "user").content;
  expect(stored).toContain("支持时间.pdf"); expect(stored).not.toContain("base64");
  expect(stored).not.toContain("09:00");
  const href = await download.getAttribute("href");
  const file = await page.request.get(`${app.origin}${href}`);
  expect(file.headers()["content-type"]).toBe("application/pdf");
  expect(file.headers()["content-disposition"]).toContain("attachment;");
  expect(await file.body()).toEqual(pdf);
  expect(app.readRows('SELECT id FROM "knowledge_documents"')).toHaveLength(0);
  await app.restart(); await page.reload();
  await expect(download).toBeVisible();
  await page.locator(".composer-input").fill("继续分析之前附件中的回滚窗口。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => app.providerCalls.filter(call => call.stream).length).toBe(2);
  expect(JSON.stringify(app.providerCalls.filter(call => call.stream).at(-1)!.messages)).toContain("附件发布的回滚窗口为三十分钟。");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeHidden();
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".chat-document-attachment").first()).toHaveCSS("animation-name", "none");
  await page.screenshot({ path: join(screenshots, "desktop-history-light.png"), animations: "disabled" });
  expect(errors).toEqual([]);
});

test("parse errors preserve the draft and document attachments cannot be sent to image mode; failed chat sends can be retried", async ({ page, app }) => {
  await openChat(page, app.origin);
  const input = page.getByLabel("选择要上传的附件", { exact: true });
  const text = page.locator(".composer-input");
  await text.fill("请分析这个附件。");
  const failedParse = page.waitForResponse(response => response.url().endsWith("/api/media/upload") && response.status() === 400);
  await input.setInputFiles({ name: "损坏.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nbroken") });
  await failedParse;
  await expect(text).toHaveValue("请分析这个附件。");
  expect(app.readRows('SELECT id FROM "media_assets"')).toHaveLength(0);
  await expect(input).toBeEnabled();
  await input.setInputFiles({ name: "有效.docx", mimeType: docxMime, buffer: await wordDocument("上传失败重试后也保留的内容。") });
  const attached = page.getByRole("list", { name: "已添加的附件", exact: true });
  await expect(attached.getByText("有效.docx", { exact: true })).toBeVisible();
  const mode = page.getByRole("combobox", { name: "聊天模式", exact: true });
  await mode.click(); await page.getByRole("option", { name: "文生图模式", exact: true }).click();
  expect(await input.getAttribute("accept")).not.toContain("application/pdf");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("PDF 和 Word 附件仅支持聊天模式，请移除文档或切回聊天模式。", { exact: true })).toBeVisible();
  await expect(text).toHaveValue("请分析这个附件。");
  await mode.click(); await page.getByRole("option", { name: "聊天模式", exact: true }).click();
  await page.route("**/api/chat", route => route.fulfill({ status: 503, json: { error: { code: "SERVICE_UNAVAILABLE", message: "Synthetic send unavailable" } } }), { times: 1 });
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(text).toHaveValue("请分析这个附件。");
  await expect(attached.getByText("有效.docx", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => app.providerCalls.filter(call => call.stream).length).toBe(1);
  expect(JSON.stringify(app.providerCalls.find(call => call.stream)!.messages)).toContain("上传失败重试后也保留的内容。");
  await expect(attached).toBeHidden();
  expect(app.readRows('SELECT id FROM "knowledge_documents"')).toHaveLength(0);
});

test("a late failed document send preserves another conversation's attachments and the originating draft", async ({ page, app }) => {
  await openChat(page, app.origin);
  const second = (await browserApi(page, "/api/conversations", "POST", { title: "另一个附件会话" })).body.data;
  await page.reload();
  const input = page.getByLabel("选择要上传的附件", { exact: true });
  const text = page.locator(".composer-input");
  await input.setInputFiles({ name: "原会话.pdf", mimeType: "application/pdf", buffer: textPdf("Origin attachment only.") });
  await expect(page.getByRole("list", { name: "已添加的附件" }).getByText("原会话.pdf", { exact: true })).toBeVisible();
  await text.fill("分析原会话附件。");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  await page.route("**/api/chat", async route => {
    entered(); await gate;
    await route.fulfill({ status: 503, json: { error: { code: "SERVICE_UNAVAILABLE", message: "Late origin failure" } } });
  }, { times: 1 });
  try {
    await page.getByRole("button", { name: "发送", exact: true }).click(); await started;
    await openRecentConversations(page);
    await page.getByRole("button", { name: /^另一个附件会话/ }).click();
    await expect(text).toHaveValue("");
    await input.setInputFiles({ name: "新会话.docx", mimeType: docxMime, buffer: await wordDocument("Only the second conversation owns this document.") });
    await expect(page.getByRole("list", { name: "已添加的附件" }).getByText("新会话.docx", { exact: true })).toBeVisible();
    await text.fill("分析新会话附件。");
    const response = page.waitForResponse(result => result.url().endsWith("/api/chat") && result.status() === 503);
    release(); await response;
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => app.providerCalls.filter(call => call.stream).length).toBe(1);
    const sent = JSON.stringify(app.providerCalls.find(call => call.stream)!.messages);
    expect(sent).toContain("Only the second conversation owns this document.");
    expect(sent).not.toContain("Origin attachment only.");
    await expect(page.getByRole("button", { name: "停止", exact: true })).toBeHidden();
    const rows = await browserData(page, `/api/conversations/${second.id}/messages`);
    expect(rows.filter(row => row.role === "user")).toHaveLength(1);
    await openRecentConversations(page);
    await page.getByRole("button", { name: /^文档附件分析/ }).click();
    await expect(text).toHaveValue("分析原会话附件。");
    await expect(page.getByRole("list", { name: "已添加的附件" }).getByText("原会话.pdf", { exact: true })).toBeVisible();
  } finally { release(); }
});
